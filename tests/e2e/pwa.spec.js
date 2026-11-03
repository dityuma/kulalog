// @ts-check
// PWA behaviour of Kulalog: installability, persistence across reloads and browser restarts,
// persistent storage, full offline use and the service worker update flow.
const { test, expect, chromium } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { openApp, waitForServiceWorker, addTortoise, seed, readDb, expectToast, pageToday } = require("./helpers");

const ROOT = path.resolve(__dirname, "..", "..");
const SW_SRC = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const SW_VERSION = /const VERSION = "([^"]+)";/.exec(SW_SRC)[1];
const CACHE_NAME = "kulalog-" + SW_VERSION;
const CHART_JS = /const CHART_JS = "([^"]+)";/.exec(SW_SRC)[1];
const FONTS_CSS = /const FONTS_CSS = "([^"]+)";/.exec(SW_SRC)[1];
const APP_FILES = [
  "", "index.html", "css/app.css", "js/logic.js", "js/app.js", "manifest.webmanifest",
  "kulalog-icons/icon.svg", "kulalog-icons/icon-maskable.svg", "kulalog-icons/favicon-32.png",
  "kulalog-icons/apple-touch-icon.png", "kulalog-icons/icon-any.svg", "kulalog-icons/icon-any-192.png", "kulalog-icons/icon-any-512.png",
  "kulalog-icons/icon-maskable-192.png", "kulalog-icons/icon-maskable-512.png"
];
const PERSISTENT_TEXT = "Storage is persistent: the browser won't clear your records to free up space.";
const NOT_PERSISTENT_TEXT = "The browser hasn't granted persistent storage yet";

/* ---------- Helpers local to this file ---------- */

// Ports 8140-8159: 10 per Playwright project, so both projects can run at the same time. Slots 0-1 are shifted per
// --repeat-each copy (up to 5), so repeated copies of the same test running in parallel don't fight over a port.
function portFor(testInfo, slot){
  const idx = Math.max(0, testInfo.config.projects.findIndex(p => p.name === testInfo.project.name));
  return 8140 + idx * 10 + slot + 2 * (testInfo.repeatEachIndex % 5);
}

// Options for chromium.launchPersistentContext that mirror the current Playwright project.
function launchOptions(testInfo, extra = {}){
  const u = /** @type {Record<string, any>} */ (testInfo.project.use);
  const opts = { channel: "chrome", headless: u.headless ?? true, serviceWorkers: "allow" };
  for(const k of ["viewport", "screen", "userAgent", "deviceScaleFactor", "isMobile", "hasTouch", "timezoneId", "locale", "baseURL"]){
    if(u[k] !== undefined) opts[k] = u[k];
  }
  return { ...opts, ...extra };
}

// Chrome profile for a persistent context. It lives in a short temp path on purpose: Chrome keeps the service worker
// cache several folders deep inside the profile, and under test-results/<long test name>/ that passes the Windows
// 260-character path limit, so CacheStorage fails and the worker never finishes installing.
const profileDirs = [];
function shortProfileDir(){
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kl-"));
  profileDirs.push(dir);
  return dir;
}
test.afterAll(() => {
  for(const dir of profileDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function launchPersistent(testInfo, profileDir, extra = {}){
  const ctx = await chromium.launchPersistentContext(profileDir, launchOptions(testInfo, extra));
  const page = ctx.pages()[0] || await ctx.newPage();
  return { ctx, page };
}

// Start a copy of serve.js on our own port; resolves once it is listening.
async function startServer(serveJs, port){
  const child = spawn(process.execPath, [serveJs, String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("server did not start: " + out)), 15_000);
    child.stdout.on("data", d => { out += d; if(out.includes("running at")){ clearTimeout(timer); resolve(undefined); } });
    child.stderr.on("data", d => { out += d; });
    child.on("exit", code => { clearTimeout(timer); reject(new Error(`server on ${port} exited (${code}): ${out}`)); });
  });
  return child;
}
async function stopServer(child){
  if(!child || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise(r => child.once("exit", r));
  child.kill();
  await gone;
}
// Status code, or the network error code when nothing answers.
function httpStatus(url){
  return new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", e => resolve(/** @type {any} */ (e).code || String(e)));
    req.setTimeout(3000, () => { req.destroy(); resolve("TIMEOUT"); });
  });
}

// Copy the app (and serve.js, which serves its own folder) to dir.
function copyApp(dir){
  fs.mkdirSync(dir, { recursive: true });
  for(const f of ["index.html", "sw.js", "manifest.webmanifest", "serve.js"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for(const d of ["css", "js", "kulalog-icons"]) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
}

// Width and height from a PNG's IHDR chunk.
function pngSize(buf){
  expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "PNG signature").toBe(true);
  expect(buf.subarray(12, 16).toString("latin1"), "first chunk is IHDR").toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Pixel facts about an icon, drawn in the page: transparent pixels, and how much of the artwork (pixels clearly
// different from the corner background colour) lies outside the maskable safe zone, the centred circle of radius 40%.
function iconPixels(url){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error("icon did not load: " + url));
    img.onload = () => {
      const W = img.naturalWidth || 512, H = img.naturalHeight || 512;
      const ctx = /** @type {CanvasRenderingContext2D} */ (Object.assign(document.createElement("canvas"), { width: W, height: H }).getContext("2d"));
      ctx.drawImage(img, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data;
      let transparent = 0, artwork = 0, outsideSafeZone = 0;
      for(let y = 0; y < H; y++) for(let x = 0; x < W; x++){
        const i = (y * W + x) * 4;
        if(d[i + 3] < 255) transparent++;
        if(Math.max(Math.abs(d[i] - d[0]), Math.abs(d[i + 1] - d[1]), Math.abs(d[i + 2] - d[2])) <= 48) continue;
        artwork++;
        if(Math.hypot(x + 0.5 - W / 2, y + 0.5 - H / 2) > 0.4 * Math.min(W, H)) outsideSafeZone++;
      }
      resolve({ width: W, height: H, transparent, artwork, outsideSafeZone });
    };
    img.src = url;
  });
}

// Tests that read "today" and then save or check records for that date would break if the date changed halfway.
// When the page's clock (Asia/Jakarta) is less than 90 s from midnight, wait until the new day has begun.
async function steerClearOfMidnight(page){
  const ms = await page.evaluate(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).getTime() - n.getTime(); });
  if(ms > 90_000) return;
  test.info().setTimeout(test.info().timeout + ms + 2_000);
  await page.waitForTimeout(ms + 1_000);
}

const idFromUrl = page => decodeURIComponent(new URL(page.url()).hash.replace(/^#t\//, ""));

async function addCare(page, { notes, food = "Leafy greens" }){
  await page.locator("#addC").click();
  const dlg = page.locator("#cDlg");
  await expect(dlg).toBeVisible();
  await dlg.locator("[name=soaked]").check();
  await dlg.locator("#foodChips label", { hasText: food }).click();
  await expect(dlg.locator(`#foodChips input[value="${food}"]`)).toBeChecked();
  await dlg.locator("[name=notes]").fill(notes);
  await dlg.getByRole("button", { name: "Save care" }).click();
  await expect(dlg).toBeHidden();
  await expectToast(page, "Care saved");
}

async function addMeasurement(page, { weight, plastron, scl, notes, date }){
  await page.locator("#addM").click();
  const dlg = page.locator("#mDlg");
  await expect(dlg).toBeVisible();
  if(date) await dlg.locator("[name=date]").fill(date);
  if(plastron) await dlg.locator("[name=plastron]").fill(plastron);
  if(scl) await dlg.locator("[name=scl]").fill(scl);
  if(weight) await dlg.locator("[name=weight]").fill(weight);
  if(notes) await dlg.locator("[name=notes]").fill(notes);
  await dlg.getByRole("button", { name: "Save measurement" }).click();
  await expect(dlg).toBeHidden();
  await expectToast(page, "Measurement saved");
}

// A tortoise with two weighed measurements a month apart, so the growth chart can draw a line.
async function seedChartData(page, id, name){
  const [d1, d2] = await page.evaluate(() => [shiftDay(todayISO(), -60), shiftDay(todayISO(), -30)]);
  await seed(page, {
    tortoises: [{ id, name, species: "Leopard", sex: "Male", birth: null, createdAt: 1 }],
    entries: [
      { id: id + "-m1", kind: "measure", tortoiseId: id, date: d1, createdAt: 2, plastron: 10.1, scl: 11.2, weightG: 300, photo: null, notes: "" },
      { id: id + "-m2", kind: "measure", tortoiseId: id, date: d2, createdAt: 3, plastron: 10.9, scl: 12, weightG: 360, photo: null, notes: "" }
    ]
  });
}

// Chart.js is the real library, the canvas exists and it has drawn pixels.
async function expectChartDrawn(page, points){
  await expect(page.locator("#chartArea .chart-empty")).toHaveCount(0);
  await expect(page.locator("#chartArea canvas#cv")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const cv = /** @type {HTMLCanvasElement} */ (document.querySelector("#cv"));
    const c = cv && Chart.getChart(cv);
    return c ? c.data.datasets[0].data.length : -1;
  })).toBe(points);
  await expect.poll(() => page.evaluate(() => {
    const cv = /** @type {HTMLCanvasElement} */ (document.querySelector("#cv"));
    const px = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    let painted = 0;
    for(let i = 3; i < px.length; i += 4) if(px[i]) painted++;
    return painted;
  })).toBeGreaterThan(100);
}

async function expectChartJs(page){
  await expect.poll(() => page.evaluate(() => typeof Chart)).toBe("function");
}

// The web fonts really loaded (from the cache when offline), not a system fallback.
async function expectFontsLoaded(page){
  const r = await page.evaluate(async () => {
    try{
      await document.fonts.ready;
      const body = await document.fonts.load('16px "Atkinson Hyperlegible"');
      const display = await document.fonts.load('800 16px "Bricolage Grotesque"');
      return {
        body: body.filter(f => f.status === "loaded").length,
        display: display.filter(f => f.status === "loaded").length,
        check: document.fonts.check('16px "Atkinson Hyperlegible"'),
        family: getComputedStyle(document.body).fontFamily
      };
    }catch(e){ return { error: String(e) }; }
  });
  expect(r.error, "font loading error").toBeUndefined();
  expect(r.body, "Atkinson Hyperlegible faces loaded").toBeGreaterThan(0);
  expect(r.display, "Bricolage Grotesque faces loaded").toBeGreaterThan(0);
  expect(r.check).toBe(true);
  expect(r.family).toContain("Atkinson Hyperlegible");
}

async function expectLogoLoaded(page){
  const logo = page.locator("header img.brand-mark");
  await expect(logo).toHaveAttribute("src", "kulalog-icons/icon.svg");
  await expect.poll(() => logo.evaluate(i => /** @type {HTMLImageElement} */ (i).complete ? /** @type {HTMLImageElement} */ (i).naturalWidth : 0)).toBeGreaterThan(0);
}

// Proof that there is no network: requests for files that are not cached fail, also when the service worker makes them.
async function expectNetworkDown(page){
  const r = await page.evaluate(async () => {
    const probe = async url => { try{ const res = await fetch(url, { cache: "no-store" }); return "status " + res.status; }catch(e){ return "failed"; } };
    return {
      sameOrigin: await probe("serve.js?probe=" + Date.now()),
      cdn: await probe("https://cdn.jsdelivr.net/npm/chart.js@4.4.1/package.json?probe=" + Date.now()),
      fonts: await probe("https://fonts.googleapis.com/css2?family=Roboto&probe=" + Date.now())
    };
  });
  expect(r).toEqual({ sameOrigin: "failed", cdn: "failed", fonts: "failed" });
}

// Empty the browser's HTTP cache (CacheStorage is kept). Chart.js and the font files are sent with a one-year max-age,
// so without this a service worker that doesn't serve them offline would go unnoticed: the HTTP cache would.
async function clearHttpCache(page){
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await cdp.detach();
}

// Records, per URL, whether the last response the page got was answered by the service worker's fetch handler.
function trackServiceWorkerResponses(page){
  const fromSw = new Map();
  page.on("response", r => fromSw.set(r.url(), r.fromServiceWorker()));
  return fromSw;
}
function expectServedByServiceWorker(fromSw){
  expect(fromSw.get(CHART_JS), "Chart.js answered by the service worker").toBe(true);
  expect(fromSw.get(FONTS_CSS), "font stylesheet answered by the service worker").toBe(true);
  const fonts = [...fromSw].filter(([u]) => /^https:\/\/fonts\.gstatic\.com\/.+\.woff2$/.test(u));
  expect(fonts.length, "font files requested").toBeGreaterThan(0);
  for(const [u, sw] of fonts) expect(sw, u + " answered by the service worker").toBe(true);
}

async function cacheState(page){
  return page.evaluate(async () => {
    const keys = await caches.keys();
    const out = { keys, entries: {} };
    for(const k of keys){
      const c = await caches.open(k);
      out.entries[k] = await Promise.all((await c.keys()).map(async r => {
        const res = await c.match(r);
        return { url: r.url, status: res ? res.status : 0, type: res ? res.type : "" };
      }));
    }
    return out;
  });
}

// Records navigator.storage.persist()/persisted() calls made by the page.
function persistSpy(){
  const log = { persist: 0, persisted: 0, results: [] };
  Object.defineProperty(window, "__persistLog", { value: log });
  const proto = StorageManager.prototype;
  const persist = proto.persist, persisted = proto.persisted;
  proto.persist = function(){
    log.persist++;
    return persist.apply(this, arguments).then(r => { log.results.push(r); return r; });
  };
  proto.persisted = function(){ log.persisted++; return persisted.apply(this, arguments); };
  Object.defineProperty(window, "__realPersisted", { value: () => persisted.call(navigator.storage) });
}
const persistLog = page => page.evaluate(() => JSON.parse(JSON.stringify(window["__persistLog"])));

async function expectStorageStatusMatchesBrowser(page){
  await page.locator("#openSettings").click();
  const dlg = page.locator("#sDlg");
  await expect(dlg).toBeVisible();
  const status = page.locator("#storageStatus");
  await expect(status).toBeVisible();
  await expect(status).not.toBeEmpty();
  const actual = await page.evaluate(() => window["__realPersisted"]());
  if(actual) await expect(status).toHaveText(PERSISTENT_TEXT);
  else await expect(status).toContainText(NOT_PERSISTENT_TEXT);
  await dlg.locator("[data-close]").click();
  await expect(dlg).toBeHidden();
  return actual;
}

/* ---------- I1 installable ---------- */

test.describe("I1 installable", () => {
  test("manifest, icons, favicons, header logo and an active service worker", async ({ page }) => {
    await openApp(page);
    await expect(page).toHaveTitle("Kulalog");

    // Manifest link resolves to a valid manifest.
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBeTruthy();
    const manifestUrl = new URL(/** @type {string} */ (manifestHref), page.url()).href;
    const mres = await page.request.get(manifestUrl);
    expect(mres.status()).toBe(200);
    expect(mres.headers()["content-type"]).toContain("application/manifest+json");
    const m = await mres.json();
    expect(m.name).toBe("Kulalog");
    expect(m.short_name).toBe("Kulalog");
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBeTruthy();
    expect(m.scope).toBeTruthy();
    const startUrl = new URL(m.start_url, manifestUrl).href, scopeUrl = new URL(m.scope, manifestUrl).href;
    expect(startUrl.startsWith(scopeUrl), "start_url is inside scope").toBe(true);
    expect(startUrl).toBe(new URL("./", page.url()).href);
    const start = await page.request.get(startUrl);
    expect(start.status()).toBe(200);
    expect(start.headers()["content-type"]).toContain("text/html");
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    // The launch (splash) screen uses background_color around the icon; it matches the icons' own background so the
    // icon blends in instead of sitting on a white or pale square.
    expect(m.background_color.toUpperCase()).toBe("#1E2619");
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", m.theme_color);

    // Icons: 192 and 512 for "any" and for "maskable".
    const purposes = i => (i.purpose || "any").split(/\s+/);
    const has = (size, purpose) => m.icons.some(i => i.type === "image/png" && i.sizes.split(/\s+/).includes(size) && purposes(i).includes(purpose));
    expect(has("192x192", "any"), "192 any").toBe(true);
    expect(has("512x512", "any"), "512 any").toBe(true);
    expect(has("192x192", "maskable"), "192 maskable").toBe(true);
    expect(has("512x512", "maskable"), "512 maskable").toBe(true);

    // Every icon loads with the declared type, and PNG pixel sizes match "sizes".
    for(const icon of m.icons){
      const url = new URL(icon.src, manifestUrl).href;
      const res = await page.request.get(url);
      expect(res.status(), url).toBe(200);
      expect(res.headers()["content-type"], url).toContain(icon.type);
      const body = await res.body();
      if(icon.type === "image/png"){
        const { width, height } = pngSize(body);
        expect(icon.sizes.split(/\s+/), url).toContain(`${width}x${height}`);
      }else{
        expect(icon.type).toBe("image/svg+xml");
        expect(body.toString("utf8"), url).toContain("<svg");
      }
    }

    // Maskable icons are full-bleed and keep the tortoise inside the safe zone, so Android's round and squircle masks
    // don't cut it off (only faint background detail may cross the edge). Pointing them at the "any" art fails this.
    for(const icon of m.icons.filter(i => purposes(i).includes("maskable"))){
      const url = new URL(icon.src, manifestUrl).href;
      const px = await page.evaluate(iconPixels, url);
      expect(px.transparent, url + " transparent pixels").toBe(0);
      expect(px.artwork, url + " has artwork").toBeGreaterThan(px.width * px.height * 0.05);
      expect(px.outsideSafeZone / px.artwork, url + " share of the artwork outside the safe zone").toBeLessThan(0.005);
    }

    // The "any" icons are what Android's launch screen shows on background_color. They have no background square:
    // a square's edge showed as a thin dark border on the launch screen. Their corners are see-through, the art is there.
    for(const icon of m.icons.filter(i => i.type === "image/png" && purposes(i).includes("any"))){
      const url = new URL(icon.src, manifestUrl).href;
      const corners = await page.evaluate(async src => {
        const img = new Image(); img.src = src; await img.decode();
        const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext("2d"); g.drawImage(img, 0, 0);
        const a = (x, y) => g.getImageData(x, y, 1, 1).data[3];
        const w = c.width - 1, h = c.height - 1, mid = g.getImageData(Math.round(w / 2), Math.round(h / 2), 1, 1).data[3];
        return { corners: [a(0, 0), a(w, 0), a(0, h), a(w, h)], centre: mid };
      }, url);
      expect(corners.corners, url + " corners").toEqual([0, 0, 0, 0]);
      expect(corners.centre, url + " artwork in the middle").toBe(255);
    }

    // Favicons and apple-touch-icon.
    const linkBody = async selector => {
      const href = await page.locator(selector).getAttribute("href");
      const res = await page.request.get(new URL(/** @type {string} */ (href), page.url()).href);
      expect(res.status(), selector).toBe(200);
      return { type: res.headers()["content-type"], body: await res.body() };
    };
    const fav = await linkBody('link[rel="icon"][type="image/png"][sizes="32x32"]');
    expect(fav.type).toContain("image/png");
    expect(pngSize(fav.body)).toEqual({ width: 32, height: 32 });
    const favSvg = await linkBody('link[rel="icon"][type="image/svg+xml"]');
    expect(favSvg.type).toContain("image/svg+xml");
    expect(favSvg.body.toString("utf8")).toContain("<svg");
    const apple = await linkBody('link[rel="apple-touch-icon"]');
    expect(apple.type).toContain("image/png");
    const appleSize = pngSize(apple.body);
    expect(appleSize.width).toBe(appleSize.height);
    expect(appleSize.width).toBeGreaterThanOrEqual(180);

    // Header logo is the app icon and has loaded.
    await expectLogoLoaded(page);

    // Service worker is activated and controls the page.
    await waitForServiceWorker(page);
    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { state: reg && reg.active && reg.active.state, script: navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL, scope: reg && reg.scope };
    });
    expect(sw.state).toBe("activated");
    expect(sw.script).toBe(new URL("sw.js", page.url()).href);
    expect(sw.scope).toBe(scopeUrl);
  });

  test("Chrome reports no installability or manifest errors (persistent profile)", async ({}, testInfo) => {
    const { ctx, page } = await launchPersistent(testInfo, shortProfileDir());
    try{
      await openApp(page);
      await waitForServiceWorker(page);
      const cdp = await ctx.newCDPSession(page);
      await expect.poll(async () => (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors, { timeout: 20_000 }).toEqual([]);
      const man = await cdp.send("Page.getAppManifest");
      expect(man.errors).toEqual([]);
      expect(man.url).toBe(new URL("manifest.webmanifest", page.url()).href);
      expect(JSON.parse(man.data).name).toBe("Kulalog");
    }finally{
      await ctx.close();
    }
  });
});

/* ---------- I2 reload ---------- */

test("I2 tortoise, care and measurement survive a reload", async ({ page }) => {
  await openApp(page);
  await addTortoise(page, { name: "Reloady", sex: "Female" });
  const id = idFromUrl(page);
  await steerClearOfMidnight(page);
  const today = await pageToday(page);
  await addCare(page, { notes: "Ate well after the soak" });
  await addMeasurement(page, { plastron: "12.5", scl: "14.2", weight: "450", notes: "First weigh-in" });

  await page.reload();
  await expect(page.locator(".profile h1")).toHaveText("Reloady");
  await expect(page.locator(".profile")).toContainText("Female");
  // The measurement (Growth tab is remembered after logging one).
  await expect(page.locator("#tab-growth")).toHaveAttribute("aria-selected", "true");
  const entry = page.locator(".timeline .entry");
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText("Weight 450 g");
  await expect(entry).toContainText("Plastron 12.5 cm");
  await expect(entry).toContainText("Carapace 14.2 cm");
  await expect(entry).toContainText("First weigh-in");
  // The care record.
  await page.locator("#tab-care").click();
  const day = page.locator(`button.day[data-day="${today}"]`);
  await expect(day).toContainText("Soaked");
  await expect(day).toContainText("Leafy greens");
  await expect(day).toContainText("Ate well after the soak");
  // Home list.
  await page.locator("#backBtn").click();
  const card = page.locator(`.t-card[data-open="${id}"]`);
  await expect(card).toContainText("Reloady");
  await expect(card).toContainText("Last soaked today");
  await expect(card).toContainText("450 g");

  const db = await readDb(page);
  expect(db.tortoises).toEqual([expect.objectContaining({ id, name: "Reloady", sex: "Female" })]);
  expect(db.entries).toHaveLength(2);
  expect(db.entries).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "care", tortoiseId: id, date: today, soaked: true, food: ["Leafy greens"], notes: "Ate well after the soak" }),
    expect.objectContaining({ kind: "measure", tortoiseId: id, date: today, weightG: 450, plastron: 12.5, scl: 14.2, notes: "First weigh-in" })
  ]));
});

/* ---------- I3 browser restart ---------- */

test("I3 data and the service worker survive a browser restart", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const profile = shortProfileDir();
  let id, today;

  let { ctx, page } = await launchPersistent(testInfo, profile);
  try{
    await openApp(page);
    await waitForServiceWorker(page);
    await addTortoise(page, { name: "Restarty", species: "Radiated" });
    id = idFromUrl(page);
    await steerClearOfMidnight(page);
    today = await pageToday(page);
    await addCare(page, { notes: "Before the restart" });
    await addMeasurement(page, { weight: "1250", plastron: "20.5", notes: "Big one" });
    const db = await readDb(page);
    expect(db.entries).toHaveLength(2);
  }finally{
    await ctx.close();
  }

  ({ ctx, page } = await launchPersistent(testInfo, profile));
  try{
    // Was this page load handled by the service worker from the very start?
    await page.addInitScript(() => { window["__controlledAtStart"] = !!navigator.serviceWorker.controller; });
    await page.goto("./#t/" + id);
    await expect(page.locator(".profile h1")).toHaveText("Restarty");
    await expect(page.locator(".profile")).toContainText("Radiated");
    expect(await page.evaluate(() => window["__controlledAtStart"])).toBe(true);
    const sw = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { state: reg && reg.active && reg.active.state, keys: await caches.keys() };
    });
    expect(sw.state).toBe("activated");
    expect(sw.keys).toContain(CACHE_NAME);

    // Growth tab was the last one used (settings in localStorage survive too).
    await expect(page.locator("#tab-growth")).toHaveAttribute("aria-selected", "true");
    const entry = page.locator(".timeline .entry");
    await expect(entry).toHaveCount(1);
    await expect(entry).toContainText("Weight 1.25 kg");
    await expect(entry).toContainText("Plastron 20.5 cm");
    await expect(entry).toContainText("Big one");
    await page.locator("#tab-care").click();
    const day = page.locator(`button.day[data-day="${today}"]`);
    await expect(day).toContainText("Soaked");
    await expect(day).toContainText("Before the restart");

    const db = await readDb(page);
    expect(db.tortoises).toEqual([expect.objectContaining({ id, name: "Restarty", species: "Radiated" })]);
    expect(db.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "care", tortoiseId: id, date: today, soaked: true, notes: "Before the restart" }),
      expect.objectContaining({ kind: "measure", tortoiseId: id, weightG: 1250, plastron: 20.5, notes: "Big one" })
    ]));
    expect(db.entries).toHaveLength(2);
  }finally{
    await ctx.close();
  }
});

/* ---------- I4 persistent storage ---------- */

test.describe("I4 persistent storage", () => {
  test("persist() is not requested on an empty first visit, is requested once a tortoise exists; Settings tells the truth", async ({ page }) => {
    await page.addInitScript(persistSpy);
    await openApp(page);
    await expect(page.locator(".empty h2")).toHaveText("Start your first logbook");
    // Boot has finished (it registers the service worker after asking for storage).
    await page.evaluate(() => navigator.serviceWorker.ready);
    expect((await persistLog(page)).persist, "persist() on an empty first visit").toBe(0);

    const before = await expectStorageStatusMatchesBrowser(page);
    expect(before, "fresh profile: storage not persistent yet").toBe(false);
    expect((await persistLog(page)).persist, "opening Settings does not request persistence").toBe(0);

    await addTortoise(page, { name: "Persisty" });
    await expect.poll(async () => (await persistLog(page)).persist).toBe(1);
    await expect.poll(async () => (await persistLog(page)).results.length).toBe(1);
    const granted = (await persistLog(page)).results[0];
    const after = await expectStorageStatusMatchesBrowser(page);
    expect(after).toBe(granted);

    // Every later visit asks again while the browser has not granted it.
    await page.reload();
    await expect(page.locator(".profile h1")).toHaveText("Persisty");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(async () => (await persistLog(page)).persisted).toBeGreaterThan(0);
    await expect.poll(async () => (await persistLog(page)).persist).toBe(granted ? 0 : 1);
    await expectStorageStatusMatchesBrowser(page);
  });

  test("when the browser grants persistent storage, Settings switches to the persistent message", async ({ page, browser, context }) => {
    await page.addInitScript(persistSpy);
    await openApp(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    expect(await expectStorageStatusMatchesBrowser(page), "fresh profile: not persistent yet").toBe(false);

    // Chrome grants it (as it does for an installed app). Chrome then reports persisted() = true straight away.
    const pageCdp = await context.newCDPSession(page);
    const { targetInfo } = await pageCdp.send("Target.getTargetInfo");
    const browserCdp = await browser.newBrowserCDPSession();
    await browserCdp.send("Browser.setPermission", {
      permission: { name: "persistent-storage" }, setting: "granted", origin: new URL(page.url()).origin, browserContextId: targetInfo.browserContextId
    });
    await expect.poll(() => page.evaluate(() => window["__realPersisted"]())).toBe(true);

    // Settings reflects it without a reload.
    await page.locator("#openSettings").click();
    await expect(page.locator("#storageStatus")).toHaveText(PERSISTENT_TEXT);
    await page.locator("#sDlg [data-close]").click();

    // Adding a tortoise checks persisted() and, already persistent, doesn't ask again.
    await addTortoise(page, { name: "Granted" });
    await expect.poll(async () => (await persistLog(page)).persisted).toBeGreaterThan(0);
    expect((await persistLog(page)).persist).toBe(0);
    expect(await expectStorageStatusMatchesBrowser(page)).toBe(true);

    // Same on the next visit.
    await page.reload();
    await expect(page.locator(".profile h1")).toHaveText("Granted");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(async () => (await persistLog(page)).persisted).toBeGreaterThan(0);
    expect((await persistLog(page)).persist).toBe(0);
  });
});

/* ---------- E6 offline ---------- */

test.describe("E6 offline", () => {
  test("(a) after the first visit everything is cached; offline the app, chart, fonts and logo work and new records save", async ({ page, context }) => {
    test.setTimeout(120_000);
    await openApp(page);
    await waitForServiceWorker(page);

    // The page uses exactly the CDN URLs the service worker caches.
    await expect(page.locator(`script[src="${CHART_JS}"]`)).toHaveCount(1);
    await expect(page.locator(`link[rel="stylesheet"][href="${FONTS_CSS}"]`)).toHaveCount(1);

    const base = new URL("./", page.url()).href;
    await expect.poll(async () => (await cacheState(page)).keys).toEqual([CACHE_NAME]);
    const cached = (await cacheState(page)).entries[CACHE_NAME];
    const urls = cached.map(e => e.url);
    for(const f of APP_FILES) expect(urls, f || "./").toContain(base + f);
    expect(urls).toContain(CHART_JS);
    expect(urls).toContain(FONTS_CSS);
    const woff2 = urls.filter(u => /^https:\/\/fonts\.gstatic\.com\/.+\.woff2$/.test(u));
    expect(woff2.length, "font files cached").toBeGreaterThan(0);
    for(const e of cached) expect(e.status, e.url).toBe(200);

    await seedChartData(page, "t-offline", "Offline Ollie");

    // Fully offline (page and service worker), and nothing left in the HTTP cache to fall back on.
    await clearHttpCache(page);
    await context.setOffline(true);
    const fromSw = trackServiceWorkerResponses(page);
    await page.reload();
    await expect(page).toHaveTitle("Kulalog");
    await expect(page.locator(`.t-card[data-open="t-offline"]`)).toContainText("Offline Ollie");
    await expectNetworkDown(page);
    await expectChartJs(page);
    await expectFontsLoaded(page);
    await expectLogoLoaded(page);
    expectServedByServiceWorker(fromSw);

    // A shared or bookmarked link with a query string opens offline too: the app shell is served for any query.
    await page.goto("./?utm_source=share#t/t-offline");
    await expect(page.locator(".profile h1")).toHaveText("Offline Ollie");
    await expectChartJs(page);

    // Deep link loads offline too.
    await page.goto("./#t/t-offline");
    await page.reload();
    await expect(page.locator(".profile h1")).toHaveText("Offline Ollie");
    await page.locator("#tab-growth").click();
    await expectChartDrawn(page, 2);

    await steerClearOfMidnight(page);
    const today = await pageToday(page);
    await addCare(page, { notes: "Logged offline" });
    await expect(page.locator(`button.day[data-day="${today}"]`)).toContainText("Logged offline");
    await addMeasurement(page, { weight: "410", notes: "Offline weigh-in" });
    await expectChartDrawn(page, 3);
    await expect(page.locator(".timeline .entry")).toHaveCount(3);
    let db = await readDb(page);
    expect(db.entries).toHaveLength(4);

    // Back online: nothing was lost.
    await context.setOffline(false);
    await page.reload();
    await expect(page.locator(".profile h1")).toHaveText("Offline Ollie");
    await expect(page.locator(".timeline .entry")).toHaveCount(3);
    await expect(page.locator(".timeline .entry").first()).toContainText("Offline weigh-in");
    await page.locator("#tab-care").click();
    await expect(page.locator(`button.day[data-day="${today}"]`)).toContainText("Logged offline");
    db = await readDb(page);
    expect(db.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "care", tortoiseId: "t-offline", date: today, soaked: true, notes: "Logged offline" }),
      expect.objectContaining({ kind: "measure", tortoiseId: "t-offline", date: today, weightG: 410, notes: "Offline weigh-in" })
    ]));
    expect(db.entries).toHaveLength(4);
  });

  test("(b) server stopped and no host resolves: the app still fully works after a browser restart", async ({}, testInfo) => {
    test.setTimeout(150_000);
    const port = portFor(testInfo, 0);
    const origin = `http://localhost:${port}/`;
    const profile = shortProfileDir();
    let server = await startServer(path.join(ROOT, "serve.js"), port);
    let today;
    try{
      const { ctx, page } = await launchPersistent(testInfo, profile, { baseURL: origin });
      try{
        await openApp(page);
        await waitForServiceWorker(page);
        await seedChartData(page, "t-dead", "Server Gone");
        await page.goto("./#t/t-dead");
        await expect(page.locator(".profile h1")).toHaveText("Server Gone");
        await steerClearOfMidnight(page);
        today = await pageToday(page);
        await addCare(page, { notes: "Before the server died" });
        await clearHttpCache(page);
      }finally{
        await ctx.close();
      }
    }finally{
      await stopServer(server);
    }
    expect(await httpStatus(origin), "our server is gone").toBe("ECONNREFUSED");

    // Restart the browser with every host name unresolvable (CDN and Google Fonts included).
    const { ctx, page } = await launchPersistent(testInfo, profile, { baseURL: origin, args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
    try{
      const fromSw = trackServiceWorkerResponses(page);
      await page.goto("./#t/t-dead");
      await expect(page).toHaveTitle("Kulalog");
      await expect(page.locator(".profile h1")).toHaveText("Server Gone");
      await expectNetworkDown(page);
      await expectChartJs(page);
      await expectFontsLoaded(page);
      await expectLogoLoaded(page);
      expectServedByServiceWorker(fromSw);
      await expect(page.locator(`button.day[data-day="${today}"]`)).toContainText("Before the server died");

      await page.locator("#tab-growth").click();
      await expectChartDrawn(page, 2);
      await addMeasurement(page, { weight: "390", plastron: "11.3", notes: "No server" });
      await expectChartDrawn(page, 3);

      await page.reload();
      await expect(page.locator(".profile h1")).toHaveText("Server Gone");
      await expect(page.locator(".timeline .entry")).toHaveCount(3);
      await expect(page.locator(".timeline .entry").first()).toContainText("No server");
      const db = await readDb(page);
      expect(db.tortoises).toEqual([expect.objectContaining({ id: "t-dead", name: "Server Gone" })]);
      expect(db.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "care", tortoiseId: "t-dead", date: today, notes: "Before the server died" }),
        expect.objectContaining({ kind: "measure", tortoiseId: "t-dead", weightG: 390, plastron: 11.3, notes: "No server" })
      ]));
      expect(db.entries).toHaveLength(4);
    }finally{
      await ctx.close();
    }
  });
});

/* ---------- I5 update flow ---------- */

test("I5 first install doesn't reload; an update found during a visit waits for Reload, one left waiting is applied on the next open; the manifest stays current", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const dir = testInfo.outputPath("app");
  copyApp(dir);
  const port = portFor(testInfo, 1);
  const url = `http://localhost:${port}/`;
  const server = await startServer(path.join(dir, "serve.js"), port);
  try{
    let loads = 0;
    page.on("load", () => loads++);
    await page.goto(url);
    await expect(page.locator("#app > *").first()).toBeVisible();
    await page.evaluate(() => { window["__marker"] = 1; });

    // First install takes control without reloading and without offering an update.
    await waitForServiceWorker(page);
    expect(await page.evaluate(() => window["__marker"])).toBe(1);
    expect(loads).toBe(1);
    await expect(page.locator("#updateBar")).toBeHidden();
    expect((await cacheState(page)).keys).toEqual([CACHE_NAME]);

    await addTortoise(page, { name: "Updatey" });
    const id = idFromUrl(page);

    // Publish a new version: a changed page (its meta description) and the bumped service worker that ships it.
    const desc = page.locator('meta[name="description"]');
    const htmlPath = path.join(dir, "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");
    const oldDesc = /** @type {string} */ (await desc.getAttribute("content"));
    const newDesc = oldDesc + " Updated.";
    expect(html).toContain(`content="${oldDesc}"`);
    fs.writeFileSync(htmlPath, html.replace(`content="${oldDesc}"`, `content="${newDesc}"`));
    const newVersion = SW_VERSION + "-test", newCache = "kulalog-" + newVersion;
    const swPath = path.join(dir, "sw.js");
    const src = fs.readFileSync(swPath, "utf8");
    const changed = src.replace(`const VERSION = "${SW_VERSION}";`, `const VERSION = "${newVersion}";`);
    expect(changed).not.toBe(src);
    fs.writeFileSync(swPath, changed);
    await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); });

    const bar = page.locator("#updateBar");
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect(bar).toContainText("A new version of Kulalog is ready.");
    await expect(bar.locator("#updateBtn")).toHaveText("Reload");

    // Nothing reloads by itself: the new worker waits and the old cache is still in use.
    const waiting = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { waiting: reg.waiting && reg.waiting.state, active: reg.active && reg.active.state, marker: window["__marker"] };
    });
    expect(waiting).toEqual({ waiting: "installed", active: "activated", marker: 1 });
    expect(loads).toBe(1);
    expect((await cacheState(page)).keys.sort()).toEqual([CACHE_NAME, newCache].sort());
    await expect(page.locator(".profile h1")).toHaveText("Updatey");
    await expect(desc).toHaveAttribute("content", oldDesc);

    // The user taps Reload: the page reloads once, on the new version.
    const reloaded = page.waitForEvent("load");
    await bar.locator("#updateBtn").click();
    await reloaded;
    await expect(page.locator(".profile h1")).toHaveText("Updatey");
    expect(loads).toBe(2);
    expect(await page.evaluate(() => window["__marker"])).toBeUndefined();
    await expect(desc).toHaveAttribute("content", newDesc);
    await expect(page.locator("#updateBar")).toBeHidden();
    await expect.poll(async () => (await cacheState(page)).keys).toEqual([newCache]);
    const after = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { waiting: reg.waiting, active: reg.active && reg.active.state, controlled: !!navigator.serviceWorker.controller };
    });
    expect(after).toEqual({ waiting: null, active: "activated", controlled: true });
    expect((await cacheState(page)).entries[newCache].length).toBeGreaterThan(14);
    const db = await readDb(page);
    expect(db.tortoises).toEqual([expect.objectContaining({ id, name: "Updatey" })]);

    // Regression: an update the keeper never applied with Reload stayed waiting for good, so an installed app kept its
    // old version (and kept giving Android an old manifest). An update that downloaded during an earlier visit is now
    // applied when the app is opened again, before anything is typed in.
    const desc3 = newDesc + " Again.";
    fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, "utf8").replace(`content="${newDesc}"`, `content="${desc3}"`));
    const v3 = SW_VERSION + "-test3", cache3 = "kulalog-" + v3;
    fs.writeFileSync(swPath, fs.readFileSync(swPath, "utf8").replace(`const VERSION = "${newVersion}";`, `const VERSION = "${v3}";`));
    await page.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); });
    await expect(bar).toBeVisible({ timeout: 30_000 });          // found during the visit: offered, not applied
    await expect(desc).toHaveAttribute("content", newDesc);
    const loadsBefore = loads;
    const twoLoads = new Promise(resolve => {
      let n = 0;
      const onLoad = () => { if(++n === 2){ page.off("load", onLoad); resolve(undefined); } };
      page.on("load", onLoad);
    });
    await page.reload();                                         // the keeper opens the app again without tapping Reload
    await twoLoads;                                              // ...and it reloads itself once into the new version
    await expect(desc).toHaveAttribute("content", desc3, { timeout: 30_000 });
    await expect(page.locator(".profile h1")).toHaveText("Updatey");
    expect(loads).toBe(loadsBefore + 2);                         // the reopen, plus one automatic reload into the new version
    await expect(page.locator("#updateBar")).toBeHidden();
    await expect.poll(async () => (await cacheState(page)).keys).toEqual([cache3]);

    // Regression: the worker served the manifest from its cache, so the browser kept seeing the old name, colours and
    // icons until the keeper applied an update. Online it now comes from the server (without a new worker version);
    // offline from the copy cached by the last online fetch.
    const manPath = path.join(dir, "manifest.webmanifest");
    const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
    fs.writeFileSync(manPath, JSON.stringify({ ...man, background_color: "#123456" }));
    const fetchedBg = () => page.evaluate(async () => (await (await fetch("manifest.webmanifest")).json()).background_color);
    expect(await fetchedBg()).toBe("#123456");
    await stopServer(server);
    expect(await fetchedBg()).toBe("#123456");
  }finally{
    await stopServer(server);
  }
});
