// Shared helpers for the Kulalog browser tests.
const { expect } = require("@playwright/test");

// Today's date (yyyy-mm-dd) as the app sees it, in the page's timezone.
const pageToday = page => page.evaluate(() => todayISO());

// Open the app on a fresh profile and wait until the app has rendered.
async function openApp(page, hash = ""){
  await page.goto("./" + hash);
  await expect(page.locator("#app > *").first()).toBeVisible();
}

// Wait until the service worker is active and controls this page (first install claims the page, no reload).
async function waitForServiceWorker(page){
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
  // The install step also caches Chart.js and the fonts; wait until the cache holds them.
  await expect.poll(() => page.evaluate(async () => {
    const keys = await caches.keys();
    if(!keys.length) return 0;
    const c = await caches.open(keys[0]);
    return (await c.keys()).length;
  }), { timeout: 30_000 }).toBeGreaterThan(14);
}

// Accept every confirm() the app shows (deletes, clear day).
function acceptDialogs(page){
  page.on("dialog", d => d.accept());
}

// Add a tortoise through the UI. Ends on that tortoise's page.
async function addTortoise(page, { name, species = "Sulcata (African spurred)", speciesOther, sex = "Unknown", birth } = {}){
  await page.locator("#addT").click();
  const dlg = page.locator("#tDlg");
  await expect(dlg).toBeVisible();
  await dlg.locator("[name=name]").fill(name);
  await dlg.locator("[name=species]").selectOption(species);
  if(speciesOther != null) await dlg.locator("[name=speciesOther]").fill(speciesOther);
  await dlg.locator("[name=sex]").selectOption(sex);
  if(birth) await dlg.locator("[name=birth]").fill(birth);
  await dlg.locator("#tSave").click();
  await expect(dlg).toBeHidden();
  await expect(page.locator(".profile h1")).toHaveText(name);
}

// Put records straight into IndexedDB (same shape as a backup), then reload so the app reads them.
async function seed(page, { tortoises = [], entries = [] }){
  await page.evaluate(async ({ tortoises, entries }) => {
    for(const t of tortoises){ await dbPut("tortoises", t); }
    for(const e of entries){ await dbPut("entries", e); }
  }, { tortoises, entries });
  await page.reload();
  await expect(page.locator("#app > *").first()).toBeVisible();
}

// Records currently in IndexedDB, read independently of the app's in-memory state.
function readDb(page){
  return page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open("kulalog", 1);
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const d = r.result, out = {};
      const tx = d.transaction(["tortoises", "entries"]);
      tx.objectStore("tortoises").getAll().onsuccess = ev => out.tortoises = ev.target.result;
      tx.objectStore("entries").getAll().onsuccess = ev => out.entries = ev.target.result;
      tx.oncomplete = () => { d.close(); resolve(out); };
    };
  }));
}

async function expectToast(page, text){
  await expect(page.locator("#toast")).toContainText(text);
}

module.exports = { pageToday, openApp, waitForServiceWorker, acceptDialogs, addTortoise, seed, readDb, expectToast };
