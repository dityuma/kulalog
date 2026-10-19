// Lighthouse audit of Kulalog in the INSTALLED Google Chrome.
//
//   npm run test:lighthouse            (= node tests/lighthouse/run.mjs)
//   LH_QUICK=1 npm run test:lighthouse (only the two main audits of the empty home page)
//
// What it does:
//   1. Starts its own copy of serve.js on a free port in 8160-8169 (killed on exit, also on failure).
//   2. Launches the installed Chrome (chrome-launcher auto-detects it) with --headless=new.
//   3. Runs Lighthouse twice on "/": mobile (default config, Moto G Power emulation) and desktop
//      (desktop config), categories performance, accessibility, best-practices and seo.
//      Reports go to tests/lighthouse/reports/<formfactor>.report.html/.json.
//   4. Checks installability in the same Chrome through the DevTools protocol (puppeteer-core is a
//      dependency of Lighthouse): no installability errors, manifest parses, service worker controls the page.
//   5. Seeds realistic records into that Chrome profile and audits the populated screens too
//      (home list, tortoise care week/month, growth chart) with storage reset disabled, plus
//      accessibility snapshots of every dialog and of the populated screens in dark mode.
//   6. Prints a score table and every failing audit (with the offending nodes), and exits non-zero
//      when a category is under its threshold or the app is not installable.
//
// Thresholds are deliberately NOT tuned to the current app. If a run fails, fix the app.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import lighthouse, { snapshot } from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import { computeMedianRun, filterToValidRuns } from "lighthouse/core/lib/median-run.js";
import { launch, getChromePath } from "chrome-launcher";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const REPORTS = path.join(HERE, "reports");
const SERVE_JS = path.join(ROOT, "serve.js");
const PORT_RANGE = [8160, 8169];
const QUICK = !!process.env.LH_QUICK;

const ALL_CATEGORIES = ["performance", "accessibility", "best-practices", "seo"];
const THRESHOLDS = { performance: 0.8, accessibility: 0.95, "best-practices": 0.95, seo: 0.9 };
const SHORT = { performance: "perf", accessibility: "a11y", "best-practices": "bp", seo: "seo" };
// Audits with these display modes never count as failing.
const NOT_SCORED = new Set(["informative", "notApplicable", "manual"]);

/* ---------------- process cleanup ---------------- */
let serverChild = null;
let chrome = null;
let cleanedUp = false;

function killServer(){
  if(serverChild && serverChild.exitCode === null && !serverChild.killed){
    try{ serverChild.kill(); }catch(e){}
  }
}
async function cleanup(){
  if(cleanedUp) return;
  cleanedUp = true;
  killServer();
  if(chrome){
    // chrome-launcher kills only this Chrome's own process tree (taskkill /pid <pid> /T on Windows).
    try{ await chrome.kill(); }catch(e){}
  }
}
// Last resort on any exit path: synchronous kills of the two processes this script started.
process.on("exit", () => {
  killServer();
  if(chrome && chrome.process && chrome.process.exitCode === null){ try{ chrome.process.kill(); }catch(e){} }
});
for(const sig of ["SIGINT", "SIGTERM", "SIGHUP"]){
  process.on(sig, async () => { console.error(`\nReceived ${sig}, cleaning up.`); await cleanup(); process.exit(130); });
}
process.on("unhandledRejection", async err => {
  console.error("Unhandled rejection:", err);
  await cleanup();
  process.exit(2);
});

/* ---------------- server ---------------- */
function portIsFree(port){
  return new Promise(resolve => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });
}
async function pickPort(){
  for(let p = PORT_RANGE[0]; p <= PORT_RANGE[1]; p++){
    if(await portIsFree(p)) return p;
  }
  throw new Error(`No free port in ${PORT_RANGE[0]}-${PORT_RANGE[1]}`);
}
async function startServer(){
  const port = await pickPort();
  serverChild = spawn(process.execPath, [SERVE_JS, String(port)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  serverChild.stderr.on("data", d => { stderr += d; });
  const base = `http://localhost:${port}/`;
  const deadline = Date.now() + 15_000;
  while(Date.now() < deadline){
    if(serverChild.exitCode !== null) throw new Error(`serve.js exited early (code ${serverChild.exitCode}): ${stderr}`);
    try{
      const res = await fetch(base);
      if(res.ok){
        const html = await res.text();
        if(!html.includes("<title>Kulalog</title>")) throw new Error("serve.js answered, but not with the Kulalog page");
        return { port, base };
      }
    }catch(e){
      if(/not with the Kulalog page/.test(e.message)) throw e;
    }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`serve.js did not answer on ${base} within 15 s`);
}

/* ---------------- result helpers ---------------- */
function failingAudits(lhr, catId){
  const cat = lhr.categories[catId];
  if(!cat) return [];
  return cat.auditRefs
    .map(ref => lhr.audits[ref.id])
    .filter(a => a && !NOT_SCORED.has(a.scoreDisplayMode))
    .filter(a => a.scoreDisplayMode === "error" || (a.score !== null && a.score < 1));
}

// The offending items of an audit, as short text lines (node selectors for a11y, URLs/messages otherwise).
function auditItems(audit, max = 6){
  const d = audit.details || {};
  let items = Array.isArray(d.items) ? d.items : [];
  // "list" details wrap several tables; flatten them.
  if(d.type === "list") items = items.flatMap(x => (x && Array.isArray(x.items)) ? x.items : [x]);
  const lines = [];
  for(const it of items.slice(0, max)){
    const parts = [];
    if(it.node){
      if(it.node.selector) parts.push(it.node.selector);
      if(it.node.snippet) parts.push(it.node.snippet.replace(/\s+/g, " ").slice(0, 140));
      if(it.node.explanation) parts.push("-> " + it.node.explanation.split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ").slice(0, 220));
    }
    for(const k of ["description", "source", "url", "label", "failureTitle"]){
      const v = it[k];
      if(typeof v === "string" && v) parts.push(`${k}: ${v.slice(0, 200)}`);
      else if(v && typeof v === "object" && typeof v.url === "string") parts.push(`${k}: ${v.url}`);
    }
    if(it.subItems && it.subItems.items) parts.push(`(${it.subItems.items.length} sub-items)`);
    if(parts.length) lines.push(parts.join("  "));
  }
  if(items.length > max) lines.push(`... and ${items.length - max} more`);
  return lines;
}

function fmtScore(s){ return s == null ? "  - " : String(Math.round(s * 100)).padStart(4); }

/* ---------------- runs ---------------- */
const results = [];

async function saveReports(name, runnerResult){
  const [html, json] = runnerResult.report;
  await writeFile(path.join(REPORTS, `${name}.report.html`), html);
  await writeFile(path.join(REPORTS, `${name}.report.json`), json);
}

function record(name, kind, url, lhr, categories, ms, { problems = [], perfRuns = null } = {}){
  const scores = {};
  const failing = {};
  for(const c of categories){
    scores[c] = lhr.categories[c] ? lhr.categories[c].score : null;
    failing[c] = failingAudits(lhr, c).map(a => ({
      id: a.id, title: a.title, score: a.score, scoreDisplayMode: a.scoreDisplayMode,
      displayValue: a.displayValue || "", errorMessage: a.errorMessage || "", items: auditItems(a)
    }));
  }
  const below = categories.filter(c => scores[c] == null || scores[c] < THRESHOLDS[c]);
  const r = {
    name, kind, url, formFactor: lhr.configSettings.formFactor, categories, scores, failing, below,
    runtimeError: lhr.runtimeError ? `${lhr.runtimeError.code}: ${lhr.runtimeError.message}` : null,
    problems, perfRuns, runWarnings: lhr.runWarnings || [], seconds: +(ms / 1000).toFixed(1)
  };
  results.push(r);
  const s = categories.map(c => `${SHORT[c]} ${fmtScore(scores[c]).trim()}`).join("  ");
  const extra = perfRuns ? `   [median of ${perfRuns.length}; perf per run: ${perfRuns.map(x => fmtScore(x).trim()).join(", ")}]` : "";
  console.log(`  ${name.padEnd(30)} ${s}   (${r.seconds}s)${extra}${below.length ? "   BELOW THRESHOLD: " + below.join(", ") : ""}`);
  if(r.runtimeError) console.log(`    runtime error: ${r.runtimeError}`);
  for(const p of problems) console.log(`    PROBLEM: ${p}`);
  return r;
}

// One Lighthouse navigation. With `page` the run uses that puppeteer page (so the rendered view can be
// checked afterwards with `expectSelector`); otherwise Lighthouse opens its own tab on the debugging port.
// With runs > 1 the report kept is the median run (Lighthouse's own computeMedianRun, as Lighthouse CI does),
// because simulated mobile performance varies by several points between identical runs.
async function navigationRun(name, url, { config, categories = ALL_CATEGORIES, extraFlags = {}, runs = 1, page, expectSelector } = {}){
  const t0 = Date.now();
  const flags = { output: ["html", "json"], logLevel: "error", onlyCategories: categories, ...extraFlags };
  if(!page) flags.port = chrome.port;
  const all = [];
  for(let i = 0; i < runs; i++){
    const rr = await lighthouse(url, flags, config, page);
    if(!rr) throw new Error(`Lighthouse returned no result for ${name}`);
    all.push(rr);
  }
  const problems = [];
  if(page && expectSelector && !(await page.$(expectSelector))){
    problems.push(`the audited page did not show ${expectSelector} (wrong view audited?) at ${page.url()}`);
  }
  let chosen = all[0];
  if(all.length > 1){
    const valid = filterToValidRuns(all.map(r => r.lhr));
    const median = valid.length ? computeMedianRun(valid) : all[0].lhr;
    chosen = all.find(r => r.lhr === median) || all[0];
  }
  await saveReports(name, chosen);
  const perfRuns = runs > 1 && categories.includes("performance")
    ? all.map(r => r.lhr.categories.performance ? r.lhr.categories.performance.score : null) : null;
  return record(name, "navigation", url, chosen.lhr, categories, Date.now() - t0, { problems, perfRuns });
}

async function snapshotRun(name, page, { categories = ["accessibility"], problems = [] } = {}){
  const t0 = Date.now();
  const rr = await snapshot(page, {
    config: { extends: "lighthouse:default", settings: { onlyCategories: categories, formFactor: "mobile", screenEmulation: { disabled: true } } },
    flags: { output: ["html", "json"], logLevel: "error" }
  });
  if(!rr) throw new Error(`Lighthouse snapshot returned no result for ${name}`);
  await saveReports(name, rr);
  return record(name, "snapshot", page.url(), rr.lhr, categories, Date.now() - t0, { problems });
}

/* ---------------- installability (same Chrome, DevTools protocol) ---------------- */
async function loadPuppeteer(){
  try{ return (await import("puppeteer-core")).default; }catch(e){ return null; }
}

async function checkInstallability(puppeteer, base){
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
  const out = { ok: false, errors: [], manifestUrl: null, manifestErrors: [], swControls: false, cachedRequests: 0, manifestName: null };
  try{
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: "load" });
    await page.waitForSelector("#app > *", { timeout: 15_000 });
    // First install claims the page straight away (skipWaiting + clients.claim).
    try{
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 30_000 });
      out.swControls = true;
    }catch(e){ out.errors.push("service worker did not take control of the page within 30 s"); }
    // The install step also caches Chart.js and the fonts.
    try{
      await page.waitForFunction(async () => {
        const keys = await caches.keys();
        if(!keys.length) return false;
        const c = await caches.open(keys[0]);
        return (await c.keys()).length > 14;
      }, { timeout: 30_000, polling: 250 });
    }catch(e){ out.errors.push("service worker cache did not fill with the app files + Chart.js within 30 s"); }
    out.cachedRequests = await page.evaluate(async () => {
      const keys = await caches.keys();
      let n = 0; for(const k of keys){ n += (await (await caches.open(k)).keys()).length; }
      return n;
    });
    const cdp = await page.createCDPSession();
    const m = await cdp.send("Page.getAppManifest");
    out.manifestUrl = m.url || null;
    out.manifestErrors = (m.errors || []).map(e => `${e.critical ? "CRITICAL " : ""}${e.message} (line ${e.line}:${e.column})`);
    if(!m.url) out.errors.push("no manifest link found");
    if(m.data){
      try{ out.manifestName = JSON.parse(m.data).name || null; }catch(e){ out.errors.push("manifest is not valid JSON"); }
    }
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    for(const e of installabilityErrors || []){
      out.errors.push(`installability: ${e.errorId}${(e.errorArguments || []).length ? " " + JSON.stringify(e.errorArguments) : ""}`);
    }
    if(out.manifestErrors.some(e => e.startsWith("CRITICAL"))) out.errors.push("manifest has critical parse errors");
    try{
      const icons = await cdp.send("Page.getManifestIcons");
      out.primaryIcon = !!(icons && icons.primaryIcon);
    }catch(e){ out.primaryIcon = null; }
    await page.close();
    out.ok = out.errors.length === 0;
  }finally{
    await browser.disconnect();
  }
  return out;
}

/* ---------------- seeded data ---------------- */
async function seedRecords(puppeteer, base){
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
  try{
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: "load" });
    await page.waitForSelector("#app > *", { timeout: 15_000 });
    const info = await page.evaluate(async () => {
      // App globals (classic scripts): todayISO, shiftDay, careId, dbPut.
      const T = todayISO(), now = Date.now();
      const tortoises = [
        { id: "lh-kuro", name: "Kuro", species: "Sulcata (African spurred)", sex: "Male", birth: shiftDay(T, -430), createdAt: now - 2e9 },
        { id: "lh-bintang", name: "Bintang", species: "Indian star", sex: "Female", birth: null, createdAt: now - 1e9 }
      ];
      const m = (tid, back, weightG, plastron, scl, notes = "") =>
        ({ id: `lh-m-${tid}-${back}`, tortoiseId: tid, createdAt: now - back * 864e5, kind: "measure", date: shiftDay(T, -back), plastron, scl, weightG, photo: null, notes });
      const c = (tid, back, data) => {
        const date = shiftDay(T, -back);
        return Object.assign({ id: careId(tid, date), tortoiseId: tid, createdAt: now - back * 864e5, kind: "care", date,
          soaked: false, food: [], foodNote: "", poop: "", urates: "", notes: "" }, data);
      };
      const entries = [
        m("lh-kuro", 180, 820, 14.2, 16.0, "Bought from a local breeder"),
        m("lh-kuro", 120, 905, 14.8, 16.6),
        m("lh-kuro", 60, 990, 15.3, 17.2),
        m("lh-kuro", 30, 1040, 15.7, 17.7, "Growth rings look smooth"),
        m("lh-kuro", 7, 1100, 16.0, 18.1),
        m("lh-bintang", 20, 310, 9.4, 10.5),
        c("lh-kuro", 0, { soaked: true, food: ["Leafy greens", "Weeds", "Flowers"], foodNote: "hibiscus", poop: "Normal, firm", urates: "Soft white paste", notes: "Very active in the morning sun" }),
        c("lh-kuro", 1, { food: ["Cactus pad"], poop: "Runny", urates: "Gritty / chalky" }),
        c("lh-kuro", 3, { soaked: true }),
        c("lh-kuro", 12, { food: ["Grass / hay"], notes: "Slept most of the day" }),
        c("lh-bintang", 2, { soaked: true, food: ["Pellets"] })
      ];
      for(const t of tortoises) if(!(await dbPut("tortoises", t))) throw new Error("dbPut tortoises failed");
      for(const e of entries) if(!(await dbPut("entries", e))) throw new Error("dbPut entries failed");
      return { tortoises: tortoises.length, entries: entries.length };
    });
    // Make sure the records really are there (independently of the app's in-memory state).
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".t-card", { timeout: 15_000 });
    const cards = await page.$$eval(".t-card h2", els => els.map(e => e.textContent));
    if(cards.join(",") !== "Bintang,Kuro") throw new Error(`Seeded home page shows ${JSON.stringify(cards)} instead of Bintang, Kuro`);
    await page.close();
    return info;
  }finally{
    await browser.disconnect();
  }
}

// Navigation audits of the populated screens. Storage reset is disabled so the seeded records survive.
// Each run uses our own page so we can confirm afterwards that the intended view was really audited.
async function dataRuns(puppeteer, base){
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
  try{
    const page = await browser.newPage();
    const categories = ["accessibility", "best-practices", "seo"];
    const extraFlags = { disableStorageReset: true };
    const views = [
      { name: "mobile-data-home", hash: "", settings: { unit: "auto" }, expectSelector: ".t-list .t-card:nth-child(2)" },
      { name: "mobile-data-care-week", hash: "#t/lh-kuro", settings: { unit: "auto", tab: "care", careView: "week" }, expectSelector: "#panel .days li .chip.bad" },
      { name: "mobile-data-care-month", hash: "#t/lh-kuro", settings: { unit: "auto", tab: "care", careView: "month" }, expectSelector: "#panel .cal .cell .dot" },
      { name: "mobile-data-growth", hash: "#t/lh-kuro", settings: { unit: "auto", tab: "growth" }, expectSelector: "#chartArea canvas" }
    ];
    for(const v of views){
      await page.goto(base, { waitUntil: "load" });
      await page.evaluate(s => localStorage.setItem("kulalog-settings", JSON.stringify(s)), v.settings);
      await navigationRun(v.name, base + v.hash, { categories, extraFlags, page, expectSelector: v.expectSelector });
    }
    await page.close();
  }finally{
    await browser.disconnect();
  }
}

// Accessibility snapshots of states a navigation audit never sees: open dialogs, dark mode.
// Each state is checked before the snapshot; if it can't be reached, that is recorded as a problem.
async function snapshotStates(puppeteer, base){
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
  try{
    const page = await browser.newPage();
    await page.setViewport({ width: 412, height: 823, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true });
    page.on("dialog", d => d.accept());
    // A full page load every time, so the app re-reads its settings from localStorage.
    const load = async (hash, settings) => {
      await page.goto(base, { waitUntil: "load" });
      await page.evaluate(s => localStorage.setItem("kulalog-settings", JSON.stringify(s)), settings);
      await page.goto(base + hash, { waitUntil: "load" });
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector("#app > *", { timeout: 15_000 });
    };
    const kuro = () => page.waitForFunction(() => document.querySelector(".profile h1")?.textContent === "Kuro", { timeout: 15_000 });
    const openDialog = async (trigger, dlg) => {
      await page.click(trigger);
      await page.waitForSelector(`${dlg}[open]`, { timeout: 10_000 });
    };
    const closeDialog = dlg => page.evaluate(sel => document.querySelector(sel).close(), dlg);
    const DARK_BG = "rgb(20, 24, 17)"; // --bg in dark mode (#141811)
    const states = [
      { name: "snapshot-dialog-daily-care", hash: "#t/lh-kuro", settings: { tab: "care", careView: "week" },
        prepare: async () => { await kuro(); await openDialog("#addC", "#cDlg"); }, after: () => closeDialog("#cDlg") },
      { name: "snapshot-dialog-measurement", hash: "#t/lh-kuro", settings: { tab: "growth" },
        prepare: async () => { await kuro(); await openDialog("#addM", "#mDlg"); }, after: () => closeDialog("#mDlg") },
      { name: "snapshot-dialog-tortoise", hash: "#t/lh-kuro", settings: { tab: "care" },
        prepare: async () => { await kuro(); await openDialog("#editT", "#tDlg"); }, after: () => closeDialog("#tDlg") },
      { name: "snapshot-dialog-settings", hash: "", settings: {},
        prepare: async () => {
          await openDialog("#openSettings", "#sDlg");
          await page.waitForSelector("#storageStatus:not([hidden])", { timeout: 5_000 }).catch(() => {});
        }, after: () => closeDialog("#sDlg") },
      { name: "snapshot-dark-home", dark: true, hash: "", settings: {}, prepare: () => page.waitForSelector(".t-card", { timeout: 15_000 }) },
      { name: "snapshot-dark-care-week", dark: true, hash: "#t/lh-kuro", settings: { tab: "care", careView: "week" },
        prepare: async () => { await kuro(); await page.waitForSelector("#panel .days .chip.bad", { timeout: 10_000 }); } },
      { name: "snapshot-dark-care-month", dark: true, hash: "#t/lh-kuro", settings: { tab: "care", careView: "month" },
        prepare: async () => { await kuro(); await page.waitForSelector("#panel .cal .cell .dot", { timeout: 10_000 }); } },
      { name: "snapshot-dark-growth", dark: true, hash: "#t/lh-kuro", settings: { tab: "growth" },
        prepare: async () => { await kuro(); await page.waitForSelector("#chartArea canvas", { timeout: 15_000 }); } }
    ];
    for(const st of states){
      const problems = [];
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: st.dark ? "dark" : "light" }]);
      try{
        await load(st.hash, { unit: "auto", ...st.settings });
        await st.prepare();
        if(st.dark){
          const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
          if(bg !== DARK_BG) problems.push(`dark theme not applied (body background ${bg}, expected ${DARK_BG})`);
        }
      }catch(e){
        problems.push(`could not reach this state: ${e.message.split("\n")[0]}`);
      }
      await snapshotRun(st.name, page, { problems });
      if(st.after) await st.after().catch(() => {});
    }
    await page.close();
  }finally{
    await browser.disconnect();
  }
}

/* ---------------- output ---------------- */
function printTable(){
  const cols = ALL_CATEGORIES;
  console.log("\n=== Category scores (0-100; thresholds: " + cols.map(c => `${SHORT[c]} >= ${Math.round(THRESHOLDS[c] * 100)}`).join(", ") + ") ===");
  console.log("  " + "run".padEnd(30) + cols.map(c => SHORT[c].padStart(6)).join("") + "  result");
  console.log("  " + "-".repeat(30 + cols.length * 6 + 8));
  for(const r of results){
    const cells = cols.map(c => {
      if(!r.categories.includes(c)) return "     -";
      const s = r.scores[c];
      return (fmtScore(s) + (r.below.includes(c) ? "!" : " ")).padStart(6);
    }).join("");
    console.log("  " + r.name.padEnd(30) + cells + "  " + (r.below.length || r.runtimeError ? "FAIL" : "ok"));
  }
  console.log("  (! = under threshold)");
}

function printFailingAudits(){
  console.log("\n=== Failing audits (score < 1, excluding informative / not applicable / manual) ===");
  for(const r of results){
    const cats = r.categories.filter(c => r.failing[c].length);
    if(!cats.length){ console.log(`\n[${r.name}] none`); continue; }
    console.log(`\n[${r.name}] ${r.url}`);
    for(const c of cats){
      console.log(`  ${c} (${fmtScore(r.scores[c]).trim()}):`);
      for(const a of r.failing[c]){
        const sc = a.scoreDisplayMode === "error" ? "ERROR" : `score ${a.score}`;
        console.log(`    - ${a.id}: ${a.title} [${sc}${a.displayValue ? ", " + a.displayValue : ""}]${a.errorMessage ? " " + a.errorMessage : ""}`);
        for(const line of a.items) console.log(`        ${line}`);
      }
    }
    for(const w of r.runWarnings) console.log(`  warning: ${typeof w === "string" ? w : JSON.stringify(w)}`);
  }
}

/* ---------------- main ---------------- */
async function main(){
  await mkdir(REPORTS, { recursive: true });
  const t0 = Date.now();

  const { port, base } = await startServer();
  console.log(`serve.js (pid ${serverChild.pid}) on ${base}`);

  const chromePath = getChromePath();
  chrome = await launch({ chromeFlags: ["--headless=new"], logLevel: "silent" });
  let version = "?";
  try{ version = (await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).Browser; }catch(e){}
  console.log(`Chrome: ${chromePath} (${version}), pid ${chrome.pid}, debugging port ${chrome.port}`);
  if(/chromium|ms-playwright/i.test(chromePath)){
    console.warn("WARNING: this does not look like the installed Google Chrome.");
  }

  console.log("\nLighthouse, empty app:");
  await navigationRun("mobile", base);
  await navigationRun("desktop", base, { config: desktopConfig });

  const puppeteer = await loadPuppeteer();
  let install = { skipped: "puppeteer-core is not available" };
  if(puppeteer){
    console.log("\nInstallability (same Chrome, DevTools protocol):");
    install = await checkInstallability(puppeteer, base);
    console.log(`  manifest: ${install.manifestUrl} (name "${install.manifestName}")${install.manifestErrors.length ? " errors: " + install.manifestErrors.join("; ") : ""}`);
    console.log(`  service worker controls page: ${install.swControls}, cached requests: ${install.cachedRequests}, primary icon: ${install.primaryIcon}`);
    console.log(`  ${install.ok ? "installable: yes" : "NOT INSTALLABLE: " + install.errors.join("; ")}`);

    if(!QUICK){
      console.log("\nLighthouse, app with records (mobile, storage reset disabled):");
      const seeded = await seedRecords(puppeteer, base);
      console.log(`  seeded ${seeded.tortoises} tortoises and ${seeded.entries} entries`);
      await dataRuns(puppeteer, base);

      console.log("\nLighthouse accessibility snapshots (open dialogs, dark mode):");
      await snapshotStates(puppeteer, base);
    }
  }else{
    console.log("\nInstallability: skipped (puppeteer-core not available); covered by the Playwright PWA spec.");
  }

  printTable();
  printFailingAudits();

  const failedRuns = results.filter(r => r.below.length || r.runtimeError);
  const installFailed = install && install.ok === false;
  const passed = !failedRuns.length && !installFailed;
  await writeFile(path.join(REPORTS, "summary.json"), JSON.stringify({
    date: new Date().toISOString(), chrome: { path: chromePath, version }, base, thresholds: THRESHOLDS,
    runs: results, installability: install, passed
  }, null, 2));

  console.log(`\nReports: ${path.relative(ROOT, REPORTS)}${path.sep}<run>.report.html/.json, summary.json`);
  console.log(`Total time ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if(passed){
    console.log("\nLIGHTHOUSE PASSED");
  }else{
    console.log("\nLIGHTHOUSE FAILED:");
    for(const r of failedRuns){
      console.log(`  ${r.name}: ${r.below.map(c => `${c} ${fmtScore(r.scores[c]).trim()} < ${Math.round(THRESHOLDS[c] * 100)}`).join(", ")}${r.runtimeError ? " runtime error " + r.runtimeError : ""}`);
    }
    if(installFailed) console.log(`  installability: ${install.errors.join("; ")}`);
  }
  return passed ? 0 : 1;
}

let code = 2;
try{
  code = await main();
}catch(err){
  console.error("\nLighthouse run crashed:", err && err.stack || err);
  code = 2;
}finally{
  await cleanup();
}
process.exit(code);
