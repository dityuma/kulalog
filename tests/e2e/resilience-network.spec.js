// @ts-check
// Network resilience of Kulalog: an unreachable or stalled CDN (Chart.js, Google Fonts) on the first visit must not
// stop the app from rendering, from working or from becoming available offline; Chart.js arriving late draws the
// chart by itself; and an update applied in one tab is offered in the other open tabs.
const { test, expect } = require("@playwright/test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { openApp, waitForServiceWorker, addTortoise, seed, expectToast, pageToday } = require("./helpers");

const ROOT = path.resolve(__dirname, "..", "..");
const SW_SRC = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
const CHART_JS = /const CHART_JS = "([^"]+)";/.exec(SW_SRC)[1];
const FONTS_CSS = /const FONTS_CSS = "([^"]+)";/.exec(SW_SRC)[1];
const CDN_HOSTS = ["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];
const isCdn = (/** @type {URL} */ u) => CDN_HOSTS.includes(u.hostname);
const NEEDS_INTERNET = "The chart needs an internet connection the first time it loads.";
const UPDATE_TEXT = "A new version of Kulalog is ready.";

/* ---------- Helpers local to this file ---------- */

// Tests that read "today" and then check records for that date would break if the date changed halfway.
// When the page's clock (Asia/Jakarta) is less than 90 s from midnight, wait until the new day has begun.
async function steerClearOfMidnight(page){
  const ms = await page.evaluate(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).getTime() - n.getTime(); });
  if(ms > 90_000) return;
  test.info().setTimeout(test.info().timeout + ms + 2_000);
  await page.waitForTimeout(ms + 1_000);
}

async function addCare(page, notes){
  await page.locator("#addC").click();
  const dlg = page.locator("#cDlg");
  await expect(dlg).toBeVisible();
  await dlg.locator("[name=soaked]").check();
  await dlg.locator("[name=notes]").fill(notes);
  await dlg.getByRole("button", { name: "Save care" }).click();
  await expect(dlg).toBeHidden();
  await expectToast(page, "Care saved");
}

async function addMeasurement(page, { weight, date, notes }){
  await page.locator("#addM").click();
  const dlg = page.locator("#mDlg");
  await expect(dlg).toBeVisible();
  if(date) await dlg.locator("[name=date]").fill(date);
  await dlg.locator("[name=weight]").fill(weight);
  if(notes) await dlg.locator("[name=notes]").fill(notes);
  await dlg.getByRole("button", { name: "Save measurement" }).click();
  await expect(dlg).toBeHidden();
  await expectToast(page, "Measurement saved");
}

// The growth chart is drawn by the real Chart.js with the given number of points, and the canvas has pixels.
async function expectChartDrawn(page, points){
  await expect(page.locator("#chartArea .chart-empty")).toHaveCount(0);
  await expect(page.locator("#chartArea canvas#cv")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const c = typeof Chart === "function" && Chart.getChart("cv");
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

// URLs in the app's cache (there is one cache, kulalog-<version>).
async function cachedUrls(page){
  return page.evaluate(async () => {
    const keys = (await caches.keys()).filter(k => k.startsWith("kulalog-"));
    const out = [];
    for(const k of keys) for(const r of await (await caches.open(k)).keys()) out.push(r.url);
    return out;
  });
}
const cacheKeys = page => page.evaluate(() => caches.keys());

// Empty the browser's HTTP cache (CacheStorage is kept), so only the service worker can answer offline.
async function clearHttpCache(page){
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.clearBrowserCache");
  await cdp.detach();
}

// The platform fonts Chrome really used to draw the text of the element (not just what the CSS asks for).
async function renderedFonts(page, selector){
  const cdp = await page.context().newCDPSession(page);
  try{
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    return fonts.map(f => f.familyName);
  }finally{
    await cdp.detach().catch(() => {});
  }
}

const firstContentfulPaint = page => page.evaluate(() => performance.getEntriesByName("first-contentful-paint").length);

/* ---------- Own static server (multi-tab update tests) ---------- */

const MY_PORTS = [8190, 8191, 8192, 8193, 8194];
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png"
};

// Copy the app served at baseURL (every file the service worker caches, and sw.js) into a short temp dir.
async function copyAppFrom(request){
  const sw = await (await request.get("sw.js")).text();
  const list = /const APP_FILES = \[([\s\S]*?)\];/.exec(sw);
  expect(list, "APP_FILES in sw.js").toBeTruthy();
  const files = [...new Set([...(/** @type {RegExpExecArray} */ (list))[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(f => f !== "./").concat("sw.js", "index.html"))];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "klf-"));
  for(const f of files){
    const res = await request.get(f);
    expect(res.status(), f).toBe(200);
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), await res.body());
  }
  return dir;
}

function makeGate(){
  let open = () => {};
  const promise = new Promise(r => { open = r; });
  return { promise, open };
}

// Serves dir like serve.js (no-cache). Requests are logged; a gated path waits until its gate opens.
// Listens on the first free port of 8190-8194 (other tests of this file may hold some of them).
async function startStaticServer(dir){
  const state = { hits: /** @type {string[]} */ ([]), gates: /** @type {Record<string, {promise: Promise<any>, open: Function}>} */ ({}) };
  const server = http.createServer(async (req, res) => {
    try{
      let p = decodeURIComponent(new URL(req.url || "/", "http://x").pathname);
      if(p.endsWith("/")) p += "index.html";
      const file = path.join(dir, p);
      if(!file.startsWith(dir + path.sep)){ res.writeHead(403); res.end(); return; }
      state.hits.push(p);
      if(state.gates[p]) await state.gates[p].promise;
      const data = await fs.promises.readFile(file).catch(() => null);
      if(!data){ res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(data);
    }catch(e){ try{ res.writeHead(500); res.end(); }catch(_){} }
  });
  const deadline = Date.now() + 90_000;
  for(;;){
    for(const port of MY_PORTS){
      const ok = await new Promise(resolve => {
        const onError = () => { server.off("listening", onListening); resolve(false); };
        const onListening = () => { server.off("error", onError); resolve(true); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port);
      });
      if(ok){
        const close = async () => {
          for(const g of Object.values(state.gates)) g.open();
          await new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); });
        };
        return { url: `http://localhost:${port}/`, state, close };
      }
    }
    if(Date.now() > deadline) throw new Error("no free port in 8190-8194");
    await new Promise(r => setTimeout(r, 300));
  }
}

// Counts controller changes and page loads, notes whether the page was controlled from the start, and whether the
// app has called serviceWorker.register() yet.
function swProbe(){
  window["__cc"] = 0;
  window["__controlledAtStart"] = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { window["__cc"]++; });
  const register = ServiceWorkerContainer.prototype.register;
  ServiceWorkerContainer.prototype.register = function(){ window["__registered"] = true; return register.apply(this, arguments); };
}
const probe = page => page.evaluate(() => ({
  cc: window["__cc"], controlledAtStart: window["__controlledAtStart"], marker: window["__marker"],
  controlled: !!navigator.serviceWorker.controller
}));

// Publish a new version in dir: a changed page (meta description) and the bumped service worker that ships it.
function publishUpdate(dir){
  const htmlPath = path.join(dir, "index.html"), swPath = path.join(dir, "sw.js");
  const html = fs.readFileSync(htmlPath, "utf8"), sw = fs.readFileSync(swPath, "utf8");
  const oldDesc = /** @type {RegExpExecArray} */ (/<meta name="description" content="([^"]*)">/.exec(html))[1];
  const newDesc = oldDesc + " Updated.";
  const version = /** @type {RegExpExecArray} */ (/const VERSION = "([^"]+)";/.exec(sw))[1];
  const newVersion = version + "-next";
  fs.writeFileSync(htmlPath, html.replace(`content="${oldDesc}"`, `content="${newDesc}"`));
  const changed = sw.replace(`const VERSION = "${version}";`, `const VERSION = "${newVersion}";`);
  expect(changed).not.toBe(sw);
  fs.writeFileSync(swPath, changed);
  return { oldDesc, newDesc, oldCache: "kulalog-" + version, newCache: "kulalog-" + newVersion };
}
const description = page => page.locator('meta[name="description"]');

/* ---------- (a) CDN unreachable on the first visit ---------- */

test("(a) CDN unreachable on the first visit: the app works, still installs for offline use, and caches Chart.js on a later visit", async ({ page, context }) => {
  test.setTimeout(180_000);
  const cdnRequests = [];
  await context.route(isCdn, route => { cdnRequests.push(route.request().url()); return route.abort("internetdisconnected"); });

  await openApp(page);
  await expect(page.locator(".empty h2")).toHaveText("Start your first logbook");
  expect(await page.evaluate(() => typeof Chart)).toBe("undefined");

  // The app is usable: add a tortoise, log care and two measurements.
  await addTortoise(page, { name: "Cdnless Carl" });
  await steerClearOfMidnight(page);
  const today = await pageToday(page);
  await addCare(page, "Soaked without a CDN");
  const [d1, d2] = await page.evaluate(() => [shiftDay(todayISO(), -60), shiftDay(todayISO(), -30)]);
  await addMeasurement(page, { weight: "300", date: d1 });
  await addMeasurement(page, { weight: "360", date: d2 });
  await expect(page.locator("#tab-growth")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#chartArea .chart-empty")).toHaveText(NEEDS_INTERNET);
  await expect(page.locator(".timeline .entry")).toHaveCount(2);

  // The service worker still installs and takes control, with every app file but without the CDN files.
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 30_000, message: "service worker controls the page" }).toBe(true);
  const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r && r.active && r.active.state; });
  expect(reg).toBe("activated");
  const base = new URL("./", page.url()).href;
  const urls = await cachedUrls(page);
  for(const f of ["", "index.html", "css/app.css", "js/logic.js", "js/app.js", "manifest.webmanifest", "kulalog-icons/icon.svg"]) expect(urls, f || "./").toContain(base + f);
  expect(urls).not.toContain(CHART_JS);
  expect(cdnRequests, "the service worker and the page did try the CDN").toContain(CHART_JS);

  // Offline (CDN still unreachable): the app opens from the cache with every record, and new records save.
  await clearHttpCache(page);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator(".profile h1")).toHaveText("Cdnless Carl");
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(page.locator("#chartArea .chart-empty")).toHaveText(NEEDS_INTERNET);
  await expect(page.locator(".timeline .entry")).toHaveCount(2);
  await addMeasurement(page, { weight: "410", notes: "Weighed offline" });
  await expect(page.locator(".timeline .entry")).toHaveCount(3);
  await page.locator("#tab-care").click();
  await expect(page.locator(`button.day[data-day="${today}"]`)).toContainText("Soaked without a CDN");
  await page.locator("#tab-growth").click();

  // Back online with the CDN reachable: the service worker's fetch handler keeps Chart.js and the fonts, and the chart draws.
  await context.setOffline(false);
  await context.unrouteAll({ behavior: "ignoreErrors" });
  await page.reload();
  await expect(page.locator(".profile h1")).toHaveText("Cdnless Carl");
  await expectChartDrawn(page, 3);
  await expect.poll(async () => (await cachedUrls(page)).includes(CHART_JS), { timeout: 20_000, message: "Chart.js cached" }).toBe(true);
  await expect.poll(async () => (await cachedUrls(page)).includes(FONTS_CSS), { timeout: 20_000, message: "font stylesheet cached" }).toBe(true);

  // Offline again, nothing in the HTTP cache: Chart.js comes from the service worker and the chart still draws.
  await clearHttpCache(page);
  await context.setOffline(true);
  const fromSw = new Map();
  page.on("response", r => fromSw.set(r.url(), r.fromServiceWorker()));
  await page.reload();
  await expect(page.locator(".profile h1")).toHaveText("Cdnless Carl");
  await expectChartDrawn(page, 3);
  expect(fromSw.get(CHART_JS), "Chart.js answered by the service worker").toBe(true);
  await context.setOffline(false);
});

/* ---------- (b) CDN stalled on the first visit ---------- */

test("(b) CDN stalled on the first visit: the app renders within a few seconds and is usable", async ({ page, context }) => {
  const held = [];
  await context.route(isCdn, route => { held.push(route); });   // never answered while the test runs
  try{
    const t0 = Date.now();
    await page.goto("./", { waitUntil: "commit" });
    await expect(page.locator("#app > *").first()).toBeVisible({ timeout: 15_000 });
    const elapsed = Date.now() - t0;
    test.info().annotations.push({ type: "render-ms", description: String(elapsed) });
    expect(elapsed, "ms from navigation to the rendered app").toBeLessThan(5_000);
    await expect(page.locator(".empty h2")).toHaveText("Start your first logbook");
    // The CDN files really were stalled (not served).
    expect(held.map(r => r.request().url())).toEqual(expect.arrayContaining([CHART_JS, FONTS_CSS]));
    expect(await page.evaluate(() => typeof Chart)).toBe("undefined");
    await expect.poll(() => firstContentfulPaint(page), { timeout: 5_000, message: "page painted" }).toBe(1);

    await addTortoise(page, { name: "Patient Pat" });
    await expectToast(page, "Patient Pat added");
  }finally{
    for(const r of held.splice(0)) await r.abort().catch(() => {});
    await context.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("(b2) CDN stalled on the first visit: the service worker still takes control, so the app opens offline", async ({ page, context }) => {
  // Regression: the try/catch around the CDN caching in install only helped when the CDN failed fast. A stalled CDN
  // kept the worker installing for as long as the request hung, so the first visit never became available offline.
  // The CDN caching now has a 10 s limit.
  test.setTimeout(90_000);
  const held = [];
  await context.route(isCdn, route => { held.push(route); });   // never answered while the test runs
  try{
    await page.goto("./", { waitUntil: "commit" });
    await expect(page.locator("#app > *").first()).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000, message: "service worker controls the page" }).toBe(true);
    await context.setOffline(true);
    await page.reload({ waitUntil: "commit" });
    await expect(page.locator(".empty h2")).toHaveText("Start your first logbook");
  }finally{
    await context.setOffline(false);
    for(const r of held.splice(0)) await r.abort().catch(() => {});
    await context.unrouteAll({ behavior: "ignoreErrors" });
  }
});

/* ---------- (c) and (d): no service worker, so every load goes to the (routed) network ---------- */

test.describe("without a service worker", () => {
  test.use({ serviceWorkers: "block" });

  test("(c) Chart.js arriving late: the growth chart draws by itself once it arrives", async ({ page, context }) => {
    let hold = false;
    const held = [];
    await context.route(u => u.href === CHART_JS, route => { if(hold) held.push(route); else return route.continue(); });
    try{
      await openApp(page);
      const [d1, d2] = await page.evaluate(() => [shiftDay(todayISO(), -60), shiftDay(todayISO(), -30)]);
      await page.evaluate(() => localStorage.setItem("kulalog-settings", JSON.stringify({ tab: "growth" })));
      await seed(page, {
        tortoises: [{ id: "t-late", name: "Late Lola", species: "Leopard", sex: "Female", birth: null, createdAt: 1 }],
        entries: [
          { id: "t-late-m1", kind: "measure", tortoiseId: "t-late", date: d1, createdAt: 2, plastron: 10.1, scl: 11.2, weightG: 300, photo: null, notes: "" },
          { id: "t-late-m2", kind: "measure", tortoiseId: "t-late", date: d2, createdAt: 3, plastron: 10.9, scl: 12, weightG: 360, photo: null, notes: "" }
        ]
      });
      await page.goto("./#t/t-late");
      await expect(page.locator(".profile h1")).toHaveText("Late Lola");

      // Reopen the tortoise while Chart.js is held back by the network.
      hold = true;
      await page.reload({ waitUntil: "commit" });
      await expect(page.locator(".profile h1")).toHaveText("Late Lola", { timeout: 15_000 });
      await expect(page.locator("#tab-growth")).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#chartArea .chart-empty")).toHaveText(NEEDS_INTERNET);
      await expect.poll(() => held.length, { message: "Chart.js request held" }).toBe(1);
      expect(await page.evaluate(() => typeof Chart)).toBe("undefined");

      // Chart.js arrives about 3 s late (simulated network delay): the chart is drawn without any click.
      await page.waitForTimeout(3_000);
      await held.splice(0, 1)[0].continue();
      await expectChartDrawn(page, 2);
      const ys = await page.evaluate(() => Chart.getChart("cv").data.datasets[0].data.map(p => p.y));
      expect(ys).toEqual([300, 360]);
    }finally{
      for(const r of held.splice(0)) await r.abort().catch(() => {});
      await context.unrouteAll({ behavior: "ignoreErrors" });
    }
  });

  test("(d) font stylesheet stalled: the page paints with system fonts, then the web fonts apply when it arrives", async ({ page, context }) => {
    const held = [];
    await context.route(u => u.hostname === "fonts.googleapis.com", route => { held.push(route); });
    try{
      const t0 = Date.now();
      await page.goto("./", { waitUntil: "commit" });
      await expect.poll(() => firstContentfulPaint(page), { timeout: 15_000, message: "first contentful paint" }).toBe(1);
      const elapsed = Date.now() - t0;
      test.info().annotations.push({ type: "first-paint-ms", description: String(elapsed) });
      expect(elapsed, "ms until the first paint").toBeLessThan(5_000);
      await expect(page.locator(".empty h2")).toHaveText("Start your first logbook");
      await expect(page.locator(".empty p")).toBeVisible();
      await expect.poll(() => held.length, { message: "font stylesheet request held" }).toBeGreaterThan(0);
      expect(held[0].request().url()).toBe(FONTS_CSS);

      // Text is drawn now, in a system font.
      const heading = await renderedFonts(page, ".empty h2"), body = await renderedFonts(page, ".empty p");
      expect(heading.length, "fonts used for the heading").toBeGreaterThan(0);
      expect(body.length, "fonts used for the paragraph").toBeGreaterThan(0);
      expect(heading.join()).not.toContain("Bricolage");
      expect(body.join()).not.toContain("Atkinson");

      // The stylesheet arrives: the web fonts load and are used.
      for(const r of held.splice(0)) await r.continue();
      await expect.poll(() => page.evaluate(async () => {
        await document.fonts.ready;
        const a = await document.fonts.load('16px "Atkinson Hyperlegible"');
        const b = await document.fonts.load('800 16px "Bricolage Grotesque"');
        return a.some(f => f.status === "loaded") && b.some(f => f.status === "loaded");
      }), { timeout: 20_000, message: "web fonts loaded" }).toBe(true);
      await expect.poll(async () => (await renderedFonts(page, ".empty h2")).join(), { timeout: 15_000 }).toContain("Bricolage Grotesque");
      await expect.poll(async () => (await renderedFonts(page, ".empty p")).join(), { timeout: 15_000 }).toContain("Atkinson Hyperlegible");
    }finally{
      for(const r of held.splice(0)) await r.abort().catch(() => {});
      await context.unrouteAll({ behavior: "ignoreErrors" });
    }
  });
});

/* ---------- (e) updates with several tabs open ---------- */

// Opens tabs A and B on a fresh profile before the service worker exists (sw.js is held until both pages have asked
// to register it), then lets the first install take over both. Neither tab may offer an update or reload.
async function firstInstallWithTwoTabs(context, srv){
  await context.addInitScript(swProbe);
  const a = await context.newPage(), b = await context.newPage();
  const loads = { a: 0, b: 0 };
  a.on("load", () => loads.a++);
  b.on("load", () => loads.b++);
  const gate = srv.state.gates["/sw.js"] = makeGate();
  await a.goto(srv.url);
  await expect(a.locator("#app > *").first()).toBeVisible();
  await b.goto(srv.url);
  await expect(b.locator("#app > *").first()).toBeVisible();
  for(const p of [a, b]) await expect.poll(() => p.evaluate(() => !!window["__registered"])).toBe(true);
  await expect.poll(() => srv.state.hits.includes("/sw.js")).toBe(true);
  await a.evaluate(() => { window["__marker"] = "a"; });
  await b.evaluate(() => { window["__marker"] = "b"; });
  gate.open();
  delete srv.state.gates["/sw.js"];

  for(const p of [a, b]) await waitForServiceWorker(p);
  expect(await probe(a)).toEqual({ cc: 1, controlledAtStart: false, marker: "a", controlled: true });
  expect(await probe(b)).toEqual({ cc: 1, controlledAtStart: false, marker: "b", controlled: true });
  await expect(a.locator("#updateBar")).toBeHidden();
  await expect(b.locator("#updateBar")).toBeHidden();
  expect(loads).toEqual({ a: 1, b: 1 });
  expect(await cacheKeys(a)).toHaveLength(1);
  return { a, b, loads };
}

// A new version is published; tab A finds it and the user taps Reload there. A reloads onto the new version.
async function updateFromTabA(a, dir){
  const upd = publishUpdate(dir);
  expect(await cacheKeys(a)).toEqual([upd.oldCache]);
  await a.evaluate(async () => { const reg = await navigator.serviceWorker.getRegistration(); await reg.update(); });
  await expect(a.locator("#updateBar")).toBeVisible({ timeout: 30_000 });
  const reloaded = a.waitForEvent("load");
  await a.locator("#updateBtn").click();
  await reloaded;
  await expect(description(a)).toHaveAttribute("content", upd.newDesc);
  await expect(a.locator("#updateBar")).toBeHidden();
  return upd;
}

// Tab B still shows the old page after its controller changed: Reload is offered and B has not reloaded by itself.
async function expectOldPageOffersReload(b, loadsBefore, loads, cc, upd){
  await expect.poll(async () => (await probe(b)).cc, { timeout: 15_000, message: "tab B's controller changed" }).toBe(cc);
  await expect(b.locator("#updateBar")).toBeVisible();
  await expect(b.locator("#updateBar")).toContainText(UPDATE_TEXT);
  await expect(b.locator("#updateBtn")).toHaveText("Reload");
  expect((await probe(b)).marker, "tab B did not reload by itself").toBe("b");
  expect(loads.b).toBe(loadsBefore);
  await expect(description(b)).toHaveAttribute("content", upd.oldDesc);
}

// Tapping Reload in tab B reloads it once, onto the new version and the new cache.
async function expectReloadBringsNewVersion(b, loadsBefore, loads, upd){
  const reloaded = b.waitForEvent("load", { timeout: 10_000 });
  await b.locator("#updateBtn").click();
  await reloaded;
  expect(loads.b).toBe(loadsBefore + 1);
  await expect(description(b)).toHaveAttribute("content", upd.newDesc);
  await expect(b.locator("#updateBar")).toBeHidden();
  expect((await probe(b)).controlled).toBe(true);
  await expect.poll(() => cacheKeys(b)).toEqual([upd.newCache]);
}

test.describe("several tabs", () => {
  /** @type {string[]} */
  const dirs = [];
  test.afterAll(() => {
    for(const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test("(e) first install shows no bar in either tab; an update applied in tab A is offered in tab B, whose Reload brings it to the new version", async ({ context, request }) => {
    test.setTimeout(180_000);
    const dir = await copyAppFrom(request);
    dirs.push(dir);
    const srv = await startStaticServer(dir);
    try{
      const { a, b, loads } = await firstInstallWithTwoTabs(context, srv);

      // Later the user reopens tab B: it now runs under the service worker from the start.
      await b.reload();
      await expect(b.locator("#app > *").first()).toBeVisible();
      await b.evaluate(() => { window["__marker"] = "b"; });
      expect(await probe(b)).toEqual({ cc: 0, controlledAtStart: true, marker: "b", controlled: true });
      await expect(b.locator("#updateBar")).toBeHidden();

      const upd = await updateFromTabA(a, dir);
      await expectOldPageOffersReload(b, 2, loads, 1, upd);
      await expectReloadBringsNewVersion(b, 2, loads, upd);
    }finally{
      await srv.close();
    }
  });

  test("(e3) a tab that was open during the first install: its Reload works after another tab applied an update", async ({ context, request }) => {
    // Regression: registerSW() decided "another tab applied an update" from the controller at page load only. Tab B,
    // opened before the first install, kept offer()'s handler, which posted "skipWaiting" to a worker that was already
    // active, so B's Reload did nothing. Every controller change after the first claim now counts as an update.
    test.setTimeout(180_000);
    const dir = await copyAppFrom(request);
    dirs.push(dir);
    const srv = await startStaticServer(dir);
    try{
      const { a, b, loads } = await firstInstallWithTwoTabs(context, srv);
      const upd = await updateFromTabA(a, dir);
      await expectOldPageOffersReload(b, 1, loads, 2, upd);
      await expectReloadBringsNewVersion(b, 1, loads, upd);
    }finally{
      await srv.close();
    }
  });
});
