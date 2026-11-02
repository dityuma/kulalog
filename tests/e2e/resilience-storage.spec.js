// @ts-check
// Storage failures (writes that fail, imports that only partly reach storage, IndexedDB blocked by the browser) and a
// new calendar day while the app stays open. Runs in both Playwright projects: desktop-chrome and pixel-7.
const { test, expect } = require("@playwright/test");
const { openApp, addTortoise, seed, readDb } = require("./helpers");

/* ---------- Setup shared by every test ---------- */

// None of this needs the network or the service worker. Block the third-party hosts (fonts, Chart.js) and the worker
// so the tests don't depend on the internet or on when the worker takes over.
const THIRD_PARTY = /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
test.use({ serviceWorkers: "block" });
test.beforeEach(async ({ page }) => {
  await page.context().route(THIRD_PARTY, r => r.abort());
});

const SAVE_FAILED = "Couldn't save. Your device may be out of storage space. Free some space and try again.";
const IMPORT_FAILED = "Couldn't import everything. Your device may be out of storage space.";
const STORAGE_BLOCKED = "This browser is blocking storage, so records won't be kept after you close Kulalog.";

/* ---------- Helpers ---------- */

// Init script: IndexedDB writes fail on demand. window.__failWrites = true makes every put() fail, an array of ids makes
// the puts of those records fail. A failing put aborts its transaction straight away, so the request ends with an
// AbortError that reaches the transaction's error handler. window.__failedWrites counts the writes that were refused.
function failableWrites(){
  // @ts-ignore
  window.__failWrites = false; window.__failedWrites = 0;
  const realPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value){
    const req = realPut.apply(this, arguments);
    // @ts-ignore
    const f = window.__failWrites;
    if(f === true || (Array.isArray(f) && value && f.includes(value.id))){
      // @ts-ignore
      window.__failedWrites++;
      this.transaction.abort();
    }
    return req;
  };
}
const failWrites = (page, how) => page.evaluate(how => { window["__failWrites"] = how; }, how);
const failedWrites = page => page.evaluate(() => window["__failedWrites"]);

// The toast keeps its last text after it fades out; empty it so "no toast" can be checked.
const clearToast = page => page.evaluate(() => { const t = document.getElementById("toast"); t.textContent = ""; t.classList.remove("show"); });
const toast = page => page.locator("#toast");

// Start the page clock at noon (Asia/Jakarta) of the real current day and let it run, so a run that crosses midnight
// can't move the app to the next day half way through a test.
const noonToday = () => new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" }) + "T12:00:00+07:00");
const dayISO = (page, n = 0) => page.evaluate(n => shiftDay(todayISO(), n), n);

const statValue = (page, label) =>
  page.locator(".stats .stat").filter({ has: page.locator(".k", { hasText: new RegExp(`^${label}$`) }) }).locator(".v");
const dayRow = (page, iso) => page.locator(`.days button.day[data-day="${iso}"]`);
const foodChip = (dlg, food) => dlg.locator("#foodChips label").filter({ hasText: food });
const byId = list => [...list].sort((a, b) => a.id.localeCompare(b.id));
// The app's in-memory records (what the screen is drawn from).
const memory = page => page.evaluate(() => JSON.parse(JSON.stringify({ tortoises: store.tortoises, entries: store.entries })));

// Re-draw the tortoise page from memory (switch tabs and back), so the screen shows what the app now holds.
async function redraw(page){
  const growth = await page.locator("#tab-growth").getAttribute("aria-selected") === "true";
  await page.locator(growth ? "#tab-care" : "#tab-growth").click();
  await page.locator(growth ? "#tab-growth" : "#tab-care").click();
  await expect(page.locator(growth ? "#tab-growth" : "#tab-care")).toHaveAttribute("aria-selected", "true");
}

const KURO = { id: "t_kuro", createdAt: 1700000000000, name: "Kuro", species: "Leopard", sex: "Female", birth: "2023-05-01" };
const measure = (id, tortoiseId, date, weightG, extra = {}) =>
  ({ id, kind: "measure", tortoiseId, date, createdAt: 1700000000100, plastron: null, scl: null, weightG, photo: null, notes: "", ...extra });

// Open the app, store Kuro (plus any entries) and open Kuro's page.
async function openKuro(page, entries = []){
  await openApp(page);
  await seed(page, { tortoises: [KURO], entries });
  await page.locator(".t-card", { hasText: "Kuro" }).click();
  await expect(page.locator(".profile h1")).toHaveText("Kuro");
}

/* ---------- Writes that fail ---------- */

test.describe("a save that storage refuses", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: noonToday() });
    await page.addInitScript(failableWrites);
  });

  test("adding a tortoise keeps the dialog open with the error, adds nothing, and saving again works", async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole("heading", { name: "Start your first logbook" })).toBeVisible();
    await page.locator("#addT").click();
    const dlg = page.locator("#tDlg");
    await dlg.locator("[name=name]").fill("Kuro");
    await dlg.locator("[name=species]").selectOption("Leopard");

    await failWrites(page, true);
    await clearToast(page);
    await dlg.locator("#tSave").click();
    await expect(dlg.locator("#tErr")).toHaveText(SAVE_FAILED);
    await expect(dlg.locator("#tErr")).toBeVisible();
    await expect(dlg).toBeVisible();
    expect(await failedWrites(page)).toBe(1);
    await expect(toast(page)).toHaveText("");
    // The screen, the address and memory still show no tortoise, like storage.
    await expect(page.getByRole("heading", { name: "Start your first logbook" })).toBeVisible();
    expect(new URL(page.url()).hash).toBe("");
    expect((await memory(page)).tortoises).toEqual([]);
    expect((await readDb(page)).tortoises).toEqual([]);

    // Space is freed: the same dialog, still filled in, saves.
    await expect(dlg.locator("[name=name]")).toHaveValue("Kuro");
    await failWrites(page, false);
    await dlg.locator("#tSave").click();
    await expect(dlg).toBeHidden();
    await expect(toast(page)).toHaveText("Kuro added");
    await expect(page.locator(".profile h1")).toHaveText("Kuro");
    const stored = (await readDb(page)).tortoises;
    expect(stored.map(t => [t.name, t.species])).toEqual([["Kuro", "Leopard"]]);
    expect((await memory(page)).tortoises).toEqual(stored);
    await page.getByRole("button", { name: "All tortoises" }).click();
    await expect(page.locator(".t-card")).toHaveCount(1);
  });

  test("renaming a tortoise keeps the old name on screen, in memory and in storage, and saving again works", async ({ page }) => {
    await openKuro(page);
    await page.locator("#editT").click();
    const dlg = page.locator("#tDlg");
    await expect(dlg.locator("#tDlgTitle")).toHaveText("Edit tortoise");
    await dlg.locator("[name=name]").fill("Kuro Dua");
    await dlg.locator("[name=sex]").selectOption("Male");

    await failWrites(page, true);
    await clearToast(page);
    await dlg.locator("#tSave").click();
    await expect(dlg.locator("#tErr")).toHaveText(SAVE_FAILED);
    await expect(dlg).toBeVisible();
    await expect(toast(page)).toHaveText("");
    await expect(page.locator(".profile h1")).toHaveText("Kuro");
    await expect(page.locator("#delT")).toHaveText("Delete Kuro");
    expect((await memory(page)).tortoises).toEqual([KURO]);
    expect((await readDb(page)).tortoises).toEqual([KURO]);

    // Cancel: a redraw and the edit form still show what is stored.
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();
    await redraw(page);
    await expect(page.locator(".profile h1")).toHaveText("Kuro");
    await expect(page.locator(".profile .chip").first()).toHaveText("Female");
    await page.locator("#editT").click();
    await expect(dlg.locator("[name=name]")).toHaveValue("Kuro");
    await expect(dlg.locator("[name=sex]")).toHaveValue("Female");

    await dlg.locator("[name=name]").fill("Kuro Dua");
    await failWrites(page, false);
    await dlg.locator("#tSave").click();
    await expect(dlg).toBeHidden();
    await expect(toast(page)).toHaveText("Changes saved");
    await expect(page.locator(".profile h1")).toHaveText("Kuro Dua");
    expect((await readDb(page)).tortoises).toEqual([{ ...KURO, name: "Kuro Dua" }]);
    expect((await memory(page)).tortoises).toEqual([{ ...KURO, name: "Kuro Dua" }]);
    await page.getByRole("button", { name: "All tortoises" }).click();
    await expect(page.locator(".t-card h2")).toHaveText(["Kuro Dua"]);
  });

  test("logging a measurement keeps the dialog open, the growth list unchanged, and saving again works", async ({ page }) => {
    const m1 = measure("m_1", "t_kuro", "2026-01-05", 400, { plastron: 12.5 });
    await openKuro(page, [m1]);
    await page.locator("#tab-growth").click();
    await expect(page.locator(".timeline .entry")).toHaveCount(1);
    await expect(statValue(page, "Weight")).toHaveText("400 g");

    await page.locator("#addM").click();
    const dlg = page.locator("#mDlg");
    await dlg.locator("[name=weight]").fill("450");
    await dlg.locator("[name=wunit]").selectOption("g");
    await failWrites(page, true);
    await clearToast(page);
    await dlg.getByRole("button", { name: "Save measurement" }).click();
    await expect(dlg.locator("#mErr")).toHaveText(SAVE_FAILED);
    await expect(dlg).toBeVisible();
    await expect(toast(page)).toHaveText("");
    await expect(page.locator(".timeline .entry")).toHaveCount(1);
    await expect(statValue(page, "Weight")).toHaveText("400 g");
    expect((await memory(page)).entries).toEqual([m1]);
    expect((await readDb(page)).entries).toEqual([m1]);

    await failWrites(page, false);
    await dlg.getByRole("button", { name: "Save measurement" }).click();
    await expect(dlg).toBeHidden();
    await expect(toast(page)).toHaveText("Measurement saved");
    await expect(page.locator(".timeline .entry")).toHaveCount(2);
    await expect(statValue(page, "Weight")).toHaveText("450 g");
    const stored = (await readDb(page)).entries;
    expect(stored.map(e => e.weightG).sort()).toEqual([400, 450]);
    expect(byId((await memory(page)).entries)).toEqual(byId(stored));
  });

  test("editing a measurement keeps the old values on screen and in memory, and saving again works", async ({ page }) => {
    const m1 = measure("m_1", "t_kuro", "2026-01-05", 400, { notes: "Before the rains" });
    await openKuro(page, [m1]);
    await page.locator("#tab-growth").click();
    const entry = page.locator(".timeline .entry");
    await expect(entry.locator(".entry-nums")).toHaveText("Weight 400 g");

    await page.locator('[data-edit="m_1"]').click();
    const dlg = page.locator("#mDlg");
    await expect(dlg.locator("[name=weight]")).toHaveValue("400");
    await dlg.locator("[name=weight]").fill("420");
    await dlg.locator("[name=notes]").fill("After the rains");
    await failWrites(page, true);
    await clearToast(page);
    await dlg.getByRole("button", { name: "Save measurement" }).click();
    await expect(dlg.locator("#mErr")).toHaveText(SAVE_FAILED);
    await expect(dlg).toBeVisible();
    await expect(toast(page)).toHaveText("");
    expect((await memory(page)).entries).toEqual([m1]);
    expect((await readDb(page)).entries).toEqual([m1]);

    // Cancel: a redraw and the edit form still show the stored values.
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await redraw(page);
    await expect(entry.locator(".entry-nums")).toHaveText("Weight 400 g");
    await expect(entry.locator(".entry-notes")).toHaveText("Before the rains");
    await expect(statValue(page, "Weight")).toHaveText("400 g");
    await page.locator('[data-edit="m_1"]').click();
    await expect(dlg.locator("[name=weight]")).toHaveValue("400");
    await expect(dlg.locator("[name=notes]")).toHaveValue("Before the rains");

    await dlg.locator("[name=weight]").fill("420");
    await failWrites(page, false);
    await dlg.getByRole("button", { name: "Save measurement" }).click();
    await expect(dlg).toBeHidden();
    await expect(toast(page)).toHaveText("Measurement updated");
    await expect(entry.locator(".entry-nums")).toHaveText("Weight 420 g");
    expect((await readDb(page)).entries).toEqual([{ ...m1, weightG: 420 }]);
    expect((await memory(page)).entries).toEqual([{ ...m1, weightG: 420 }]);
  });

  test("logging today's care keeps the dialog open, the day empty, and saving again works", async ({ page }) => {
    await openKuro(page);
    const today = await dayISO(page);
    const row = dayRow(page, today);
    await expect(row.locator(".marks")).toHaveText("Nothing logged. Tap to add.");
    await expect(statValue(page, "Last soaked")).toHaveText("Not yet");

    await page.locator("#addC").click();
    const dlg = page.locator("#cDlg");
    await dlg.locator("[name=soaked]").check();
    await foodChip(dlg, "Fruit").click();
    await dlg.locator("[name=notes]").fill("Ate well");
    await failWrites(page, true);
    await clearToast(page);
    await dlg.getByRole("button", { name: "Save care" }).click();
    await expect(dlg.locator("#cErr")).toHaveText(SAVE_FAILED);
    await expect(dlg).toBeVisible();
    await expect(toast(page)).toHaveText("");
    await expect(row.locator(".marks")).toHaveText("Nothing logged. Tap to add.");
    expect((await memory(page)).entries).toEqual([]);
    expect((await readDb(page)).entries).toEqual([]);

    // Cancel: a redraw still shows an empty day, and the day opens as not logged yet.
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await redraw(page);
    await expect(row.locator(".marks")).toHaveText("Nothing logged. Tap to add.");
    await expect(statValue(page, "Last soaked")).toHaveText("Not yet");
    await page.locator("#addC").click();
    await expect(dlg.locator("#cHint")).toBeHidden();
    await expect(dlg.locator("[name=soaked]")).not.toBeChecked();
    await expect(dlg.locator("[name=notes]")).toHaveValue("");

    await dlg.locator("[name=soaked]").check();
    await foodChip(dlg, "Fruit").click();
    await dlg.locator("[name=notes]").fill("Ate well");
    await failWrites(page, false);
    await dlg.getByRole("button", { name: "Save care" }).click();
    await expect(dlg).toBeHidden();
    await expect(toast(page)).toHaveText("Care saved");
    await expect(row.locator(".marks .chip")).toHaveText(["Soaked", "Fruit"]);
    await expect(row.locator(".marks .nt")).toHaveText("Ate well");
    await expect(statValue(page, "Last soaked")).toHaveText("Today");
    const stored = (await readDb(page)).entries;
    expect(stored).toEqual([expect.objectContaining({ id: `c_t_kuro_${today}`, kind: "care", date: today, soaked: true, food: ["Fruit"], notes: "Ate well" })]);
    expect((await memory(page)).entries).toEqual(stored);
  });

  test("updating a day's care keeps the day's previous values on screen, in memory and in the form, and saving again works", async ({ page }) => {
    await openApp(page);
    const today = await dayISO(page);
    const care = { id: `c_t_kuro_${today}`, kind: "care", tortoiseId: "t_kuro", date: today, createdAt: 1700000000200,
      soaked: true, food: ["Fruit"], foodNote: "", poop: "Normal, firm", urates: "", notes: "First note" };
    await seed(page, { tortoises: [KURO], entries: [care] });
    await page.locator(".t-card", { hasText: "Kuro" }).click();
    const row = dayRow(page, today);
    await expect(row.locator(".marks .chip")).toHaveText(["Soaked", "Fruit", "Poop: Normal, firm"]);
    await expect(statValue(page, "Last soaked")).toHaveText("Today");

    const dlg = page.locator("#cDlg");
    const change = async () => {
      await dlg.locator("[name=soaked]").uncheck();
      await foodChip(dlg, "Pumpkin").click();
      await dlg.locator("[name=poop]").selectOption("Runny");
      await dlg.locator("[name=notes]").fill("Second note");
    };
    await row.click();
    await expect(dlg.locator("#cHint")).toHaveText("Already logged for this day. Your changes update it.");
    await change();
    await failWrites(page, true);
    await clearToast(page);
    await dlg.getByRole("button", { name: "Save care" }).click();
    await expect(dlg.locator("#cErr")).toHaveText(SAVE_FAILED);
    await expect(dlg).toBeVisible();
    await expect(toast(page)).toHaveText("");
    expect((await memory(page)).entries).toEqual([care]);
    expect((await readDb(page)).entries).toEqual([care]);

    // Cancel: a redraw still shows the stored day, and opening the day again fills in its stored values.
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await redraw(page);
    await expect(row.locator(".marks .chip")).toHaveText(["Soaked", "Fruit", "Poop: Normal, firm"]);
    await expect(row.locator(".marks .nt")).toHaveText("First note");
    await expect(statValue(page, "Last soaked")).toHaveText("Today");
    await row.click();
    await expect(dlg.locator("[name=soaked]")).toBeChecked();
    await expect(dlg.locator('#foodChips input[value="Fruit"]')).toBeChecked();
    await expect(dlg.locator('#foodChips input[value="Pumpkin"]')).not.toBeChecked();
    await expect(dlg.locator("[name=poop]")).toHaveValue("Normal, firm");
    await expect(dlg.locator("[name=notes]")).toHaveValue("First note");

    await change();
    await failWrites(page, false);
    await dlg.getByRole("button", { name: "Save care" }).click();
    await expect(dlg).toBeHidden();
    await expect(toast(page)).toHaveText("Care updated");
    await expect(row.locator(".marks .chip")).toHaveText(["Pumpkin, Fruit", "Poop: Runny"]);
    await expect(row.locator(".marks .nt")).toHaveText("Second note");
    await expect(statValue(page, "Last soaked")).toHaveText("Not yet");
    const updated = { ...care, soaked: false, food: ["Pumpkin", "Fruit"], poop: "Runny", notes: "Second note" };
    expect((await readDb(page)).entries).toEqual([updated]);
    expect((await memory(page)).entries).toEqual([updated]);
  });

  // Regression: a failed care update restored the record with Object.assign(e, before), which left the fields the save
  // added, so a care record without some fields held the unsaved note in memory and on screen. upsertCare now returns
  // a copy and the stored record is only replaced after a successful write.
  test("a failed update of a care record that lacks some fields leaves no unsaved value in memory", async ({ page }) => {
    await openApp(page);
    const today = await dayISO(page);
    const care = { id: `c_t_kuro_${today}`, kind: "care", tortoiseId: "t_kuro", date: today, createdAt: 1700000000200, soaked: true };
    await seed(page, { tortoises: [KURO], entries: [care] });
    await page.locator(".t-card", { hasText: "Kuro" }).click();
    const row = dayRow(page, today);
    await expect(row.locator(".marks .chip")).toHaveText(["Soaked"]);

    const dlg = page.locator("#cDlg");
    await row.click();
    await dlg.locator("[name=notes]").fill("Never stored");
    await failWrites(page, true);
    await dlg.getByRole("button", { name: "Save care" }).click();
    await expect(dlg.locator("#cErr")).toHaveText(SAVE_FAILED);
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await redraw(page);
    await expect(row.locator(".marks .chip")).toHaveText(["Soaked"]);
    await expect(row.locator(".marks .nt")).toHaveCount(0);
    expect((await readDb(page)).entries).toEqual([care]);
    expect((await memory(page)).entries).toEqual([care]);
  });

  // Regression: when the device is really out of space, Chrome aborts the transaction at commit with QuotaExceededError
  // and fires only "abort", no "error". dbPut() listened for complete and error only, so the save hung with no message.
  test("with the device really out of space (Chrome quota), adding a tortoise shows the save error", async ({ page, baseURL }) => {
    await openApp(page);
    const origin = new URL(String(baseURL)).origin;
    const cdp = await page.context().newCDPSession(page);
    await page.locator("#addT").click();
    const dlg = page.locator("#tDlg");
    await dlg.locator("[name=name]").fill("Kuro");
    try{
      await cdp.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1024 });
      // Make sure the quota really applies (a commit aborts with QuotaExceededError); otherwise this test proves nothing.
      const probe = await page.evaluate(() => new Promise(res => {
        const tx = db.transaction("entries", "readwrite");
        tx.objectStore("entries").put({ id: "quota-probe" });
        tx.oncomplete = () => res("complete");
        tx.onabort = () => res(tx.error ? tx.error.name : "abort");
      }));
      test.skip(probe !== "QuotaExceededError", `Chrome didn't apply the quota override (probe: ${probe})`);

      await dlg.locator("#tSave").click();
      await expect(dlg.locator("#tErr")).toHaveText(SAVE_FAILED);
      await expect(dlg).toBeVisible();
      expect((await readDb(page)).tortoises).toEqual([]);
    }finally{
      await cdp.send("Storage.overrideQuotaForOrigin", { origin }).catch(() => {});
    }
  });
});

/* ---------- Import that only partly reaches storage ---------- */

test.describe("an import that storage partly refuses", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: noonToday() });
    await page.addInitScript(failableWrites);
  });

  test("says not everything was imported and shows exactly what was stored; importing again later works", async ({ page }) => {
    const k1 = measure("m_k1", "t_kuro", "2026-01-05", 400);
    await openApp(page);
    await seed(page, { tortoises: [KURO], entries: [k1] });
    await expect(page.locator(".t-card h2")).toHaveText(["Kuro"]);

    const ayu = { id: "t_ayu", createdAt: 1700000001000, name: "Ayu", species: "Radiated", sex: "Male", birth: null };
    const bima = { id: "t_bima", createdAt: 1700000002000, name: "Bima", species: "Red-footed", sex: "Unknown", birth: null };
    const kuroRenamed = { ...KURO, name: "Kuro Renamed" };
    const a1 = measure("m_a1", "t_ayu", "2026-02-01", 300), a2 = measure("m_a2", "t_ayu", "2026-02-15", 320);
    const b1 = measure("m_b1", "t_bima", "2026-02-01", 900);
    const backup = { app: "kulalog", version: 1, exported: "2026-02-20T03:00:00.000Z", tortoises: [kuroRenamed, ayu, bima], entries: [a1, a2, b1] };
    const file = { name: "kulalog-backup-2026-02-20.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) };

    // Storage refuses the rename of Kuro, Bima with his measurement, and Ayu's second measurement.
    await failWrites(page, ["t_kuro", "t_bima", "m_b1", "m_a2"]);
    await clearToast(page);
    await page.getByRole("button", { name: "Settings and backup" }).click();
    await page.locator("#importFile").setInputFiles(file);
    await expect(toast(page)).toHaveText(IMPORT_FAILED);
    await expect(page.locator("#sDlg")).toBeHidden();
    expect(await failedWrites(page)).toBe(4);

    const stored = await readDb(page);
    expect(byId(stored.tortoises)).toEqual([ayu, KURO]);
    expect(byId(stored.entries)).toEqual([a1, k1]);
    const mem = await memory(page);
    expect(byId(mem.tortoises)).toEqual(byId(stored.tortoises));
    expect(byId(mem.entries)).toEqual(byId(stored.entries));
    // The list shows the stored tortoises only, under their stored names.
    await expect(page.locator(".t-card h2")).toHaveText(["Ayu", "Kuro"]);
    await page.locator(".t-card", { hasText: "Ayu" }).click();
    await page.locator("#tab-growth").click();
    await expect(page.locator(".timeline .entry")).toHaveCount(1);
    await expect(page.locator(".timeline .entry .entry-nums")).toHaveText("Weight 300 g");

    // With space again, importing the same file brings in the rest.
    await failWrites(page, false);
    await clearToast(page);
    await page.getByRole("button", { name: "Settings and backup" }).click();
    await page.locator("#importFile").setInputFiles(file);
    await expect(toast(page)).toHaveText("Imported 3 tortoises and 3 entries");
    const all = await readDb(page);
    expect(byId(all.tortoises)).toEqual([ayu, bima, kuroRenamed]);
    expect(byId(all.entries)).toEqual([a1, a2, b1, k1]);
    await page.getByRole("button", { name: "All tortoises" }).click();
    await expect(page.locator(".t-card h2")).toHaveText(["Ayu", "Bima", "Kuro Renamed"]);
  });
});

/* ---------- IndexedDB blocked by the browser ---------- */

test.describe("storage blocked by the browser", () => {
  // Chrome refuses indexedDB.open() in two ways: it throws a SecurityError (contexts without storage access), or the
  // request fails with "The user denied permission to access the database." (site data blocked in the settings).
  const blockers = {
    "open() throws": () => {
      IDBFactory.prototype.open = function(){ throw new DOMException("access to the Indexed Database API is denied in this context.", "SecurityError"); };
    },
    "the open request fails": () => {
      IDBFactory.prototype.open = function(){
        const req = { result: undefined, error: new DOMException("The user denied permission to access the database.", "UnknownError"),
          onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
        // @ts-ignore
        Promise.resolve().then(() => req.onerror && req.onerror({ type: "error", target: req }));
        return req;
      };
    }
  };
  for(const [how, block] of Object.entries(blockers)){
    test(`when ${how}, Kulalog says records won't be kept and still works from memory without save errors`, async ({ page }) => {
      await page.clock.install({ time: noonToday() });
      await page.addInitScript(block);
      await openApp(page);
      await expect(toast(page)).toHaveText(STORAGE_BLOCKED);
      expect(await page.evaluate(() => db)).toBeNull();

      await clearToast(page);
      await addTortoise(page, { name: "Kuro", species: "Leopard" });
      await expect(toast(page)).toHaveText("Kuro added");
      await expect(page.locator("#tErr")).toBeHidden();

      const today = await dayISO(page);
      await page.locator("#addC").click();
      const dlg = page.locator("#cDlg");
      await dlg.locator("[name=soaked]").check();
      await dlg.getByRole("button", { name: "Save care" }).click();
      await expect(dlg).toBeHidden();
      await expect(page.locator("#cErr")).toBeHidden();
      await expect(toast(page)).toHaveText("Care saved");
      await expect(dayRow(page, today).locator(".marks .chip")).toHaveText(["Soaked"]);
      await expect(statValue(page, "Last soaked")).toHaveText("Today");

      await page.locator("#addM").click();
      const mDlg = page.locator("#mDlg");
      await mDlg.locator("[name=weight]").fill("450");
      await mDlg.getByRole("button", { name: "Save measurement" }).click();
      await expect(mDlg).toBeHidden();
      await expect(page.locator("#mErr")).toBeHidden();
      await expect(toast(page)).toHaveText("Measurement saved");
      await expect(statValue(page, "Weight")).toHaveText("450 g");

      // As the message said: nothing is kept once the page is closed.
      await page.reload();
      await expect(toast(page)).toHaveText(STORAGE_BLOCKED);
      await expect(page.getByRole("heading", { name: "Start your first logbook" })).toBeVisible();
    });
  }
});

/* ---------- A new day while the app stays open ---------- */

// The app checks the date when the page becomes visible again. Tests switch the page to hidden and back.
async function hideAndShow(page){
  await page.evaluate(() => {
    for(const state of ["hidden", "visible"]){
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
}
// Remember a node of the current screen; it is gone once the screen has been drawn again.
const markNode = (page, selector) => page.evaluate(s => { window["__marked"] = document.querySelector(s); }, selector);
const markedNodeShown = page => page.evaluate(() => document.contains(window["__marked"]));

test.describe("a new day while Kulalog stays open", () => {
  test("coming back after midnight moves Today to the new date, keeps the scroll position, and the same day draws nothing again", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-03-10T23:59:00+07:00") });
    await openApp(page);
    await page.clock.pauseAt(new Date("2026-03-10T23:59:30+07:00"));
    expect(await dayISO(page)).toBe("2026-03-10");
    await addTortoise(page, { name: "Kuro", species: "Leopard" });
    await page.locator("#addC").click();
    const dlg = page.locator("#cDlg");
    await dlg.locator("[name=soaked]").check();
    await foodChip(dlg, "Fruit").click();
    await dlg.getByRole("button", { name: "Save care" }).click();
    await expect(dlg).toBeHidden();

    const rows = page.locator(".days li button.day");
    await expect(rows).toHaveCount(7);
    await expect(rows.first()).toHaveAttribute("data-day", "2026-03-10");
    await expect(rows.first().locator(".dlabel")).toHaveText("Today10 Mar");
    await expect(rows.first().locator(".marks .chip")).toHaveText(["Soaked", "Fruit"]);
    await expect(rows.nth(1).locator(".dlabel")).toHaveText("Yesterday9 Mar");
    await expect(statValue(page, "Last soaked")).toHaveText("Today");

    // Scroll down the page (a short window makes sure there is room to scroll).
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp ? vp.width : 1280, height: 520 });
    await page.evaluate(() => window.scrollTo(0, Math.min(260, document.documentElement.scrollHeight - innerHeight)));
    const y = await page.evaluate(() => window.scrollY);
    expect(y).toBeGreaterThan(100);

    // Same day: hiding and showing the app draws nothing again.
    await markNode(page, ".days");
    await page.clock.runFor(10_000);
    await hideAndShow(page);
    expect(await markedNodeShown(page)).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(y);

    // The phone sleeps over midnight (no timers run); the app is shown again at 00:00:30.
    await page.clock.setSystemTime(new Date("2026-03-11T00:00:30+07:00"));
    expect(await dayISO(page)).toBe("2026-03-11");
    expect(await markedNodeShown(page)).toBe(true);
    await hideAndShow(page);

    await expect(rows).toHaveCount(7);
    await expect(rows.first()).toHaveAttribute("data-day", "2026-03-11");
    await expect(rows.first()).toHaveClass(/\btoday\b/);
    await expect(rows.first().locator(".dlabel")).toHaveText("Today11 Mar");
    await expect(rows.first().locator(".marks")).toHaveText("Nothing logged. Tap to add.");
    await expect(rows.nth(1)).toHaveAttribute("data-day", "2026-03-10");
    await expect(rows.nth(1)).not.toHaveClass(/\btoday\b/);
    await expect(rows.nth(1).locator(".dlabel")).toHaveText("Yesterday10 Mar");
    await expect(rows.nth(1).locator(".marks .chip")).toHaveText(["Soaked", "Fruit"]);
    await expect(rows.last()).toHaveAttribute("data-day", "2026-03-05");
    await expect(statValue(page, "Last soaked")).toHaveText("Yesterday");
    await expect(statValue(page, "Last fed")).toHaveText("Yesterday");
    expect(await markedNodeShown(page)).toBe(false);
    expect(await page.evaluate(() => window.scrollY)).toBe(y);
    await expect(page.locator(".profile h1")).toHaveText("Kuro");
  });

  test("left open on the list over midnight, the list follows the calendar within a minute, then stays put", async ({ page }) => {
    // The last day of March, so the new day is in a new month too.
    await page.clock.install({ time: new Date("2026-03-31T23:59:00+07:00") });
    await openApp(page);
    await page.clock.pauseAt(new Date("2026-03-31T23:59:30+07:00"));
    await addTortoise(page, { name: "Kuro", species: "Leopard" });
    await page.locator("#addC").click();
    const dlg = page.locator("#cDlg");
    await dlg.locator("[name=soaked]").check();
    await dlg.getByRole("button", { name: "Save care" }).click();
    await expect(dlg).toBeHidden();
    await page.getByRole("button", { name: "All tortoises" }).click();
    const card = page.locator(".t-card", { hasText: "Kuro" });
    await expect(card).toContainText("Last soaked today");

    // No visibility change: the app stays on screen while midnight passes.
    await markNode(page, ".t-list");
    await page.clock.runFor(61_000);
    expect(await dayISO(page)).toBe("2026-04-01");
    await expect(card).toContainText("Last soaked yesterday");
    expect(await markedNodeShown(page)).toBe(false);

    // Later checks on the same day draw nothing again.
    await markNode(page, ".t-list");
    await page.clock.runFor(180_000);
    expect(await markedNodeShown(page)).toBe(true);

    await card.click();
    const rows = page.locator(".days li button.day");
    await expect(rows.first().locator(".dlabel")).toHaveText("Today1 Apr");
    await expect(rows.nth(1).locator(".dlabel")).toHaveText("Yesterday31 Mar");
    await expect(rows.nth(1).locator(".marks .chip")).toHaveText(["Soaked"]);
  });
});
