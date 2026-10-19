// @ts-check
// E5: backup export / import as a JSON file, compatibility with the prototype's backups, and CSV export of measurements.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { openApp, acceptDialogs, addTortoise, seed, readDb, expectToast, pageToday } = require("./helpers");

/* ---------- Fixtures and helpers local to this spec ---------- */

// A real 1x1 PNG, so the <img> elements showing it are valid.
const PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const CSV_HEADER = "Tortoise,Species,Date,Weight (g),Plastron (cm),Carapace SCL (cm),Notes,Has photo";
const NOT_A_BACKUP = "That isn't a Kulalog backup";

// Backup and CSV don't need the network or the service worker. Chart.js is a deferred script from cdn.jsdelivr.net
// that app.js waits for, so a stalled CDN request left the app unbooted until the test timed out (seen in a trace).
// Block the third-party hosts (the app falls back to "The chart needs an internet connection") and the service worker,
// so these tests don't depend on the internet or on when the worker takes over.
const THIRD_PARTY = /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
test.use({ serviceWorkers: "block" });

// Every test starts the page clock at 10:00 on today's date in Jakarta and lets it run from there, so a run near
// midnight can't change "today" between reading it and checking a file name or a care day.
let clockStart;
test.beforeEach(async ({ page }) => {
  await page.context().route(THIRD_PARTY, r => r.abort());
  const jakartaToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
  clockStart = new Date(`${jakartaToday}T10:00:00+07:00`);
  await page.clock.install({ time: clockStart });
});

const tidOf = page => page.evaluate(() => location.hash.replace(/^#t\//, ""));
// yyyy-mm-dd n days from the page's today.
const dayISO = (page, n) => page.evaluate(n => shiftDay(todayISO(), n), n);
const byId = list => [...list].sort((a, b) => a.id.localeCompare(b.id));
// A backup made without photos writes photo:null on every entry (care records included),
// so a missing photo and a null photo mean the same thing when comparing records.
const sameRecords = list => byId(list).map(e => { const c = { ...e }; if(c.photo == null) delete c.photo; return c; });

// The toast keeps its last text after it fades out; empty it so the next assertion can't pass on an old message.
const clearToast = page => page.evaluate(() => { const t = document.getElementById("toast"); t.textContent = ""; t.classList.remove("show"); });
// Exact toast text ("Exported 1 measurement" must not pass on "Exported 1 measurements").
const toastIs = (page, text) => expect(page.locator("#toast")).toHaveText(text);
// The import toast with these counts. Singular forms are accepted too, so only the APP BUG test below
// fails on "Imported 1 tortoises and 1 entries" and flips once the app gets the grammar right.
const expectImported = (page, tortoises, entries) =>
  expect(page.locator("#toast")).toHaveText(new RegExp(`^Imported ${tortoises} tortoises? and ${entries} entr(y|ies)$`));

let downloadNo = 0;
// Click something that downloads a file; returns the suggested name and the saved bytes.
async function download(page, trigger){
  await clearToast(page);
  const [dl] = await Promise.all([page.waitForEvent("download"), trigger.click()]);
  const name = dl.suggestedFilename();
  const dir = test.info().outputPath(`download-${++downloadNo}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  await dl.saveAs(file);
  return { name, file, buffer: fs.readFileSync(file) };
}

async function openSettings(page){
  const dlg = page.locator("#sDlg");
  if(!(await dlg.isVisible())) await page.getByRole("button", { name: "Settings and backup" }).click();
  await expect(dlg).toBeVisible();
  return dlg;
}
async function closeSettings(page){
  const dlg = page.locator("#sDlg");
  if(await dlg.isVisible()) await dlg.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dlg).toBeHidden();
}

// Settings > Export backup (.json), with "Include photos" set as asked. Returns the file and its parsed JSON.
async function exportBackup(page, { photos }){
  const dlg = await openSettings(page);
  await dlg.locator("#incPhotos").setChecked(photos);
  const out = await download(page, dlg.getByRole("button", { name: "Export backup (.json)" }));
  await toastIs(page, "Backup saved. Keep the file somewhere safe.");
  return { ...out, json: JSON.parse(out.buffer.toString("utf8")) };
}

// Would a file picker filtered by this `accept` attribute offer the file? (HTML rules: ".ext", "type/*" or an exact MIME type.)
function pickerAccepts(accept, { name, mimeType }){
  if(!accept) return true;
  const lower = name.toLowerCase(), mime = mimeType.toLowerCase();
  return accept.split(",").map(s => s.trim().toLowerCase()).filter(Boolean).some(tok =>
    tok.startsWith(".") ? lower.endsWith(tok) : tok.endsWith("/*") ? mime.startsWith(tok.slice(0, -1)) : mime === tok);
}

// Settings > Import backup with a file path or { name, mimeType, buffer }.
async function importFile(page, file){
  await clearToast(page);
  const dlg = await openSettings(page);
  const input = dlg.locator("#importFile");
  // setInputFiles skips the picker's file-type filter, so check the keeper could pick this file at all.
  const picked = typeof file === "string" ? { name: path.basename(file), mimeType: "application/json" } : file;
  expect(pickerAccepts(await input.getAttribute("accept"), picked), `the Import backup picker offers ${picked.name}`).toBe(true);
  await input.setInputFiles(file);
}
const textFile = (name, text, mimeType = "application/json") => ({ name, mimeType, buffer: Buffer.from(text, "utf8") });

// Daily care for today, through the care dialog. Works in the app and in the prototype (same markup).
async function logCare(page, { soaked = false, foods = [], poop, notes } = {}){
  await page.locator("#addC").click();
  const dlg = page.locator("#cDlg");
  await expect(dlg).toBeVisible();
  if(soaked) await dlg.locator("[name=soaked]").check();
  for(const f of foods) await dlg.locator("#foodChips label", { hasText: f }).click();
  if(poop) await dlg.locator("[name=poop]").selectOption(poop);
  if(notes) await dlg.locator("[name=notes]").fill(notes);
  await dlg.getByRole("button", { name: "Save care" }).click();
  await expect(dlg).toBeHidden();
}

// A measurement through the measurement dialog (date defaults to today).
async function logMeasurement(page, { date, plastron, scl, weight, unit = "g", notes } = {}){
  await page.locator("#addM").click();
  const dlg = page.locator("#mDlg");
  await expect(dlg).toBeVisible();
  if(date) await dlg.locator("[name=date]").fill(date);
  if(plastron) await dlg.locator("[name=plastron]").fill(plastron);
  if(scl) await dlg.locator("[name=scl]").fill(scl);
  if(weight){ await dlg.locator("[name=weight]").fill(weight); await dlg.locator("[name=wunit]").selectOption(unit); }
  if(notes) await dlg.locator("[name=notes]").fill(notes);
  await dlg.getByRole("button", { name: "Save measurement" }).click();
  await expect(dlg).toBeHidden();
}

async function goHome(page){
  await page.getByRole("button", { name: "All tortoises" }).click();
  await expect(page.locator(".home-head h1")).toHaveText("Your tortoises");
}
async function openTortoiseCard(page, name){
  await page.locator(".t-card", { hasText: name }).click();
  await expect(page.locator(".profile h1")).toHaveText(name);
}
const showTab = (page, name) => page.getByRole("tab", { name, exact: true }).click();
const timeline = page => page.locator("#panel .timeline .entry");
const careDay = (page, iso) => page.locator(`#panel [data-day="${iso}"]`);

// Minimal RFC 4180 reader: quoted cells, doubled quotes, commas and line breaks inside quotes, CRLF rows.
function parseCsv(text){
  const rows = []; let row = [], cell = "", quoted = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(quoted){
      if(c === '"'){ if(text[i + 1] === '"'){ cell += '"'; i++; } else quoted = false; }
      else cell += c;
    }else if(c === '"') quoted = true;
    else if(c === ","){ row.push(cell); cell = ""; }
    else if(c === "\r" && text[i + 1] === "\n"){ row.push(cell); rows.push(row); row = []; cell = ""; i++; }
    else cell += c;
  }
  row.push(cell); rows.push(row);
  return rows;
}
function readCsv(buffer){
  expect([...buffer.subarray(0, 3)], "CSV starts with a UTF-8 BOM so Excel reads it as UTF-8").toEqual([0xef, 0xbb, 0xbf]);
  const text = buffer.toString("utf8").replace(/^﻿/, "");
  expect(text.split("\r\n")[0]).toBe(CSV_HEADER);
  return { text, rows: parseCsv(text) };
}

/* ---------- JSON backup: export ---------- */

test("Export backup (.json) downloads kulalog-backup-<today>.json with the tortoise and every entry; photos only with Include photos", async ({ page }) => {
  await openApp(page);
  await addTortoise(page, { name: "Kuro", species: "Leopard", sex: "Female", birth: "2023-05-14" });
  const tid = await tidOf(page);
  const today = await pageToday(page);
  await logCare(page, { soaked: true, foods: ["Leafy greens"], notes: "Ate well" });
  await logMeasurement(page, { plastron: "12.5", scl: "14.2", weight: "450", notes: "Smooth growth" });
  await seed(page, { entries: [
    { id: "m_photo", kind: "measure", tortoiseId: tid, date: await dayISO(page, -14), createdAt: 1700000000000,
      plastron: 11.8, scl: 13.1, weightG: 402.5, photo: PHOTO, notes: "First photo" }
  ]});
  const db = await readDb(page);
  expect(db.tortoises).toHaveLength(1);
  expect(db.entries).toHaveLength(3);
  expect(db.entries.map(e => e.kind).sort()).toEqual(["care", "measure", "measure"]);

  // Photos are left out by default.
  const dlg = await openSettings(page);
  await expect(dlg.locator("#incPhotos")).not.toBeChecked();
  const plain = await exportBackup(page, { photos: false });
  expect(plain.name).toBe(`kulalog-backup-${today}.json`);
  expect(plain.json.app).toBe("kulalog");
  expect(plain.json.version).toBe(1);
  expect(new Date(plain.json.exported).toISOString()).toBe(plain.json.exported);
  const pageNow = await page.evaluate(() => Date.now());
  expect(Math.abs(Date.parse(plain.json.exported) - pageNow)).toBeLessThan(5 * 60_000);
  expect(plain.json.tortoises).toEqual(db.tortoises);
  expect(byId(plain.json.entries)).toEqual(byId(db.entries).map(e => ({ ...e, photo: null })));
  expect(plain.json.entries.every(e => e.photo === null)).toBe(true);

  // Include photos: entries go out exactly as stored, photo data URL included.
  const full = await exportBackup(page, { photos: true });
  expect(full.name).toBe(`kulalog-backup-${today}.json`);
  expect(full.json).toMatchObject({ app: "kulalog", version: 1 });
  expect(full.json.tortoises).toEqual(db.tortoises);
  expect(byId(full.json.entries)).toEqual(byId(db.entries));
  expect(full.json.entries.find(e => e.id === "m_photo").photo).toBe(PHOTO);
  expect(full.buffer.length).toBeGreaterThan(plain.buffer.length);
});

/* ---------- JSON backup: import ---------- */

test("round trip: export, delete the tortoise, import the file brings everything back with the same ids", async ({ page }) => {
  acceptDialogs(page);
  await openApp(page);
  await addTortoise(page, { name: "Kuro", species: "Leopard", sex: "Female", birth: "2023-05-14" });
  const tid = await tidOf(page);
  const today = await pageToday(page);
  const d3 = await dayISO(page, -3), d20 = await dayISO(page, -20);
  await logCare(page, { soaked: true, foods: ["Leafy greens", "Flowers"], poop: "Normal, firm", notes: "Ate well" });
  await logMeasurement(page, { plastron: "12.5", scl: "14.2", weight: "450", notes: "Smooth growth" });
  await seed(page, { entries: [
    { id: "m_rt_old", kind: "measure", tortoiseId: tid, date: d20, createdAt: 1700000000000, plastron: 11.9, scl: 13.4, weightG: 410, photo: null, notes: "" },
    { id: `c_${tid}_${d3}`, kind: "care", tortoiseId: tid, date: d3, createdAt: 1700000000001,
      soaked: true, food: ["Weeds"], foodNote: "dandelion", poop: "", urates: "Clear / liquid", notes: "" }
  ]});
  const before = await readDb(page);
  expect(before.tortoises).toHaveLength(1);
  expect(before.entries).toHaveLength(4);

  const backup = await exportBackup(page, { photos: false });
  expect(backup.json.entries).toHaveLength(4);
  await closeSettings(page);

  await page.getByRole("button", { name: "Delete Kuro" }).click();
  await expect(page.getByRole("heading", { name: "Start your first logbook" })).toBeVisible();
  expect(await readDb(page)).toEqual({ tortoises: [], entries: [] });

  await importFile(page, backup.file);
  await expectImported(page, 1, 4);
  await expect(page.locator("#sDlg")).toBeHidden();

  // IndexedDB: the same tortoise and the same records under the same ids.
  const after = await readDb(page);
  expect(after.tortoises).toEqual(before.tortoises);
  expect(sameRecords(after.entries)).toEqual(sameRecords(before.entries));

  // UI: the tortoise is back on the home screen with its care days and its measurements.
  await expect(page.locator(".home-head")).toContainText("1 in your care");
  await openTortoiseCard(page, "Kuro");
  await expect(page.locator(".profile")).toContainText("Leopard");
  await showTab(page, "Daily care");
  const todayRow = careDay(page, today);
  for(const s of ["Soaked", "Leafy greens, Flowers", "Poop: Normal, firm", "Ate well"]) await expect(todayRow).toContainText(s);
  const d3Row = careDay(page, d3);
  for(const s of ["Soaked", "Weeds, dandelion", "Urates: Clear / liquid"]) await expect(d3Row).toContainText(s);
  await showTab(page, "Growth");
  await expect(timeline(page)).toHaveCount(2);
  for(const s of ["450 g", "12.5 cm", "14.2 cm", "Smooth growth"]) await expect(timeline(page).nth(0)).toContainText(s);
  for(const s of ["410 g", "11.9 cm", "13.4 cm"]) await expect(timeline(page).nth(1)).toContainText(s);

  // The restored records are really stored, not just in memory.
  await page.reload();
  await expect(page.locator(".profile h1")).toHaveText("Kuro");
  expect(await readDb(page)).toEqual(after);
});

test("a backup made with Include photos restores the photos after the tortoise was deleted", async ({ page }) => {
  acceptDialogs(page);
  await openApp(page);
  await addTortoise(page, { name: "Kuro" });
  const tid = await tidOf(page);
  await seed(page, { entries: [
    { id: "m_photo", kind: "measure", tortoiseId: tid, date: await dayISO(page, -7), createdAt: 1700000000000, plastron: 10.5, scl: null, weightG: 380, photo: PHOTO, notes: "With photo" },
    { id: "m_plain", kind: "measure", tortoiseId: tid, date: await dayISO(page, -1), createdAt: 1700000000001, plastron: 10.8, scl: null, weightG: 392, photo: null, notes: "" }
  ]});
  const before = await readDb(page);
  const backup = await exportBackup(page, { photos: true });
  expect(backup.json.entries.find(e => e.id === "m_photo").photo).toBe(PHOTO);
  await closeSettings(page);

  await page.getByRole("button", { name: "Delete Kuro" }).click();
  await expect(page.getByRole("heading", { name: "Start your first logbook" })).toBeVisible();
  expect((await readDb(page)).entries).toEqual([]);

  await importFile(page, backup.file);
  await expectImported(page, 1, 2);
  const after = await readDb(page);
  expect(after).toEqual(before);
  expect(after.entries.find(e => e.id === "m_photo").photo).toBe(PHOTO);

  await expect(page.locator(".t-card .hex img")).toHaveAttribute("src", PHOTO);
  await openTortoiseCard(page, "Kuro");
  await showTab(page, "Growth");
  await expect(timeline(page)).toHaveCount(2);
  await expect(page.locator("#panel img.entry-photo")).toHaveCount(1);
  await expect(page.locator("#panel img.entry-photo")).toHaveAttribute("src", PHOTO);
});

test("importing a backup made without photos keeps the photo already on the device", async ({ page }) => {
  await openApp(page);
  await addTortoise(page, { name: "Kuro" });
  const tid = await tidOf(page);
  await seed(page, { entries: [
    { id: "m_photo", kind: "measure", tortoiseId: tid, date: await dayISO(page, -5), createdAt: 1700000000000, plastron: 11, scl: null, weightG: 500, photo: PHOTO, notes: "Photo day" }
  ]});
  const backup = await exportBackup(page, { photos: false });
  expect(backup.json.entries).toHaveLength(1);
  expect(backup.json.entries[0].photo).toBeNull();
  await closeSettings(page);

  // Change the measurement after the backup, so the import visibly replaces it.
  await showTab(page, "Growth");
  await page.locator('[data-edit="m_photo"]').click();
  const mDlg = page.locator("#mDlg");
  await expect(mDlg).toBeVisible();
  await mDlg.locator("[name=weight]").fill("520");
  await mDlg.getByRole("button", { name: "Save measurement" }).click();
  await expect(mDlg).toBeHidden();
  let entry = (await readDb(page)).entries.find(e => e.id === "m_photo");
  expect(entry).toMatchObject({ weightG: 520, photo: PHOTO });

  await importFile(page, backup.file);
  await expectImported(page, 1, 1);
  entry = (await readDb(page)).entries.find(e => e.id === "m_photo");
  expect(entry).toMatchObject({ weightG: 500, notes: "Photo day", photo: PHOTO });

  await expect(page.locator(".profile h1")).toHaveText("Kuro");
  await expect(timeline(page)).toHaveCount(1);
  await expect(timeline(page).first()).toContainText("500 g");
  await expect(page.locator("#panel img.entry-photo")).toHaveAttribute("src", PHOTO);
  await expect(page.locator(".profile .hex img")).toHaveAttribute("src", PHOTO);
});

test("importing merges: records that aren't in the backup are kept, matching ones are updated", async ({ page }) => {
  await openApp(page);
  await addTortoise(page, { name: "Kuro" });
  const kuro = await tidOf(page);
  const d10 = await dayISO(page, -10), d1 = await dayISO(page, -1);
  const inBackup = { id: "m_kuro_1", kind: "measure", tortoiseId: kuro, date: d10, createdAt: 1700000000000, plastron: 10, scl: 11, weightG: 300, photo: null, notes: "In the backup" };
  await seed(page, { entries: [
    inBackup,
    { id: `c_${kuro}_${d1}`, kind: "care", tortoiseId: kuro, date: d1, createdAt: 1700000000001, soaked: true, food: ["Weeds"], foodNote: "", poop: "", urates: "", notes: "" }
  ]});
  const backup = await exportBackup(page, { photos: false });
  expect(backup.json.tortoises.map(t => t.name)).toEqual(["Kuro"]);
  expect(backup.json.entries).toHaveLength(2);
  await closeSettings(page);

  // After the backup: a new measurement, an edited record, Kuro renamed, and a second tortoise with its own care.
  await logMeasurement(page, { weight: "320", notes: "After the backup" });
  await seed(page, { entries: [{ ...inBackup, notes: "Edited after the backup" }] });
  await page.getByRole("button", { name: "Edit details" }).click();
  const tDlg = page.locator("#tDlg");
  await expect(tDlg).toBeVisible();
  await tDlg.locator("[name=name]").fill("Kuro the Great");
  await tDlg.locator("#tSave").click();
  await expect(tDlg).toBeHidden();
  await expect(page.locator(".profile h1")).toHaveText("Kuro the Great");
  await goHome(page);
  await addTortoise(page, { name: "Bima" });
  const bima = await tidOf(page);
  await logCare(page, { soaked: true, notes: "Bima's bath" });
  const before = await readDb(page);
  expect(before.tortoises).toHaveLength(2);
  expect(before.tortoises.find(t => t.id === kuro).name).toBe("Kuro the Great");
  expect(before.entries).toHaveLength(4);

  await importFile(page, backup.file);
  await expectImported(page, 1, 2);
  const after = await readDb(page);

  // Kuro's details are back to the backup's version; Bima, who isn't in the backup, is unchanged.
  expect(byId(after.tortoises)).toEqual(byId([backup.json.tortoises[0], before.tortoises.find(t => t.id === bima)]));
  // No record outside the backup was removed or changed.
  const backupIds = new Set(backup.json.entries.map(e => e.id));
  const untouched = before.entries.filter(e => !backupIds.has(e.id));
  expect(untouched.map(e => e.tortoiseId).sort()).toEqual([bima, kuro].sort());
  for(const e of untouched) expect(after.entries).toContainEqual(e);
  expect(after.entries).toHaveLength(4);
  // The record that is in the backup is back to the backup's version.
  expect(after.entries.find(e => e.id === "m_kuro_1")).toEqual(inBackup);

  // UI: both tortoises, Kuro with the measurement made after the backup and the restored one.
  await expect(page.locator(".profile h1")).toHaveText("Bima");
  await expect(careDay(page, await pageToday(page))).toContainText("Bima's bath");
  await goHome(page);
  await expect(page.locator(".home-head")).toContainText("2 in your care");
  await expect(page.locator(".t-card h2")).toHaveText(["Bima", "Kuro"]);
  await openTortoiseCard(page, "Kuro");
  await showTab(page, "Growth");
  await expect(timeline(page)).toHaveCount(2);
  await expect(timeline(page).nth(0)).toContainText("320 g");
  await expect(timeline(page).nth(0)).toContainText("After the backup");
  await expect(timeline(page).nth(1)).toContainText("300 g");
  await expect(timeline(page).nth(1)).toContainText("In the backup");
});

test("importing a file that isn't a Kulalog backup says so and changes nothing", async ({ page }) => {
  await openApp(page);
  await addTortoise(page, { name: "Kuro" });
  const tid = await tidOf(page);
  await seed(page, { entries: [
    { id: "m_keep", kind: "measure", tortoiseId: tid, date: await dayISO(page, -2), createdAt: 1700000000000, plastron: 9.5, scl: null, weightG: 250, photo: null, notes: "Keep me" }
  ]});
  const before = await readDb(page);
  const settingsBefore = await page.evaluate(() => localStorage.getItem("kulalog-settings"));

  const intruder = { id: "t_intruder", name: "Intruder", species: "Leopard", sex: "Male", birth: null, createdAt: 1 };
  const intruderEntry = { id: "m_intruder", kind: "measure", tortoiseId: "t_intruder", date: "2025-01-01", createdAt: 1, plastron: 5, scl: null, weightG: 99, photo: null, notes: "" };
  const files = [
    textFile("notes.txt", "Kuro ate dandelions today.\r\nSoaked 15 minutes.\r\n", "text/plain"),
    textFile("settings.json", JSON.stringify({ unit: "kg", tab: "growth" })),
    textFile("list.json", JSON.stringify([intruder])),
    textFile("other-app-backup.json", JSON.stringify({ app: "other", version: 1, exported: new Date().toISOString(), tortoises: [intruder], entries: [intruderEntry] })),
    // Shaped like a backup, but without the Kulalog marker: some other tool's export.
    textFile("tortoises-export.json", JSON.stringify({ version: 1, tortoises: [intruder], entries: [intruderEntry] })),
    // Marked as Kulalog, but the tortoises aren't a list.
    textFile("kulalog-backup-broken.json", JSON.stringify({ app: "kulalog", version: 1, tortoises: { [intruder.id]: intruder }, entries: [intruderEntry] })),
    textFile("kulalog-backup-empty.json", ""),
    textFile("kulalog-backup-cut-off.json", JSON.stringify({ app: "kulalog", version: 1, tortoises: [intruder], entries: [intruderEntry] }).slice(0, 60))
  ];
  for(const f of files){
    await test.step(f.name, async () => {
      await importFile(page, f);
      await expect(page.locator("#toast")).toHaveText(NOT_A_BACKUP);
      expect(await readDb(page)).toEqual(before);
    });
  }
  expect(await page.evaluate(() => localStorage.getItem("kulalog-settings"))).toBe(settingsBefore);

  await closeSettings(page);
  await expect(page.locator(".profile h1")).toHaveText("Kuro");
  await goHome(page);
  await expect(page.locator(".home-head")).toContainText("1 in your care");
  await expect(page.locator(".t-card h2")).toHaveText(["Kuro"]);
  await expect(page.locator("#app")).not.toContainText("Intruder");
});

test("a Kulalog backup with damaged records imports the good ones and skips the rest", async ({ page }) => {
  await openApp(page);
  const d = await dayISO(page, -3);
  const tid = "t_damaged_1";
  const patchy = { id: tid, name: "Patchy", species: "Hermann's", sex: "Unknown", birth: null, createdAt: 1733000000000 };
  const good = { id: "m_good_1", kind: "measure", tortoiseId: tid, date: d, createdAt: 1733000000001, plastron: 9, scl: null, weightG: 280, photo: null, notes: "Good record" };
  // e.g. a backup edited by hand, or written by a buggy older version.
  const data = {
    app: "kulalog", version: 1, exported: "2025-12-01T01:02:03.000Z",
    tortoises: [patchy, { name: "No id" }, null],
    entries: [
      good,
      { id: "m_no_date", kind: "measure", tortoiseId: tid, createdAt: 1733000000002, plastron: null, scl: null, weightG: 300, photo: null, notes: "No date" },
      { kind: "measure", tortoiseId: tid, date: d, createdAt: 1733000000003, weightG: 310, notes: "No id" },
      { id: "m_no_owner", kind: "measure", date: d, createdAt: 1733000000004, weightG: 320, notes: "No tortoise" },
      null
    ]
  };
  await importFile(page, textFile("kulalog-backup-damaged.json", JSON.stringify(data)));
  await expectImported(page, 1, 1);
  expect(await readDb(page)).toEqual({ tortoises: [patchy], entries: [good] });

  // The app still works with what was imported.
  await expect(page.locator(".t-card h2")).toHaveText(["Patchy"]);
  await openTortoiseCard(page, "Patchy");
  await showTab(page, "Growth");
  await expect(timeline(page)).toHaveCount(1);
  for(const s of ["280 g", "9.0 cm", "Good record"]) await expect(timeline(page).first()).toContainText(s);
});

// Regression: the import toast had no singular, so a keeper with one tortoise read "Imported 1 tortoises and 1 entries".
test("the import toast says 1 tortoise and 1 entry in the singular", async ({ page }) => {
  await openApp(page);
  const d = await dayISO(page, -1);
  const tortoise = (id, name) => ({ id, name, species: "Leopard", sex: "Unknown", birth: null, createdAt: 1733000000000 });
  const measure = (id, tid) => ({ id, kind: "measure", tortoiseId: tid, date: d, createdAt: 1733000000001, plastron: null, scl: null, weightG: 300, photo: null, notes: "" });
  const backupText = (tortoises, entries) => JSON.stringify({ app: "kulalog", version: 1, exported: "2025-12-01T01:02:03.000Z", tortoises, entries });

  // Plural stays plural.
  await importFile(page, textFile("kulalog-backup-two.json", backupText([tortoise("t_a", "Ayu"), tortoise("t_b", "Bima")], [measure("m_a", "t_a"), measure("m_b", "t_b")])));
  await toastIs(page, "Imported 2 tortoises and 2 entries");
  // One of each reads as one.
  await importFile(page, textFile("kulalog-backup-one.json", backupText([tortoise("t_c", "Cici")], [measure("m_c", "t_c")])));
  await toastIs(page, "Imported 1 tortoise and 1 entry");
});

/* ---------- Backups from the prototype ---------- */

test("old prototype backup: an entry without kind is split into a measurement and that day's care record", async ({ page }) => {
  await openApp(page);
  const d = await dayISO(page, -2), d5 = await dayISO(page, -5);
  const tid = "t_legacy_1";
  const legacy = {
    app: "kulalog", version: 1, exported: "2025-11-02T08:15:00.000Z",
    tortoises: [{ id: tid, name: "Legacy", species: "Leopard", sex: "Female", birth: null, createdAt: 1730000000000 }],
    // First-prototype records: growth and care mixed on one entry, no `kind`.
    entries: [
      { id: "e_legacy_1", tortoiseId: tid, date: d, createdAt: 1730000100000,
        plastron: 10.2, scl: null, weightG: 350, photo: PHOTO,
        soaked: true, food: ["Leafy greens", "Flowers"], foodNote: "dandelion", poop: "Normal, firm", urates: "Soft white paste", notes: "First weigh-in" },
      // Care only: its notes belong to the care record.
      { id: "e_legacy_2", tortoiseId: tid, date: d5, createdAt: 1730000200000,
        plastron: null, scl: null, weightG: null, photo: null,
        soaked: false, food: [], foodNote: "", poop: "", urates: "Gritty / chalky", notes: "Hid all day" }
    ]
  };
  await importFile(page, textFile("kulalog-backup-old.json", JSON.stringify(legacy)));
  await expectImported(page, 1, 2);

  // IndexedDB: one measurement (same id, photo kept) + a care record per day with the deterministic care id,
  // every care field carried over, nothing left without kind.
  const db = await readDb(page);
  expect(db.tortoises).toEqual(legacy.tortoises);
  expect(db.entries.filter(e => !e.kind)).toEqual([]);
  expect(byId(db.entries)).toEqual(byId([
    { id: "e_legacy_1", kind: "measure", tortoiseId: tid, date: d, createdAt: 1730000100000,
      plastron: 10.2, scl: null, weightG: 350, photo: PHOTO, notes: "First weigh-in" },
    { id: `c_${tid}_${d}`, kind: "care", tortoiseId: tid, date: d, createdAt: 1730000100000,
      soaked: true, food: ["Leafy greens", "Flowers"], foodNote: "dandelion", poop: "Normal, firm", urates: "Soft white paste", notes: "" },
    { id: `c_${tid}_${d5}`, kind: "care", tortoiseId: tid, date: d5, createdAt: 1730000200000,
      soaked: false, food: [], foodNote: "", poop: "", urates: "Gritty / chalky", notes: "Hid all day" }
  ]));

  // UI: one measurement with its photo on the Growth tab, a care record on each date.
  await expect(page.locator(".t-card", { hasText: "Legacy" }).locator(".hex img")).toHaveAttribute("src", PHOTO);
  await openTortoiseCard(page, "Legacy");
  await showTab(page, "Growth");
  await expect(timeline(page)).toHaveCount(1);
  await expect(timeline(page).first().locator("time")).toHaveAttribute("datetime", d);
  for(const s of ["350 g", "10.2 cm", "First weigh-in"]) await expect(timeline(page).first()).toContainText(s);
  await expect(page.locator("#panel img.entry-photo")).toHaveAttribute("src", PHOTO);
  await showTab(page, "Daily care");
  const row = careDay(page, d);
  for(const s of ["Soaked", "Leafy greens, Flowers +1", "Poop: Normal, firm", "Urates: Soft white paste"]) await expect(row).toContainText(s);
  await expect(row).not.toContainText("First weigh-in");
  for(const s of ["Urates: Gritty / chalky", "Hid all day"]) await expect(careDay(page, d5)).toContainText(s);
  await expect(page.locator(".stat", { hasText: "Last soaked" })).toContainText("2 days ago");

  // The split is stored, so it is still the same after a reload.
  await page.reload();
  await expect(page.locator(".profile h1")).toHaveText("Legacy");
  expect(await readDb(page)).toEqual(db);
});

test("a backup copied with the original prototype's Copy backup button and saved as .txt imports fine", async ({ page, browser, baseURL }) => {
  const protoUrl = new URL("kulalog.html", String(baseURL)).href;
  // kulalog.html (the original prototype) is kept on the maintainer's computer only: it is not in the repo and not
  // published, because on the live site it would share the app's IndexedDB. Without it this test can't run.
  const proto200 = (await page.request.get(protoUrl)).status() === 200;
  test.skip(!proto200, "kulalog.html (the original prototype) isn't served here; it is kept locally only");
  // The prototype shares the app's origin (and IndexedDB), so run it in its own context.
  const ctx = await browser.newContext({ serviceWorkers: "block", timezoneId: "Asia/Jakarta", locale: "en-GB" });
  let copied, protoDb;
  try{
    await ctx.clock.install({ time: clockStart }); // same day as the app page
    await ctx.route(THIRD_PARTY, r => r.abort());
    // Capture what "Copy backup" writes to the clipboard instead of touching the real clipboard.
    await ctx.addInitScript(() => {
      const clip = { writeText: async t => { window.__copiedBackup = String(t); } };
      Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: () => clip });
    });
    const proto = await ctx.newPage();
    await proto.goto(protoUrl);
    await expect(proto.locator("#app > *").first()).toBeVisible();
    await expect(proto.locator("#copyBackup"), "kulalog.html is the copy-paste prototype").toHaveCount(1);
    await addTortoise(proto, { name: "Proto", species: "Red-footed", sex: "Male", birth: "2022-01-09" });
    await logCare(proto, { soaked: true, foods: ["Fruit"], notes: "From the prototype" });
    await logMeasurement(proto, { plastron: "9.5", weight: "1.2", unit: "kg", notes: "Weighed in the prototype" });
    protoDb = await readDb(proto);
    expect(protoDb.entries).toHaveLength(2);
    await proto.getByRole("button", { name: "Settings and backup" }).click();
    await proto.locator("#copyBackup").click();
    await expectToast(proto, "Backup copied");
    copied = await proto.evaluate(() => window.__copiedBackup);
  }finally{
    await ctx.close();
  }
  expect(copied).toContain('"app":"kulalog"');

  // Paste into a notes app, save as .txt, import that file into the PWA.
  await openApp(page);
  const today = await pageToday(page);
  await importFile(page, textFile("kulalog backup.txt", copied, "text/plain"));
  await expectImported(page, 1, 2);
  const db = await readDb(page);
  expect(db.tortoises).toEqual(protoDb.tortoises);
  expect(sameRecords(db.entries)).toEqual(sameRecords(protoDb.entries));

  await openTortoiseCard(page, "Proto");
  await showTab(page, "Daily care");
  for(const s of ["Soaked", "Fruit", "From the prototype"]) await expect(careDay(page, today)).toContainText(s);
  await showTab(page, "Growth");
  await expect(timeline(page)).toHaveCount(1);
  for(const s of ["1.20 kg", "9.5 cm", "Weighed in the prototype"]) await expect(timeline(page).first()).toContainText(s);
});

test("prototype backup text saved by a notes app (BOM, CRLF, pretty-printed) as .txt imports fine", async ({ page }) => {
  await openApp(page);
  const d = await dayISO(page, -1);
  const tid = "t_notes_1";
  const data = {
    app: "kulalog", version: 1, exported: "2025-12-01T01:02:03.000Z",
    tortoises: [{ id: tid, name: "Notepad", species: "Hermann's", sex: "Unknown", birth: null, createdAt: 1733000000000 }],
    entries: [
      { id: `c_${tid}_${d}`, kind: "care", tortoiseId: tid, date: d, createdAt: 1733000000001, soaked: true, food: ["Weeds"], foodNote: "", poop: "", urates: "", notes: "", photo: null },
      { id: "m_notes_1", kind: "measure", tortoiseId: tid, date: d, createdAt: 1733000000002, plastron: 8.4, scl: 9.1, weightG: 210, photo: null, notes: "" }
    ]
  };
  const text = "﻿" + JSON.stringify(data, null, 2).replace(/\n/g, "\r\n") + "\r\n";
  await importFile(page, textFile("Kulalog backup.txt", text, "text/plain"));
  await expectImported(page, 1, 2);
  const db = await readDb(page);
  expect(db.tortoises).toEqual(data.tortoises);
  expect(byId(db.entries)).toEqual(byId(data.entries));
  await openTortoiseCard(page, "Notepad");
  await showTab(page, "Growth");
  await expect(timeline(page)).toHaveCount(1);
  await expect(timeline(page).first()).toContainText("210 g");
});

/* ---------- CSV export ---------- */

test("Export measurements (.csv) downloads every measurement with a BOM, a header row, grams and quoted notes", async ({ page }) => {
  await openApp(page);
  await addTortoise(page, { name: "Si Kuro Jr.", species: "Sulcata (African spurred)" });
  const kuro = await tidOf(page);
  const today = await pageToday(page);
  const d30 = await dayISO(page, -30), d10 = await dayISO(page, -10);
  // Weight typed in kg must come out in grams.
  await logMeasurement(page, { weight: "1.25", unit: "kg", plastron: "20.5", scl: "23", notes: 'Shell "smooth", rings: 3' });
  await goHome(page);
  await addTortoise(page, { name: "Bima, the big one", species: "Leopard" });
  const bima = await tidOf(page);
  await seed(page, { entries: [
    { id: "m_k_old", kind: "measure", tortoiseId: kuro, date: d30, createdAt: 1700000000000, plastron: 18.2, scl: null, weightG: 980.5, photo: PHOTO, notes: "Line one\nLine two" },
    { id: "m_b_1", kind: "measure", tortoiseId: bima, date: d10, createdAt: 1700000000001, plastron: null, scl: 30.1, weightG: 2400, photo: null, notes: "=1+1 is not a formula" },
    { id: `c_${kuro}_${d10}`, kind: "care", tortoiseId: kuro, date: d10, createdAt: 1700000000002, soaked: true, food: [], foodNote: "", poop: "", urates: "", notes: "care, not a measurement" }
  ]});

  const dlg = await openSettings(page);
  const csv = await download(page, dlg.getByRole("button", { name: "Export measurements (.csv)" }));
  expect(csv.name).toBe(`kulalog-measurements-${today}.csv`);
  await toastIs(page, "Exported 3 measurements");
  const { text, rows } = readCsv(csv.buffer);
  // One row per measurement, tortoises by name, oldest first; care records are not measurements.
  expect(rows).toEqual([
    CSV_HEADER.split(","),
    ["Bima, the big one", "Leopard", d10, "2400", "", "30.1", "'=1+1 is not a formula", "no"],
    ["Si Kuro Jr.", "Sulcata (African spurred)", d30, "980.5", "18.2", "", "Line one\nLine two", "yes"],
    ["Si Kuro Jr.", "Sulcata (African spurred)", today, "1250", "20.5", "23", 'Shell "smooth", rings: 3', "no"]
  ]);
  // Commas, quotes and line breaks are quoted the CSV way.
  expect(text).toContain('"Bima, the big one",Leopard,');
  expect(text).toContain(',"Shell ""smooth"", rings: 3",');
  expect(text).toContain(',"Line one\nLine two",');
  expect(text).not.toContain("care, not a measurement");
});

test("with no measurements, Export measurements (.csv) says so and downloads nothing", async ({ page }) => {
  const downloads = [];
  page.on("download", d => downloads.push(d.suggestedFilename()));
  await openApp(page);
  const exportBtn = page.locator("#sDlg").getByRole("button", { name: "Export measurements (.csv)" });

  // No tortoises at all.
  await clearToast(page);
  await openSettings(page);
  await exportBtn.click();
  await expect(page.locator("#toast")).toHaveText("No measurements to export yet");
  await closeSettings(page);

  // A tortoise with daily care but no measurements.
  await addTortoise(page, { name: "Kuro" });
  await logCare(page, { soaked: true });
  await showTab(page, "Growth");
  await expect(page.getByRole("button", { name: "Export CSV", exact: true })).toHaveCount(0);
  await clearToast(page);
  await openSettings(page);
  await exportBtn.click();
  await expect(page.locator("#toast")).toHaveText("No measurements to export yet");
  await closeSettings(page);

  // Control: with a measurement the same button downloads, and that is the only download of the test.
  await logMeasurement(page, { weight: "450" });
  await openSettings(page);
  const csv = await download(page, exportBtn);
  await toastIs(page, "Exported 1 measurement");
  expect(downloads).toEqual([csv.name]);
});

test("Growth tab Export CSV downloads kulalog-measurements-<slug>-<today>.csv with only that tortoise", async ({ page }) => {
  await openApp(page);
  await addTortoise(page, { name: "Si Kuro Jr." });
  const kuro = await tidOf(page);
  const today = await pageToday(page);
  const d20 = await dayISO(page, -20);
  await logMeasurement(page, { weight: "450", plastron: "12.5", notes: "Kuro, today" });
  await goHome(page);
  await addTortoise(page, { name: "Bima" });
  await logMeasurement(page, { weight: "2.4", unit: "kg", notes: "Bima only" });
  await seed(page, { entries: [
    { id: "m_k_old", kind: "measure", tortoiseId: kuro, date: d20, createdAt: 1700000000000, plastron: 12.1, scl: null, weightG: 400, photo: null, notes: "" }
  ]});

  await goHome(page);
  await openTortoiseCard(page, "Si Kuro Jr.");
  await showTab(page, "Growth");
  await expect(timeline(page)).toHaveCount(2);
  const csv = await download(page, page.getByRole("button", { name: "Export CSV", exact: true }));
  expect(csv.name).toBe(`kulalog-measurements-si-kuro-jr-${today}.csv`);
  await toastIs(page, "Exported 2 measurements");
  const { text, rows } = readCsv(csv.buffer);
  expect(rows).toEqual([
    CSV_HEADER.split(","),
    ["Si Kuro Jr.", "Sulcata (African spurred)", d20, "400", "12.1", "", "", "no"],
    ["Si Kuro Jr.", "Sulcata (African spurred)", today, "450", "12.5", "", "Kuro, today", "no"]
  ]);
  expect(text).not.toContain("Bima");

  // And the other tortoise's button exports only its own row, in grams even when the app shows kilograms.
  const sDlg = await openSettings(page);
  await sDlg.locator("#unitChips label", { hasText: "Kilograms" }).click();
  await expect(sDlg.getByRole("radio", { name: "Kilograms" })).toBeChecked();
  await closeSettings(page);
  await goHome(page);
  await openTortoiseCard(page, "Bima");
  await showTab(page, "Growth");
  await expect(timeline(page).first()).toContainText("2.40 kg");
  const bimaCsv = await download(page, page.getByRole("button", { name: "Export CSV", exact: true }));
  expect(bimaCsv.name).toBe(`kulalog-measurements-bima-${today}.csv`);
  await toastIs(page, "Exported 1 measurement");
  const bimaRows = readCsv(bimaCsv.buffer).rows;
  expect(bimaRows).toEqual([
    CSV_HEADER.split(","),
    ["Bima", "Sulcata (African spurred)", today, "2400", "", "", "Bima only", "no"]
  ]);
});

/* ---------- File names around midnight ---------- */

test("just after midnight in Jakarta, backup and CSV file names carry the keeper's date, not the UTC date", async ({ page }) => {
  // 00:30 WIB on 1 March is still 28 February in UTC (and in the previous month).
  await page.clock.setFixedTime(new Date("2026-03-01T00:30:00+07:00"));
  await openApp(page);
  expect(await pageToday(page)).toBe("2026-03-01");
  await addTortoise(page, { name: "Kuro" });
  await logMeasurement(page, { weight: "450" });

  const backup = await exportBackup(page, { photos: false });
  expect(backup.name).toBe("kulalog-backup-2026-03-01.json");
  expect(backup.json.exported).toBe("2026-02-28T17:30:00.000Z");
  expect(backup.json.entries.map(e => e.date)).toEqual(["2026-03-01"]);

  const dlg = await openSettings(page);
  const all = await download(page, dlg.getByRole("button", { name: "Export measurements (.csv)" }));
  expect(all.name).toBe("kulalog-measurements-2026-03-01.csv");
  expect(readCsv(all.buffer).rows.slice(1)).toEqual([["Kuro", "Sulcata (African spurred)", "2026-03-01", "450", "", "", "", "no"]]);
  await closeSettings(page);

  await showTab(page, "Growth");
  const one = await download(page, page.getByRole("button", { name: "Export CSV", exact: true }));
  expect(one.name).toBe("kulalog-measurements-kuro-2026-03-01.csv");
  await toastIs(page, "Exported 1 measurement");
});

/* ---------- Plural forms and file names (fix 6) ---------- */

// Regression: the import toast was always plural ("Imported 2 tortoises and 1 entries", "Imported 1 tortoises and 0 entries").
test("the import toast counts each kind on its own: 2 tortoises and 1 entry, 1 tortoise and 0 entries", async ({ page }) => {
  await openApp(page);
  const d = await dayISO(page, -2);
  const tortoise = (id, name) => ({ id, name, species: "Leopard", sex: "Unknown", birth: null, createdAt: 1733000000000 });
  const measure = (id, tid) => ({ id, kind: "measure", tortoiseId: tid, date: d, createdAt: 1733000000001, plastron: null, scl: null, weightG: 300, photo: null, notes: "" });
  const backupText = (tortoises, entries) => JSON.stringify({ app: "kulalog", version: 1, exported: "2025-12-01T01:02:03.000Z", tortoises, entries });

  const ayu = tortoise("t_ayu", "Ayu"), bima = tortoise("t_bima", "Bima"), cici = tortoise("t_cici", "Cici");
  const m = measure("m_ayu", "t_ayu");
  await importFile(page, textFile("kulalog-backup-2t-1e.json", backupText([ayu, bima], [m])));
  await toastIs(page, "Imported 2 tortoises and 1 entry");
  expect(await readDb(page)).toEqual({ tortoises: [ayu, bima], entries: [m] });
  await expect(page.locator(".t-card h2")).toHaveText(["Ayu", "Bima"]);

  await importFile(page, textFile("kulalog-backup-1t-0e.json", backupText([cici], [])));
  await toastIs(page, "Imported 1 tortoise and 0 entries");
  expect(byId((await readDb(page)).tortoises)).toEqual([ayu, bima, cici]);
  expect((await readDb(page)).entries).toEqual([m]);
  await expect(page.locator(".t-card h2")).toHaveText(["Ayu", "Bima", "Cici"]);
});

// Regression: a name without Latin letters gave an empty slug and the file was called kulalog-measurements--<date>.csv.
test("Growth tab Export CSV for a tortoise named in Chinese or Cyrillic downloads kulalog-measurements-<today>.csv, without \"--\"", async ({ page }) => {
  await openApp(page);
  const today = await pageToday(page);
  const exportOne = async name => {
    await addTortoise(page, { name });
    await logMeasurement(page, { weight: "450", notes: name + " today" });
    await expect(page.getByRole("tab", { name: "Growth", exact: true })).toHaveAttribute("aria-selected", "true");
    const csv = await download(page, page.getByRole("button", { name: "Export CSV", exact: true }));
    await toastIs(page, "Exported 1 measurement");
    // The tortoise's own row, with its name intact in the file
    expect(readCsv(csv.buffer).rows.slice(1)).toEqual([[name, "Sulcata (African spurred)", today, "450", "", "", name + " today", "no"]]);
    await goHome(page);
    return csv.name;
  };

  for(const name of ["龟龟", "Кура"]){
    const file = await exportOne(name);
    expect(file, `file name for ${name}`).toBe(`kulalog-measurements-${today}.csv`);
    expect(file).not.toContain("--");
  }
  // A name with Latin letters keeps its slug
  expect(await exportOne("Kuro 2")).toBe(`kulalog-measurements-kuro-2-${today}.csv`);
});
