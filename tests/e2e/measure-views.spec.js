// @ts-check
// E3 (measurements, chart, photos, weight unit), E4 (daily care views, month grid, tab persistence)
// and dark mode colours. Runs in both Playwright projects (desktop Chrome and Pixel 7 emulation).
const { test, expect } = require("@playwright/test");
const { openApp, addTortoise, seed, readDb, expectToast, pageToday } = require("./helpers");

/* ---------- Local helpers ---------- */

// A 2x2 RGB PNG (red, green / blue, yellow pixels), built for this test.
const PNG_2X2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGM4IScnt0CDQc7mxIcTGgAefATt9BahUQAAAABJRU5ErkJggg==",
  "base64"
);
const PNG_2X2_URL = "data:image/png;base64," + PNG_2X2.toString("base64");
// A second tiny PNG (1x1), so two photos can be told apart by their data URL.
const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_MS = 864e5;

// Calendar arithmetic on yyyy-mm-dd strings, independent of the app's own date helpers.
function addDays(iso, n){
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function monthOf(iso, n = 0){
  const [y, m] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1 };
}
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const mondayOffset = (y, m) => (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;

// A tortoise and records in the same shape the app stores (and a backup holds).
const T = { id: "t-shelly", name: "Shelly", species: "Leopard", sex: "Female", birth: null, createdAt: 1700000000000 };
let created = 1700000000000;
function measure(id, date, fields = {}){
  return { id, tortoiseId: T.id, kind: "measure", date, createdAt: ++created,
    plastron: null, scl: null, weightG: null, photo: null, notes: "", ...fields };
}
function care(date, fields = {}){
  return { id: "c_" + T.id + "_" + date, tortoiseId: T.id, kind: "care", date, createdAt: ++created,
    soaked: false, food: [], foodNote: "", poop: "", urates: "", notes: "", ...fields };
}

// Open the app, optionally preset settings, seed records and land on the seeded tortoise's page.
async function openSeeded(page, { entries = [], settings } = {}){
  await openApp(page, "#t/" + T.id);
  const today = await pageToday(page);
  const list = typeof entries === "function" ? entries(today) : entries;
  if(settings) await page.evaluate(s => localStorage.setItem("kulalog-settings", JSON.stringify(s)), settings);
  await seed(page, { tortoises: [T], entries: list });
  await expect(page.locator(".profile h1")).toHaveText(T.name);
  return today;
}

const storedSettings = page => page.evaluate(() => JSON.parse(localStorage.getItem("kulalog-settings") || "{}"));

// Every test reads "today" from the page once and compares against it. Freeze the page clock at the real time so a run
// that crosses midnight (Asia/Jakarta) can't move the app to the next day half way through. Timers keep running.
// Tests that need a particular date set their own fixed time before opening the app.
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date());
});


// Natural size of an image data URL, decoded by the page.
const imageSize = (page, src) => page.evaluate(src => new Promise((res, rej) => {
  const img = new Image(); img.onload = () => res([img.naturalWidth, img.naturalHeight]); img.onerror = () => rej(new Error("not an image")); img.src = src;
}), src);

// A flat-coloured PNG of the given size, drawn by the page's canvas.
async function pngOfSize(page, w, h){
  const url = await page.evaluate(([w, h]) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d"); g.fillStyle = "#6a8f3c"; g.fillRect(0, 0, w, h); g.fillStyle = "#a8731f"; g.fillRect(0, 0, w / 2, h / 2);
    return c.toDataURL("image/png");
  }, [w, h]);
  return Buffer.from(url.split(",")[1], "base64");
}

async function openMeasureDialog(page){
  await page.locator("#addM").click();
  const dlg = page.locator("#mDlg");
  await expect(dlg).toBeVisible();
  return dlg;
}
const saveMeasure = dlg => dlg.getByRole("button", { name: "Save measurement" }).click();
// The toast keeps its last text after it fades, so empty it before a step that should show the same message again.
const clearToast = page => page.evaluate(() => { const t = document.getElementById("toast"); t.textContent = ""; t.classList.remove("show"); });

// Growth stats tile by its label ("Weight", "Plastron", "Carapace").
const stat = (page, label) => page.locator("#panel .stats .stat").filter({ has: page.locator(".k", { hasText: new RegExp("^" + label + "$") }) });
// Value of one number ("Weight", "Plastron", "Carapace") inside a timeline entry.
const entryVal = (entry, label) => entry.locator(".entry-nums span").filter({ hasText: label }).locator("b");

// A CSS colour (e.g. "var(--danger)") resolved by the page to the "rgb(...)" form getComputedStyle reports.
const cssColour = (page, value) => page.evaluate(v => {
  const el = document.createElement("span"); el.style.color = v; document.body.appendChild(el);
  const c = getComputedStyle(el).color; el.remove(); return c;
}, value);

// What Chart.js currently draws on #cv, or null when there is no chart.
function chartInfo(page){
  return page.evaluate(() => {
    if(typeof Chart === "undefined") return null;
    const c = Chart.getChart("cv");
    if(!c) return null;
    const ds = c.data.datasets[0];
    const tip = c.options.plugins.tooltip.callbacks;
    return {
      id: c.id,
      xs: ds.data.map(p => p.x),
      ys: ds.data.map(p => p.y),
      // What the tooltip of each point says when it is hovered or tapped: its date and value with the unit
      tips: ds.data.map(p => tip.title([{ parsed: p }]) + ":" + tip.label({ parsed: p })),
      yTitle: c.options.scales.y.title.text,
      label: c.canvas.getAttribute("aria-label"),
      border: ds.borderColor
    };
  });
}

/* ================================================================
   E3: measurements
   ================================================================ */
test.describe("E3 measurements", () => {

  test("validation: an empty form, words, zero and negative numbers are rejected and nothing is saved", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    const dlg = await openMeasureDialog(page);
    const err = page.locator("#mErr");
    await expect(err).toBeHidden();

    // Empty form
    await saveMeasure(dlg);
    await expect(err).toBeVisible();
    await expect(err).toHaveText("Enter at least one measurement or add a photo.");
    await expect(dlg).toBeVisible();

    // Text instead of a number, in each field
    await dlg.locator("[name=plastron]").fill("abc");
    await saveMeasure(dlg);
    await expect(err).toHaveText(/^Check the .+: use a number like 12\.5$/);
    await expect(err).toHaveText("Check the plastron length: use a number like 12.5");

    await dlg.locator("[name=plastron]").fill("12.5");
    await dlg.locator("[name=scl]").fill("abc");
    await saveMeasure(dlg);
    await expect(err).toHaveText("Check the carapace length: use a number like 12.5");

    await dlg.locator("[name=scl]").fill("");
    await dlg.locator("[name=weight]").fill("abc");
    await saveMeasure(dlg);
    await expect(err).toHaveText("Check the weight: use a number like 12.5");

    // Zero and negative values are not measurements either
    await dlg.locator("[name=weight]").fill("0");
    await saveMeasure(dlg);
    await expect(err).toHaveText("Check the weight: use a number like 12.5");
    await dlg.locator("[name=weight]").fill("-3");
    await saveMeasure(dlg);
    await expect(err).toHaveText("Check the weight: use a number like 12.5");
    await expect(dlg).toBeVisible();

    // Nothing reached IndexedDB
    expect((await readDb(page)).entries).toHaveLength(0);

    // Cancel: still on Daily care, Growth has no measurements
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.locator("#tab-care")).toHaveAttribute("aria-selected", "true");
    await page.locator("#tab-growth").click();
    await expect(page.locator("#panel")).toContainText("No measurements yet. Log the first one to start the growth chart.");
    await expect(page.locator("#chartArea")).toHaveText("Two weight entries needed to draw the growth line.");

    // Reopening starts clean
    await openMeasureDialog(page);
    await expect(err).toBeHidden();
    await expect(dlg.locator("[name=plastron]")).toHaveValue("");
    await expect(dlg.locator("[name=weight]")).toHaveValue("");
    expect((await readDb(page)).entries).toHaveLength(0);
  });

  test("logs a measurement typed with commas in kg: toast, Growth tab, timeline, and grams/cm in IndexedDB", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    await expect(page.locator("#tab-care")).toHaveAttribute("aria-selected", "true");
    const today = await pageToday(page);

    const dlg = await openMeasureDialog(page);
    await expect(page.locator("#mDlgTitle")).toHaveText("Log measurement");
    await expect(dlg.locator("[name=date]")).toHaveValue(today);
    await expect(dlg.locator("[name=wunit]")).toHaveValue("g");
    await dlg.locator("[name=plastron]").fill("12,5");
    await dlg.locator("[name=scl]").fill("14,2");
    await dlg.locator("[name=weight]").fill("1,2");
    await dlg.locator("[name=wunit]").selectOption("kg");
    await saveMeasure(dlg);

    await expect(dlg).toBeHidden();
    await expectToast(page, "Measurement saved");
    await expect(page.locator("#tab-growth")).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#tab-care")).toHaveAttribute("aria-selected", "false");

    const entries = page.locator(".timeline .entry");
    await expect(entries).toHaveCount(1);
    await expect(entries.first().locator("time")).toHaveAttribute("datetime", today);
    await expect(entryVal(entries.first(), "Weight")).toHaveText("1.20 kg");
    await expect(entryVal(entries.first(), "Plastron")).toHaveText("12.5 cm");
    await expect(entryVal(entries.first(), "Carapace")).toHaveText("14.2 cm");

    // Latest-value stats, no rate yet
    await expect(stat(page, "Weight").locator(".v")).toHaveText("1.20 kg");
    await expect(stat(page, "Plastron").locator(".v")).toHaveText("12.5 cm");
    await expect(stat(page, "Carapace").locator(".v")).toHaveText("14.2 cm");
    await expect(page.locator("#panel .stats .d")).toHaveCount(0);

    // One measurement: the chart asks for one more
    await expect(page.locator("#chartArea")).toHaveText("One more weight entry needed to draw the growth line.");
    await expect(page.locator("#cv")).toHaveCount(0);

    // Stored in grams and cm
    const db = await readDb(page);
    const ms = db.entries.filter(e => e.kind === "measure");
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ tortoiseId: db.tortoises[0].id, date: today, weightG: 1200, plastron: 12.5, scl: 14.2, photo: null });
    expect((await storedSettings(page)).tab).toBe("growth");
  });

  test("stores lengths rounded to 0.1 cm and weights to 0.1 g, with spaces around comma decimals", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    const dlg = await openMeasureDialog(page);
    await dlg.locator("[name=plastron]").fill(" 7,25 ");
    await dlg.locator("[name=scl]").fill("10,04");
    await dlg.locator("[name=weight]").fill(" 0,45678 ");
    await dlg.locator("[name=wunit]").selectOption("kg");
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Measurement saved");

    const ms = (await readDb(page)).entries;
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: "measure", plastron: 7.3, scl: 10, weightG: 456.8 });

    const entry = page.locator(".timeline .entry").first();
    await expect(entryVal(entry, "Weight")).toHaveText("457 g");
    await expect(entryVal(entry, "Plastron")).toHaveText("7.3 cm");
    await expect(entryVal(entry, "Carapace")).toHaveText("10.0 cm");

    // Editing offers the stored values back, the weight in grams because it is under 1 kg
    await entry.getByRole("button", { name: "Edit" }).click();
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("[name=plastron]")).toHaveValue("7.3");
    await expect(dlg.locator("[name=scl]")).toHaveValue("10");
    await expect(dlg.locator("[name=weight]")).toHaveValue("456.8");
    await expect(dlg.locator("[name=wunit]")).toHaveValue("g");
  });

  // Regression: num() used to stop at the first separator, so "1.234,5" g was saved as 1.2 g. Indonesian keepers type
  // thousands with a dot and decimals with a comma; a number with a misplaced separator must be asked for again.
  test("a weight typed with a thousands dot and a decimal comma (1.234,5 g) is stored in full; 12,5,3 is rejected", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    const dlg = await openMeasureDialog(page);
    const err = page.locator("#mErr");
    await expect(dlg.locator("[name=wunit]")).toHaveValue("g");

    // A malformed number is not cut short or glued together, the form asks again
    await dlg.locator("[name=weight]").fill("12,5,3");
    await saveMeasure(dlg);
    await expect(err).toBeVisible();
    await expect(err).toHaveText("Check the weight: use a number like 12.5");
    await expect(dlg).toBeVisible();
    expect((await readDb(page)).entries).toHaveLength(0);

    await dlg.locator("[name=weight]").fill("1.234,5");
    // A field holding only spaces counts as empty, not as a wrong number
    await dlg.locator("[name=plastron]").fill("   ");
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Measurement saved");
    const ms = (await readDb(page)).entries;
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: "measure", weightG: 1234.5, plastron: null, scl: null });
    await expect(entryVal(page.locator(".timeline .entry").first(), "Weight")).toHaveText("1.23 kg");
    await expect(stat(page, "Weight").locator(".v")).toHaveText("1.23 kg");
  });

  test("losses show a negative monthly rate, small gram rates keep a decimal, and values under a week apart show no rate", async ({ page }) => {
    const today = await openSeeded(page, {
      entries: t => [
        measure("m-now", t, { weightG: 450, scl: 11.7 }),
        measure("m-mid", addDays(t, -6), { weightG: 470, scl: 12 })
      ],
      settings: { tab: "growth" }
    });
    // Two values six days apart: the chart draws, but there is no rate yet
    await expect.poll(() => chartInfo(page).then(c => c && c.ys)).toEqual([470, 450]);
    expect((await chartInfo(page)).yTitle).toBe("g");
    await expect(stat(page, "Weight").locator(".v")).toHaveText("450 g");
    await expect(page.locator("#panel .stats .d")).toHaveCount(0);

    // Exactly a week is enough: (450 - 471) g over 7 days. The carapace values are still only 6 days apart.
    let dlg = await openMeasureDialog(page);
    await dlg.locator("[name=date]").fill(addDays(today, -7));
    await dlg.locator("[name=weight]").fill("471");
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    await expect(page.locator(".timeline .entry")).toHaveCount(3);
    await expect(stat(page, "Weight").locator(".d")).toHaveText("−90 g per month");
    await expect(stat(page, "Carapace").locator(".d")).toHaveCount(0);

    // An older measurement 60 days back: (450 - 465) g and (11.7 - 12) cm over 60 days
    dlg = await openMeasureDialog(page);
    await dlg.locator("[name=date]").fill(addDays(today, -60));
    await dlg.locator("[name=weight]").fill("465");
    await dlg.locator("[name=scl]").fill("12");
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();

    await expect(page.locator(".timeline .entry")).toHaveCount(4);
    await expect.poll(() => chartInfo(page).then(c => c && c.ys)).toEqual([465, 471, 470, 450]);
    const w = stat(page, "Weight").locator(".d"), c = stat(page, "Carapace").locator(".d");
    await expect(w).toHaveText("−7.5 g per month");
    await expect(w).toHaveClass(/\bneg\b/);
    await expect(c).toHaveText("−0.15 cm per month");
    await expect(c).toHaveClass(/\bneg\b/);
    // A loss is shown in the warning colour, not the green of a gain
    const danger = await cssColour(page, "var(--danger)");
    expect(danger).not.toBe(await cssColour(page, "var(--leaf)"));
    await expect(w).toHaveCSS("color", danger);
    await expect(c).toHaveCSS("color", danger);
    await expect(stat(page, "Plastron").locator(".d")).toHaveCount(0);
    await expect(stat(page, "Plastron").locator(".v")).toHaveText("–");
  });

  test("a second, older measurement draws the chart and a monthly rate; metric buttons switch and redraw", async ({ page }) => {
    const today = await openSeeded(page, {
      entries: t => [measure("m-now", t, { weightG: 1200, plastron: 12.5, scl: 14.2 })],
      settings: { tab: "growth" }
    });
    await expect(page.locator("#chartArea")).toHaveText("One more weight entry needed to draw the growth line.");
    const older = addDays(today, -60);

    const dlg = await openMeasureDialog(page);
    await dlg.locator("[name=date]").fill(older);
    await dlg.locator("[name=weight]").fill("900");
    await expect(dlg.locator("[name=wunit]")).toHaveValue("g");
    await dlg.locator("[name=plastron]").fill("11");
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Measurement saved");

    // Timeline newest first
    const entries = page.locator(".timeline .entry");
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(0).locator("time")).toHaveAttribute("datetime", today);
    await expect(entries.nth(1).locator("time")).toHaveAttribute("datetime", older);
    await expect(entryVal(entries.nth(1), "Weight")).toHaveText("900 g");
    await expect(entryVal(entries.nth(1), "Plastron")).toHaveText("11.0 cm");
    await expect(entries.nth(1).locator(".entry-nums span").filter({ hasText: "Carapace" })).toHaveCount(0);

    // Stored as typed
    const stored = (await readDb(page)).entries.find(e => e.date === older);
    expect(stored).toMatchObject({ kind: "measure", tortoiseId: T.id, weightG: 900, plastron: 11, scl: null });

    // Chart with two weight points, oldest first, in kg because the heaviest is over 1 kg
    await expect(page.locator("#cv")).toHaveCount(1);
    await expect.poll(() => chartInfo(page).then(c => c && c.ys)).toEqual([0.9, 1.2]);
    let info = await chartInfo(page);
    expect(info.xs).toHaveLength(2);
    expect(info.xs[1] - info.xs[0]).toBe(60 * DAY_MS);
    expect(info.yTitle).toBe("kg");
    expect(info.label).toBe("Growth chart of weight");
    const [olderText, todayText] = [await page.evaluate(d => fmtDate(d), older), await page.evaluate(d => fmtDate(d), today)];
    expect(info.tips).toEqual([olderText + ": 0.90 kg", todayText + ": 1.20 kg"]);

    // Rates per month: (1200 - 900) g over 60 days = +150 g, (12.5 - 11) cm = +0.75 cm, carapace has one value
    await expect(stat(page, "Weight").locator(".v")).toHaveText("1.20 kg");
    await expect(stat(page, "Weight").locator(".d")).toHaveText("+150 g per month");
    await expect(stat(page, "Weight").locator(".d")).not.toHaveClass(/neg/);
    await expect(stat(page, "Weight").locator(".d")).toHaveCSS("color", await cssColour(page, "var(--leaf)"));
    await expect(stat(page, "Plastron").locator(".d")).toHaveText("+0.75 cm per month");
    await expect(stat(page, "Carapace").locator(".d")).toHaveCount(0);

    // Metric buttons
    const seg = page.locator('.seg[aria-label="Chart measurement"]');
    const bWeight = seg.getByRole("button", { name: "Weight" });
    const bPlastron = seg.getByRole("button", { name: "Plastron" });
    const bCarapace = seg.getByRole("button", { name: "Carapace" });
    await expect(bWeight).toHaveAttribute("aria-pressed", "true");
    await expect(bPlastron).toHaveAttribute("aria-pressed", "false");
    await expect(bCarapace).toHaveAttribute("aria-pressed", "false");

    await bPlastron.click();
    await expect(bPlastron).toHaveAttribute("aria-pressed", "true");
    await expect(bWeight).toHaveAttribute("aria-pressed", "false");
    await expect(bCarapace).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => chartInfo(page).then(c => c && c.ys)).toEqual([11, 12.5]);
    const plastronChart = await chartInfo(page);
    expect(plastronChart.id).not.toBe(info.id); // a new chart, not the old one
    expect(plastronChart.yTitle).toBe("cm");
    expect(plastronChart.label).toBe("Growth chart of plastron length");
    expect(plastronChart.tips).toEqual([olderText + ": 11.0 cm", todayText + ": 12.5 cm"]);

    // Only one carapace value: the chart is replaced by the hint
    await bCarapace.click();
    await expect(bCarapace).toHaveAttribute("aria-pressed", "true");
    await expect(bPlastron).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#chartArea")).toHaveText("One more carapace length entry needed to draw the growth line.");
    await expect(page.locator("#cv")).toHaveCount(0);
    expect(await chartInfo(page)).toBeNull();

    await bWeight.click();
    await expect(bWeight).toHaveAttribute("aria-pressed", "true");
    await expect(bCarapace).toHaveAttribute("aria-pressed", "false");
    await expect.poll(() => chartInfo(page).then(c => c && c.ys)).toEqual([0.9, 1.2]);
  });

  test("editing a measurement updates it in place; deleting asks first and removes it from the UI and IndexedDB", async ({ page }) => {
    const asked = [];
    let accept = false;
    page.on("dialog", d => { asked.push(d.message()); return accept ? d.accept() : d.dismiss(); });

    let older;
    const today = await openSeeded(page, {
      entries: t => {
        older = addDays(t, -60);
        return [
          measure("m-now", t, { weightG: 1200, plastron: 12.5, scl: 14.2 }),
          measure("m-old", older, { weightG: 900, plastron: 11 })
        ];
      },
      settings: { tab: "growth" }
    });
    const entries = page.locator(".timeline .entry");
    await expect(entries).toHaveCount(2);
    await expect(stat(page, "Weight").locator(".d")).toHaveText("+150 g per month");

    // Edit the newest: the form is filled with the stored values
    await entries.nth(0).getByRole("button", { name: "Edit" }).click();
    const dlg = page.locator("#mDlg");
    await expect(dlg).toBeVisible();
    await expect(page.locator("#mDlgTitle")).toHaveText("Edit measurement");
    await expect(dlg.locator("[name=date]")).toHaveValue(today);
    await expect(dlg.locator("[name=plastron]")).toHaveValue("12.5");
    await expect(dlg.locator("[name=scl]")).toHaveValue("14.2");
    await expect(dlg.locator("[name=weight]")).toHaveValue("1.2");
    await expect(dlg.locator("[name=wunit]")).toHaveValue("kg");
    await dlg.locator("[name=weight]").fill("1.35");
    // Emptying a field removes that value from the measurement
    await dlg.locator("[name=scl]").fill("");
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Measurement updated");

    await expect(entries).toHaveCount(2);
    await expect(entryVal(entries.nth(0), "Weight")).toHaveText("1.35 kg");
    await expect(entryVal(entries.nth(0), "Plastron")).toHaveText("12.5 cm");
    await expect(entries.nth(0).locator(".entry-nums span").filter({ hasText: "Carapace" })).toHaveCount(0);
    await expect(stat(page, "Weight").locator(".v")).toHaveText("1.35 kg");
    await expect(stat(page, "Weight").locator(".d")).toHaveText("+225 g per month");
    await expect(stat(page, "Carapace").locator(".v")).toHaveText("–");
    let db = await readDb(page);
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find(e => e.id === "m-now")).toMatchObject({ date: today, weightG: 1350, plastron: 12.5, scl: null });

    // A weight under 1 kg is offered back in grams
    await entries.nth(1).getByRole("button", { name: "Edit" }).click();
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("[name=weight]")).toHaveValue("900");
    await expect(dlg.locator("[name=wunit]")).toHaveValue("g");
    await expect(dlg.locator("[name=date]")).toHaveValue(older);

    // Moving it to another date updates the record, the timeline and the rate: (1350 - 900) g over 30 days
    const moved = addDays(today, -30);
    await dlg.locator("[name=date]").fill(moved);
    await clearToast(page); // the toast of the first edit still holds the same text
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Measurement updated");
    await expect(entries).toHaveCount(2);
    await expect(entries.nth(1).locator("time")).toHaveAttribute("datetime", moved);
    await expect(entryVal(entries.nth(1), "Weight")).toHaveText("900 g");
    await expect(stat(page, "Weight").locator(".d")).toHaveText("+450 g per month");
    await expect(stat(page, "Plastron").locator(".d")).toHaveText("+1.50 cm per month");
    db = await readDb(page);
    expect(db.entries).toHaveLength(2);
    expect(db.entries.find(e => e.id === "m-old")).toMatchObject({ date: moved, weightG: 900, plastron: 11 });

    // Delete, but say no: nothing changes
    await entries.nth(1).getByRole("button", { name: "Delete" }).click();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toBe("Delete this measurement?");
    await expect(entries).toHaveCount(2);
    expect((await readDb(page)).entries.map(e => e.id).sort()).toEqual(["m-now", "m-old"]);

    // Delete and confirm
    accept = true;
    await entries.nth(1).getByRole("button", { name: "Delete" }).click();
    await expectToast(page, "Measurement deleted");
    await expect(entries).toHaveCount(1);
    await expect(entries.nth(0).locator("time")).toHaveAttribute("datetime", today);
    await expect(page.locator(".timeline")).not.toContainText("900 g");
    await expect(page.locator("#chartArea")).toHaveText("One more weight entry needed to draw the growth line.");
    await expect(page.locator("#panel .stats .d")).toHaveCount(0);
    db = await readDb(page);
    expect(db.entries.map(e => e.id)).toEqual(["m-now"]);

    // Still gone after a reload
    await page.reload();
    await expect(page.locator(".timeline .entry")).toHaveCount(1);
  });

  // Regression: the edit form offered a weight of 1 kg or more in kg with only three decimals, so 1234.5 g came back as
  // "1.234" kg and saving the edit without touching the weight (here: only adding a note) silently stored 1234 g.
  test("editing only the notes of a 1234.5 g measurement keeps the weight at 1234.5 g", async ({ page }) => {
    await openSeeded(page, { entries: t => [measure("m-now", t, { weightG: 1234.5 })], settings: { tab: "growth" } });
    const entry = page.locator(".timeline .entry").first();
    await entry.getByRole("button", { name: "Edit" }).click();
    const dlg = page.locator("#mDlg");
    await expect(dlg).toBeVisible();
    await dlg.locator("[name=notes]").fill("Weighed after soaking");
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    await expect(entry.locator(".entry-notes")).toHaveText("Weighed after soaking");
    expect((await readDb(page)).entries.find(e => e.id === "m-now")).toMatchObject({ notes: "Weighed after soaking", weightG: 1234.5 });
  });

  test("a progress photo is resized to JPEG, saved, shown in the timeline and lightbox, and becomes the avatar", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Pebble" });
    const today = await pageToday(page);
    await expect(page.locator(".profile .hex")).toHaveText("P");
    await expect(page.locator(".profile .hex img")).toHaveCount(0);

    // (Whether the preview and "Remove photo" are hidden without a photo is checked in its own test below.)
    const dlg = await openMeasureDialog(page);
    const prev = page.locator("#photoPrev"), rm = page.locator("#photoRm");
    await expect(prev).not.toHaveAttribute("src", /./);

    await page.locator("#photoIn").setInputFiles({ name: "shell.png", mimeType: "image/png", buffer: PNG_2X2 });
    await expect(prev).toBeVisible();
    await expect(prev).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
    await expect(prev).not.toHaveAttribute("hidden", /.*/);
    await expect(rm).toBeVisible();

    // Removing the photo leaves an empty form, which can't be saved
    await rm.click();
    await expect(prev).toHaveAttribute("hidden", "");
    await saveMeasure(dlg);
    await expect(page.locator("#mErr")).toHaveText("Enter at least one measurement or add a photo.");
    expect((await readDb(page)).entries).toHaveLength(0);

    // A photo on its own is enough to save
    await page.locator("#photoIn").setInputFiles({ name: "shell.png", mimeType: "image/png", buffer: PNG_2X2 });
    await expect(prev).toBeVisible();
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Measurement saved");

    const db = await readDb(page);
    expect(db.entries).toHaveLength(1);
    const e = db.entries[0];
    expect(e).toMatchObject({ kind: "measure", date: today, weightG: null, plastron: null, scl: null });
    expect(e.photo).toMatch(/^data:image\/jpeg;base64,/);
    // The stored JPEG is a real 2x2 image
    const size = await page.evaluate(src => new Promise((res, rej) => {
      const img = new Image(); img.onload = () => res([img.naturalWidth, img.naturalHeight]); img.onerror = rej; img.src = src;
    }), e.photo);
    expect(size).toEqual([2, 2]);

    // Thumbnail in the timeline
    const thumb = page.locator(".timeline .entry .entry-photo");
    await expect(thumb).toHaveCount(1);
    await expect(thumb).toBeVisible();
    await expect(thumb).toHaveAttribute("src", e.photo);
    const dateText = await page.evaluate(d => fmtDate(d), today);
    await expect(thumb).toHaveAttribute("alt", "Photo from " + dateText);

    // Lightbox
    const lb = page.locator("#lightbox");
    await expect(lb).toBeHidden();
    await thumb.click();
    await expect(lb).toBeVisible();
    await expect(page.locator("#lbImg")).toHaveAttribute("src", e.photo);
    await expect(page.locator("#lbTitle")).toHaveText(dateText);
    await lb.locator("[data-close]").click();
    await expect(lb).toBeHidden();

    // Avatar on the profile and on the home list
    await expect(page.locator(".profile .hex img")).toHaveAttribute("src", e.photo);
    await page.locator("#backBtn").click();
    await expect(page.locator(".t-card .hex img")).toHaveAttribute("src", e.photo);
  });

  // Regression: `img{display:block}` and `.btn{display:inline-flex}` used to override `[hidden]`, so the dialog showed a
  // broken "Selected photo" image and a "Remove photo" button with no photo chosen. Fixed by a global [hidden] rule.
  test("the photo preview and Remove photo are hidden when no photo is chosen, and hide again after removing", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Pebble" });
    await openMeasureDialog(page);
    const prev = page.locator("#photoPrev"), rm = page.locator("#photoRm");
    await expect(prev).toHaveAttribute("hidden", "");
    await expect(rm).toHaveAttribute("hidden", "");
    await expect(prev).toBeHidden({ timeout: 2000 });
    await expect(rm).toBeHidden({ timeout: 2000 });

    await page.locator("#photoIn").setInputFiles({ name: "shell.png", mimeType: "image/png", buffer: PNG_2X2 });
    await expect(prev).toBeVisible();
    await expect(rm).toBeVisible();
    await rm.click();
    await expect(prev).toBeHidden({ timeout: 2000 });
    await expect(rm).toBeHidden({ timeout: 2000 });
    await expect(prev).not.toHaveAttribute("src");
  });

  test("a large photo is scaled down to 900 px on its long side and keeps its shape", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Pebble" });
    const dlg = await openMeasureDialog(page);
    const prev = page.locator("#photoPrev");

    await page.locator("#photoIn").setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: await pngOfSize(page, 1800, 1200) });
    await expect(prev).toHaveAttribute("src", /^data:image\/jpeg;base64,/);
    expect(await imageSize(page, await prev.getAttribute("src"))).toEqual([900, 600]);

    // Choosing another photo replaces the first one
    await page.locator("#photoIn").setInputFiles({ name: "tall.png", mimeType: "image/png", buffer: await pngOfSize(page, 500, 1250) });
    await expect.poll(async () => imageSize(page, await prev.getAttribute("src"))).toEqual([360, 900]);
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();

    const [e] = (await readDb(page)).entries;
    expect(e.photo).toMatch(/^data:image\/jpeg;base64,/);
    expect(await imageSize(page, e.photo)).toEqual([360, 900]);
  });

  test("a file that isn't a readable image shows an error and attaches nothing", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Pebble" });
    const dlg = await openMeasureDialog(page);
    const err = page.locator("#mErr");
    await page.locator("#photoIn").setInputFiles({ name: "shell.png", mimeType: "image/png", buffer: Buffer.from("this is not a picture") });
    await expect(err).toBeVisible();
    await expect(err).toHaveText("This photo format can't be read. Try a JPG or PNG.");
    await expect(page.locator("#photoPrev")).toBeHidden();
    await expect(page.locator("#photoRm")).toBeHidden();

    // With no photo attached the form is still empty
    await saveMeasure(dlg);
    await expect(err).toHaveText("Enter at least one measurement or add a photo.");
    expect((await readDb(page)).entries).toHaveLength(0);

    // A good photo after the bad one works
    await page.locator("#photoIn").setInputFiles({ name: "shell.png", mimeType: "image/png", buffer: PNG_2X2 });
    await expect(page.locator("#photoPrev")).toBeVisible();
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    expect((await readDb(page)).entries).toHaveLength(1);
  });

  test("editing keeps a photo unless it is removed, and the avatar is always the newest photo", async ({ page }) => {
    page.on("dialog", d => d.accept());
    let older;
    await openSeeded(page, {
      entries: t => {
        older = addDays(t, -30);
        return [
          measure("m-old", older, { weightG: 500, photo: PNG_2X2_URL }),
          measure("m-now", t, { weightG: 520, photo: PNG_1X1 })
        ];
      },
      settings: { tab: "growth" }
    });
    const avatar = page.locator(".profile .hex img");
    const entries = page.locator(".timeline .entry");
    const thumbs = page.locator(".timeline .entry-photo");
    await expect(avatar).toHaveAttribute("src", PNG_1X1);
    await expect(thumbs).toHaveCount(2);
    await expect(thumbs.nth(0)).toHaveAttribute("src", PNG_1X1);
    await expect(thumbs.nth(1)).toHaveAttribute("src", PNG_2X2_URL);

    // The lightbox shows the photo that was clicked, titled with its date
    await thumbs.nth(1).click();
    await expect(page.locator("#lightbox")).toBeVisible();
    await expect(page.locator("#lbImg")).toHaveAttribute("src", PNG_2X2_URL);
    await expect(page.locator("#lbTitle")).toHaveText(await page.evaluate(d => fmtDate(d), older));
    await page.locator("#lightbox [data-close]").click();
    await expect(page.locator("#lightbox")).toBeHidden();

    // Edit the newest: its photo is in the form and survives a save
    const dlg = page.locator("#mDlg");
    await entries.nth(0).getByRole("button", { name: "Edit" }).click();
    await expect(dlg).toBeVisible();
    await expect(page.locator("#photoPrev")).toBeVisible();
    await expect(page.locator("#photoPrev")).toHaveAttribute("src", PNG_1X1);
    await expect(page.locator("#photoRm")).toBeVisible();
    await dlg.locator("[name=weight]").fill("530");
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Measurement updated");
    let db = await readDb(page);
    expect(db.entries.find(e => e.id === "m-now")).toMatchObject({ weightG: 530, photo: PNG_1X1 });
    await expect(thumbs).toHaveCount(2);
    await expect(avatar).toHaveAttribute("src", PNG_1X1);

    // A new measurement starts without the photo of the one just edited
    await openMeasureDialog(page);
    await expect(page.locator("#mDlgTitle")).toHaveText("Log measurement");
    await expect(page.locator("#photoPrev")).toBeHidden();
    await expect(page.locator("#photoPrev")).not.toHaveAttribute("src");
    await expect(page.locator("#photoRm")).toBeHidden();
    await expect(dlg.locator("[name=weight]")).toHaveValue("");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();

    // Edit again and remove the photo: the avatar falls back to the older photo
    await entries.nth(0).getByRole("button", { name: "Edit" }).click();
    await expect(dlg).toBeVisible();
    await page.locator("#photoRm").click();
    await expect(page.locator("#photoPrev")).toBeHidden();
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    db = await readDb(page);
    expect(db.entries.find(e => e.id === "m-now")).toMatchObject({ weightG: 530, photo: null });
    expect(db.entries.find(e => e.id === "m-old").photo).toBe(PNG_2X2_URL);
    await expect(thumbs).toHaveCount(1);
    await expect(entries.nth(0).locator(".entry-photo")).toHaveCount(0);
    await expect(avatar).toHaveAttribute("src", PNG_2X2_URL);
    await page.locator("#backBtn").click();
    await expect(page.locator(".t-card .hex img")).toHaveAttribute("src", PNG_2X2_URL);

    // Without any photo the avatar is the initial again
    await page.locator(".t-card").click();
    await entries.nth(1).getByRole("button", { name: "Delete" }).click();
    await expectToast(page, "Measurement deleted");
    await expect(thumbs).toHaveCount(0);
    await expect(avatar).toHaveCount(0);
    await expect(page.locator(".profile .hex")).toHaveText("S");
  });

  test("the weight unit setting (Auto / Grams / Kilograms) changes how weights are shown and persists", async ({ page }) => {
    await openSeeded(page, {
      entries: t => [
        measure("m-now", t, { weightG: 1250 }),
        measure("m-old", addDays(t, -60), { weightG: 450 })
      ],
      settings: { tab: "growth" }
    });
    const weights = page.locator(".timeline .entry .entry-nums span").filter({ hasText: "Weight" }).locator("b");
    const wStat = stat(page, "Weight");

    // Auto (default): grams under 1 kg, kg above
    await expect(weights).toHaveText(["1.25 kg", "450 g"]);
    await expect(wStat.locator(".v")).toHaveText("1.25 kg");
    await expect(wStat.locator(".d")).toHaveText("+400 g per month");
    await expect.poll(() => chartInfo(page).then(c => c && c.ys)).toEqual([0.45, 1.25]);
    expect((await chartInfo(page)).yTitle).toBe("kg");

    await page.locator("#openSettings").click();
    const sDlg = page.locator("#sDlg");
    await expect(sDlg).toBeVisible();
    const radio = name => sDlg.getByRole("radio", { name, exact: true });
    const chip = re => sDlg.locator("#unitChips label").filter({ hasText: re });
    await expect(radio("Auto (g under 1 kg)")).toBeChecked();

    // Grams
    await chip(/^Grams$/).click();
    await expect(radio("Grams")).toBeChecked();
    await expect(weights).toHaveText(["1,250 g", "450 g"]);
    await expect(wStat.locator(".v")).toHaveText("1,250 g");
    await expect(wStat.locator(".d")).toHaveText("+400 g per month");
    await expect.poll(() => chartInfo(page).then(c => c && c.ys)).toEqual([450, 1250]);
    expect((await chartInfo(page)).yTitle).toBe("g");
    expect((await chartInfo(page)).tips.map(t => t.split(": ")[1])).toEqual(["450 g", "1250 g"]);
    expect((await storedSettings(page)).unit).toBe("g");

    // Kilograms
    await chip(/^Kilograms$/).click();
    await expect(radio("Kilograms")).toBeChecked();
    await expect(weights).toHaveText(["1.25 kg", "0.45 kg"]);
    await expect(wStat.locator(".v")).toHaveText("1.25 kg");
    await expect(wStat.locator(".d")).toHaveText("+0.40 kg per month");
    await expect.poll(() => chartInfo(page).then(c => c && c.ys)).toEqual([0.45, 1.25]);
    expect((await chartInfo(page)).yTitle).toBe("kg");
    expect((await chartInfo(page)).tips.map(t => t.split(": ")[1])).toEqual(["0.45 kg", "1.25 kg"]);
    expect((await storedSettings(page)).unit).toBe("kg");
    await sDlg.locator("[data-close]").click();
    await expect(sDlg).toBeHidden();

    // New measurements default to kg in this mode
    const mDlg = await openMeasureDialog(page);
    await expect(mDlg.locator("[name=wunit]")).toHaveValue("kg");
    await mDlg.getByRole("button", { name: "Cancel" }).click();

    // Survives a reload, and the home list uses it too
    await page.reload();
    await expect(weights).toHaveText(["1.25 kg", "0.45 kg"]);
    await page.locator("#openSettings").click();
    await expect(radio("Kilograms")).toBeChecked();

    // Back to Auto
    await chip(/^Auto/).click();
    await expect(radio("Auto (g under 1 kg)")).toBeChecked();
    await expect(weights).toHaveText(["1.25 kg", "450 g"]);
    expect((await storedSettings(page)).unit).toBe("auto");
    await sDlg.locator("[data-close]").click();
    const mDlg2 = await openMeasureDialog(page);
    await expect(mDlg2.locator("[name=wunit]")).toHaveValue("g");
    await mDlg2.getByRole("button", { name: "Cancel" }).click();

    await page.locator("#backBtn").click();
    await expect(page.locator(".t-card .nums b")).toHaveText("1.25 kg");
    await page.locator("#openSettings").click();
    await chip(/^Grams$/).click();
    await expect(page.locator(".t-card .nums b")).toHaveText("1,250 g");
  });
});

/* ================================================================
   E4: daily care views
   ================================================================ */
test.describe("E4 care views", () => {
  const heading = page => page.locator("#panel .care-head .sec-h");
  const segBtn = (page, cv) => page.locator(`.seg[aria-label="Care view"] button[data-cv=${cv}]`);

  test("7 days / Month toggles heading and aria-pressed, persists across reload, and the hint link opens the month", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Tilly" });
    const today = await pageToday(page);
    const week = segBtn(page, "week"), month = segBtn(page, "month");

    // Default: last 7 days, today first
    await expect(heading(page)).toHaveText("Last 7 days");
    await expect(week).toHaveText("7 days");
    await expect(month).toHaveText("Month");
    await expect(week).toHaveAttribute("aria-pressed", "true");
    await expect(month).toHaveAttribute("aria-pressed", "false");
    const days = page.locator(".days .day");
    await expect(days).toHaveCount(7);
    const expectedDays = Array.from({ length: 7 }, (_, i) => addDays(today, -i));
    expect(await days.evaluateAll(els => els.map(e => e.dataset.day))).toEqual(expectedDays);
    await expect(days.first()).toHaveClass(/\btoday\b/);
    await expect(days.first()).toContainText("Today");
    await expect(days.nth(1)).toContainText("Yesterday");
    await expect(page.locator(".cal")).toHaveCount(0);

    // Month
    await month.click();
    await expect(heading(page)).toHaveText("Monthly view");
    await expect(month).toHaveAttribute("aria-pressed", "true");
    await expect(week).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".cal")).toBeVisible();
    await expect(page.locator(".days")).toHaveCount(0);
    expect((await storedSettings(page)).careView).toBe("month");

    await page.reload();
    await expect(heading(page)).toHaveText("Monthly view");
    await expect(month).toHaveAttribute("aria-pressed", "true");
    await expect(week).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".cal")).toBeVisible();

    // Back to 7 days, also persisted
    await week.click();
    await expect(heading(page)).toHaveText("Last 7 days");
    await expect(week).toHaveAttribute("aria-pressed", "true");
    expect((await storedSettings(page)).careView).toBe("week");
    await page.reload();
    await expect(heading(page)).toHaveText("Last 7 days");
    await expect(week).toHaveAttribute("aria-pressed", "true");
    await expect(month).toHaveAttribute("aria-pressed", "false");

    // The "monthly view" link in the hint
    const link = page.locator("#panel p.hint button.linkish", { hasText: "monthly view" });
    await expect(link).toBeVisible();
    await expect(page.locator("#panel p.hint").filter({ has: page.locator("button.linkish") })).toHaveText("Older days are in the monthly view.");
    await link.click();
    await expect(heading(page)).toHaveText("Monthly view");
    await expect(month).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".cal")).toBeVisible();
    expect((await storedSettings(page)).careView).toBe("month");
  });

  test("month grid: current month, weekday headers, today, disabled future days and month navigation", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Tilly" });
    const today = await pageToday(page);
    const { y, m } = monthOf(today);
    const d = Number(today.slice(8, 10));
    const dim = daysIn(y, m);
    await segBtn(page, "month").click();

    const label = page.locator(".cal-head b");
    const prev = page.getByRole("button", { name: "Previous month" });
    const next = page.getByRole("button", { name: "Next month" });
    const cells = page.locator(".cal button.cell");

    await expect(label).toHaveText(`${MONTHS[m - 1]} ${y}`);
    await expect(page.locator(".cal .wd")).toHaveText(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    await expect(cells).toHaveCount(dim);
    await expect(page.locator(".cal .cell.out")).toHaveCount(mondayOffset(y, m));
    await expect(cells.first()).toHaveAttribute("data-day", ymd(y, m, 1));
    await expect(cells.last()).toHaveAttribute("data-day", ymd(y, m, dim));

    // Today
    const todayCell = page.locator(`.cal button.cell[data-day="${today}"]`);
    await expect(todayCell).toHaveClass(/\btoday\b/);
    await expect(page.locator(".cal .cell.today")).toHaveCount(1);
    await expect(todayCell).toBeEnabled();
    await expect(todayCell.locator(".n")).toHaveText(String(d));

    // Future days are disabled, past days are not
    await expect(page.locator(".cal button.cell:disabled")).toHaveCount(dim - d);
    const disabledDays = await page.locator(".cal button.cell:disabled").evaluateAll(els => els.map(e => e.dataset.day));
    expect(disabledDays.every(x => x > today)).toBe(true);
    if(d < dim) await expect(page.locator(`.cal button.cell[data-day="${addDays(today, 1)}"]`)).toBeDisabled();
    if(d > 1) await expect(page.locator(`.cal button.cell[data-day="${addDays(today, -1)}"]`)).toBeEnabled();
    await expect(page.locator("#panel p.hint").last()).toHaveText("Soaked on 0 days and fed on 0 days this month.");

    // Navigation
    await expect(next).toBeDisabled();
    await expect(prev).toBeEnabled();
    await prev.click();
    const pm = monthOf(today, -1);
    await expect(label).toHaveText(`${MONTHS[pm.m - 1]} ${pm.y}`);
    await expect(next).toBeEnabled();
    await expect(cells).toHaveCount(daysIn(pm.y, pm.m));
    await expect(page.locator(".cal .cell.out")).toHaveCount(mondayOffset(pm.y, pm.m));
    await expect(page.locator(".cal button.cell:disabled")).toHaveCount(0);
    await expect(page.locator(".cal .cell.today")).toHaveCount(0);

    await prev.click();
    const pm2 = monthOf(today, -2);
    await expect(label).toHaveText(`${MONTHS[pm2.m - 1]} ${pm2.y}`);
    await next.click();
    await expect(label).toHaveText(`${MONTHS[pm.m - 1]} ${pm.y}`);
    await next.click();
    await expect(label).toHaveText(`${MONTHS[m - 1]} ${y}`);
    await expect(next).toBeDisabled();
    await expect(page.locator(".cal .cell.today")).toHaveCount(1);

    // Leaving the tortoise resets the month to the current one
    await prev.click();
    await expect(label).toHaveText(`${MONTHS[pm.m - 1]} ${pm.y}`);
    await page.locator("#backBtn").click();
    await page.locator(".t-card").first().click();
    await expect(label).toHaveText(`${MONTHS[m - 1]} ${y}`);
  });

  test("care records show the right dots and month summary; clicking a day opens the care dialog for that date", async ({ page }) => {
    let pmDay;
    const today = await openSeeded(page, {
      entries: t => {
        const pm = monthOf(t, -1);
        pmDay = n => ymd(pm.y, pm.m, n);
        return [
          care(t, { soaked: true, food: ["Leafy greens"] }),
          care(pmDay(3), { soaked: true, food: ["Leafy greens"], poop: "Normal, firm" }),
          care(pmDay(10), { foodNote: "dandelion", poop: "Runny" }),
          care(pmDay(15), { soaked: true, urates: "Gritty / chalky" }),
          care(pmDay(20), { notes: "Quiet day" }),
          care(pmDay(25), { soaked: true }),
          care(pmDay(27), { urates: "Soft white paste" })
        ];
      },
      settings: { careView: "month" }
    });
    const { y, m } = monthOf(today);
    const pm = monthOf(today, -1);
    const cell = iso => page.locator(`.cal button.cell[data-day="${iso}"]`);
    const summary = page.locator("#panel p.hint").filter({ hasText: /^Soaked on/ });
    const fmt = iso => page.evaluate(x => fmtDate(x), iso);

    // Current month: only today
    await expect(page.locator(".cal-head b")).toHaveText(`${MONTHS[m - 1]} ${y}`);
    await expect(cell(today).locator(".dot")).toHaveClass(["dot soak", "dot fed"]);
    await expect(cell(today)).toHaveAttribute("aria-label", `${await fmt(today)}: soaked, fed`);
    await expect(summary).toHaveText("Soaked on 1 day and fed on 1 day this month.");

    // Previous month
    await page.getByRole("button", { name: "Previous month" }).click();
    await expect(page.locator(".cal-head b")).toHaveText(`${MONTHS[pm.m - 1]} ${pm.y}`);
    await expect(cell(pmDay(3)).locator(".dot")).toHaveClass(["dot soak", "dot fed", "dot poop"]);
    await expect(cell(pmDay(3))).toHaveAttribute("aria-label", `${await fmt(pmDay(3))}: soaked, fed, poop checked`);
    await expect(cell(pmDay(10)).locator(".dot")).toHaveClass(["dot fed", "dot poop bad"]);
    await expect(cell(pmDay(10))).toHaveAttribute("aria-label", `${await fmt(pmDay(10))}: fed, poop or urates need attention`);
    await expect(cell(pmDay(15)).locator(".dot")).toHaveClass(["dot soak", "dot poop bad"]);
    await expect(cell(pmDay(20)).locator(".dot")).toHaveClass(["dot note"]);
    await expect(cell(pmDay(25)).locator(".dot")).toHaveClass(["dot soak"]);
    await expect(cell(pmDay(27)).locator(".dot")).toHaveClass(["dot poop"]);
    await expect(cell(pmDay(5)).locator(".dot")).toHaveCount(0);
    await expect(cell(pmDay(5))).toHaveAttribute("aria-label", `${await fmt(pmDay(5))}, nothing logged`);
    await expect(summary).toHaveText("Soaked on 3 days and fed on 2 days this month.");

    // Click a logged past day: the dialog opens on that day with its record
    const cDlg = page.locator("#cDlg");
    await cell(pmDay(10)).click();
    await expect(cDlg).toBeVisible();
    await expect(page.locator("#cDlgTitle")).toHaveText("Care on " + await fmt(pmDay(10)));
    await expect(cDlg.locator("[name=date]")).toHaveValue(pmDay(10));
    await expect(page.locator("#cHint")).toBeVisible();
    await expect(page.locator("#cHint")).toHaveText("Already logged for this day. Your changes update it.");
    await expect(cDlg.locator("[name=foodNote]")).toHaveValue("dandelion");
    await expect(cDlg.locator("[name=poop]")).toHaveValue("Runny");
    await expect(cDlg.locator("[name=soaked]")).not.toBeChecked();
    await expect(page.locator("#cClear")).toBeVisible();
    await cDlg.getByRole("button", { name: "Cancel" }).click();
    await expect(cDlg).toBeHidden();

    // Click an empty past day and log a soak there
    await cell(pmDay(12)).click();
    await expect(cDlg).toBeVisible();
    await expect(page.locator("#cDlgTitle")).toHaveText("Care on " + await fmt(pmDay(12)));
    await expect(cDlg.locator("[name=date]")).toHaveValue(pmDay(12));
    await expect(page.locator("#cHint")).toBeHidden();
    await expect(page.locator("#cClear")).toHaveAttribute("hidden", "");
    await cDlg.locator("[name=soaked]").check();
    await cDlg.getByRole("button", { name: "Save care" }).click();
    await expect(cDlg).toBeHidden();
    await expectToast(page, "Care saved");
    await expect(page.locator(".cal-head b")).toHaveText(`${MONTHS[pm.m - 1]} ${pm.y}`);
    await expect(cell(pmDay(12)).locator(".dot")).toHaveClass(["dot soak"]);
    await expect(summary).toHaveText("Soaked on 4 days and fed on 2 days this month.");
    const saved = (await readDb(page)).entries.find(e => e.date === pmDay(12));
    expect(saved).toMatchObject({ id: "c_" + T.id + "_" + pmDay(12), kind: "care", tortoiseId: T.id, soaked: true });

    // Today's cell opens today's care
    await page.getByRole("button", { name: "Next month" }).click();
    await cell(today).click();
    await expect(cDlg).toBeVisible();
    await expect(page.locator("#cDlgTitle")).toHaveText("Today's care");
    await expect(cDlg.locator("[name=date]")).toHaveValue(today);
    await expect(cDlg.locator("[name=soaked]")).toBeChecked();
    await cDlg.getByRole("button", { name: "Cancel" }).click();
    await expect(cDlg).toBeHidden();
  });

  // A fixed date, so the month-boundary cases are checked on every run, not only on the days they happen to fall on.
  test("on Sunday 1 March 2026: the week reaches into February, future-dated care stays reachable, and the grid handles a Sunday start, February and the year boundary", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-03-01T10:00:00+07:00"));
    const today = await openSeeded(page, { entries: [
      care("2026-03-03", { soaked: true, notes: "Logged ahead by mistake" }),
      care("2026-02-28", { food: ["Weeds"] }),
      care("2026-02-23", { poop: "Normal, firm" }),
      care("2026-02-22", { soaked: true })
    ] });
    expect(today).toBe("2026-03-01");
    const cDlg = page.locator("#cDlg");

    // 7 days: the future-dated record on top, then today back to Monday 23 February
    const days = page.locator(".days .day");
    await expect(days).toHaveCount(8);
    expect(await days.evaluateAll(els => els.map(e => e.dataset.day))).toEqual(
      ["2026-03-03", "2026-03-01", "2026-02-28", "2026-02-27", "2026-02-26", "2026-02-25", "2026-02-24", "2026-02-23"]);
    const big = i => days.nth(i).locator(".dlabel b"), small = i => days.nth(i).locator(".dlabel small");
    await expect(big(0)).toHaveText("Tue");
    await expect(small(0)).toHaveText("3 Mar");
    await expect(big(1)).toHaveText("Today");
    await expect(days.nth(1)).toHaveClass(/\btoday\b/);
    await expect(page.locator(".days .day.today")).toHaveCount(1);
    await expect(big(2)).toHaveText("Yesterday");
    await expect(small(2)).toHaveText("28 Feb");
    await expect(big(3)).toHaveText("Fri");
    await expect(big(7)).toHaveText("Mon");
    await expect(small(7)).toHaveText("23 Feb");
    await expect(days.nth(1).locator(".marks")).toHaveText("Nothing logged. Tap to add.");
    await expect(days.nth(2).locator(".marks")).toContainText("Weeds");
    await expect(days.nth(7).locator(".marks")).toContainText("Poop: Normal, firm");
    await expect(page.locator('.days .day[data-day="2026-02-22"]')).toHaveCount(0);

    // Rows open the care dialog for their own date
    await days.nth(0).click();
    await expect(cDlg).toBeVisible();
    await expect(page.locator("#cDlgTitle")).toHaveText("Care on 3 Mar 2026");
    await expect(cDlg.locator("[name=date]")).toHaveValue("2026-03-03");
    await expect(cDlg.locator("[name=soaked]")).toBeChecked();
    await cDlg.getByRole("button", { name: "Cancel" }).click();
    await expect(cDlg).toBeHidden();
    await days.nth(2).click();
    await expect(cDlg).toBeVisible();
    await expect(page.locator("#cDlgTitle")).toHaveText("Yesterday's care");
    await expect(cDlg.locator("[name=date]")).toHaveValue("2026-02-28");
    await expect(cDlg.locator('[name=food][value="Weeds"]')).toBeChecked();
    await cDlg.getByRole("button", { name: "Cancel" }).click();
    await expect(cDlg).toBeHidden();

    // Month view of March 2026, which starts on a Sunday
    await segBtn(page, "month").click();
    const label = page.locator(".cal-head b"), cells = page.locator(".cal button.cell"), out = page.locator(".cal .cell.out");
    const disabled = page.locator(".cal button.cell:disabled");
    const cell = iso => page.locator(`.cal button.cell[data-day="${iso}"]`);
    const summary = page.locator("#panel p.hint").filter({ hasText: /^Soaked on/ });
    const prev = page.getByRole("button", { name: "Previous month" }), next = page.getByRole("button", { name: "Next month" });
    await expect(label).toHaveText("March 2026");
    await expect(cells).toHaveCount(31);
    await expect(out).toHaveCount(6);
    // The 1st sits under "Sun" and the 2nd under "Mon" of the next row
    const x = async loc => Math.round((await loc.boundingBox()).x);
    const wd = page.locator(".cal .wd");
    expect(await x(cell("2026-03-01"))).toBe(await x(wd.nth(6)));
    expect(await x(cell("2026-03-02"))).toBe(await x(wd.nth(0)));
    await expect(cell("2026-03-01")).toHaveClass(/\btoday\b/);
    await expect(cell("2026-03-01")).toBeEnabled();
    await expect(cell("2026-03-02")).toBeDisabled();
    await expect(cell("2026-03-31")).toBeDisabled();
    // A future day that has a record stays enabled, so the record can be fixed
    await expect(cell("2026-03-03")).toBeEnabled();
    await expect(cell("2026-03-03").locator(".dot")).toHaveClass(["dot soak"]);
    await expect(cell("2026-03-03")).toHaveAttribute("aria-label", "3 Mar 2026: soaked");
    await expect(disabled).toHaveCount(29);
    await expect(next).toBeDisabled();
    await expect(summary).toHaveText("Soaked on 1 day and fed on 0 days this month.");
    await cell("2026-03-03").click();
    await expect(cDlg).toBeVisible();
    await expect(cDlg.locator("[name=date]")).toHaveValue("2026-03-03");
    await cDlg.getByRole("button", { name: "Cancel" }).click();
    await expect(cDlg).toBeHidden();

    // February 2026: 28 days, also starting on a Sunday, nothing disabled
    await prev.click();
    await expect(label).toHaveText("February 2026");
    await expect(cells).toHaveCount(28);
    await expect(out).toHaveCount(6);
    await expect(cells.last()).toHaveAttribute("data-day", "2026-02-28");
    await expect(disabled).toHaveCount(0);
    await expect(page.locator(".cal .cell.today")).toHaveCount(0);
    await expect(cell("2026-02-28").locator(".dot")).toHaveClass(["dot fed"]);
    await expect(cell("2026-02-23").locator(".dot")).toHaveClass(["dot poop"]);
    await expect(cell("2026-02-22").locator(".dot")).toHaveClass(["dot soak"]);
    await expect(summary).toHaveText("Soaked on 1 day and fed on 1 day this month.");

    // January 2026 starts on a Thursday, December 2025 on a Monday
    await prev.click();
    await expect(label).toHaveText("January 2026");
    await expect(cells).toHaveCount(31);
    await expect(out).toHaveCount(3);
    await expect(cells.first()).toHaveAttribute("data-day", "2026-01-01");
    await prev.click();
    await expect(label).toHaveText("December 2025");
    await expect(cells).toHaveCount(31);
    await expect(out).toHaveCount(0);
    await expect(cells.first()).toHaveAttribute("data-day", "2025-12-01");
    await expect(summary).toHaveText("Soaked on 0 days and fed on 0 days this month.");

    // And forward again across the year boundary
    await next.click();
    await expect(label).toHaveText("January 2026");
    await next.click();
    await next.click();
    await expect(label).toHaveText("March 2026");
    await expect(next).toBeDisabled();
  });

  test("the Daily care / Growth tab choice survives a reload", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Tilly" });
    const careTab = page.locator("#tab-care"), growth = page.locator("#tab-growth");
    await expect(careTab).toHaveAttribute("aria-selected", "true");
    await expect(growth).toHaveAttribute("aria-selected", "false");
    await expect(page.locator('#panel .stats[aria-label="Care summary"]')).toBeVisible();

    await growth.click();
    await expect(growth).toHaveAttribute("aria-selected", "true");
    await expect(careTab).toHaveAttribute("aria-selected", "false");
    await expect(page.locator('#panel .stats[aria-label="Latest measurements"]')).toBeVisible();
    expect((await storedSettings(page)).tab).toBe("growth");

    await page.reload();
    await expect(growth).toHaveAttribute("aria-selected", "true");
    await expect(careTab).toHaveAttribute("aria-selected", "false");
    await expect(page.locator('#panel .stats[aria-label="Latest measurements"]')).toBeVisible();
    await expect(page.locator("#panel")).toContainText("No measurements yet.");

    await careTab.click();
    await expect(careTab).toHaveAttribute("aria-selected", "true");
    expect((await storedSettings(page)).tab).toBe("care");
    await page.reload();
    await expect(careTab).toHaveAttribute("aria-selected", "true");
    await expect(growth).toHaveAttribute("aria-selected", "false");
    await expect(heading(page)).toHaveText("Last 7 days");
  });
});

/* ================================================================
   Dark mode
   ================================================================ */
test.describe("Dark mode", () => {
  const LIGHT_BG = "rgb(230, 234, 220)", DARK_BG = "rgb(20, 24, 17)";
  const TOKENS = ["--bg", "--surface", "--sunk", "--ink", "--muted", "--line", "--shell", "--shell-soft", "--leaf", "--leaf-ink", "--on-shell", "--danger", "--focus"];

  // Relative luminance and contrast ratio (WCAG 2.x) of [r, g, b] colours.
  const lum = ([r, g, b]) => {
    const ch = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

  // Text colour of the first element matching the selector and the colour behind it, with see-through backgrounds
  // (rgba, color-mix with transparent) blended over what is under them, up to the first opaque one.
  const colours = (page, sel) => page.evaluate(sel => {
    const parse = s => {
      let m = s.match(/^rgba?\(([^)]+)\)$/);
      if(m){ const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
      m = s.match(/^color\(srgb\s+([^)]+)\)$/);
      if(m){ const p = m[1].split(/[\s\/]+/).filter(Boolean).map(Number); return [p[0] * 255, p[1] * 255, p[2] * 255, p.length > 3 ? p[3] : 1]; }
      throw new Error("Unexpected colour format: " + s);
    };
    const over = (top, under) => [0, 1, 2].map(i => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);
    const el = document.querySelector(sel);
    if(!el) throw new Error("No element for " + sel);
    const layers = [];
    for(let n = el; n && n.nodeType === 1; n = n.parentElement){
      const c = parse(getComputedStyle(n).backgroundColor);
      if(c[3] > 0) layers.push(c);
      if(c[3] >= 1) break;
    }
    let bg = [255, 255, 255, 1];
    for(let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    const fg = over(parse(getComputedStyle(el).color), bg);
    return { fg: fg.slice(0, 3).map(Math.round), bg: bg.slice(0, 3).map(Math.round), text: (el.value || el.textContent || "").trim().slice(0, 30) };
  }, sel);

  // Every selector's text must reach 4.5:1 against its background. Reports all failures at once.
  async function expectReadable(page, checks, scheme){
    const low = [];
    for(const [name, sel] of Object.entries(checks)){
      const c = await colours(page, sel);
      const r = Math.round(ratio(c.fg, c.bg) * 100) / 100;
      if(!(r >= 4.5)) low.push(`${name} (${sel}) "${c.text}": ${r} [fg ${c.fg} on bg ${c.bg}]`);
    }
    expect(low, `${scheme}: text below 4.5:1`).toEqual([]);
  }

  const bodyColours = page => page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return { bg: cs.backgroundColor, fg: cs.color, scheme: getComputedStyle(document.documentElement).colorScheme };
  });
  const tokens = page => page.evaluate(names => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map(n => [n, cs.getPropertyValue(n).trim().toUpperCase()]));
  }, TOKENS);

  test("prefers-color-scheme: dark switches to the dark tokens and keeps the Growth tab readable", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openSeeded(page, {
      entries: t => [
        measure("m-now", t, { weightG: 1200, plastron: 12.5, scl: 14.2, notes: "Shell looks smooth" }),
        measure("m-old", addDays(t, -60), { weightG: 900, plastron: 11 })
      ],
      settings: { tab: "growth" }
    });

    // Light tokens first
    await expect.poll(() => bodyColours(page)).toEqual({ bg: LIGHT_BG, fg: "rgb(30, 38, 25)", scheme: "light" });
    await expect.poll(() => chartInfo(page).then(c => c && c.border)).toBe("#41693A");

    // Switch to dark
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => bodyColours(page)).toEqual({ bg: DARK_BG, fg: "rgb(229, 233, 219)", scheme: "dark" });

    await expectReadable(page, {
      "body": "body",
      "tortoise name": ".profile h1",
      "species (muted)": ".profile .sp",
      "sex chip": ".profile .chip",
      "back button": "#backBtn",
      "primary button": "#addC",
      "secondary button": "#addM",
      "active tab": '.tabs button[aria-selected="true"]',
      "inactive tab (muted)": '.tabs button[aria-selected="false"]',
      "stat label (muted on card)": "#panel .stats .stat .k",
      "stat value": "#panel .stats .stat .v",
      "stat rate": "#panel .stats .stat .d",
      "chart metric, pressed": '.seg[aria-label="Chart measurement"] button[aria-pressed="true"]',
      "chart metric, not pressed": '.seg[aria-label="Chart measurement"] button[aria-pressed="false"]',
      "section heading": "#panel .care-head .sec-h",
      "Export CSV": "#csvT",
      "entry date": ".timeline .entry time",
      "entry label (muted)": ".timeline .entry .entry-nums span",
      "entry number": ".timeline .entry .entry-nums b",
      "entry notes (muted)": ".timeline .entry .entry-notes",
      "entry Delete (danger)": ".timeline .entry [data-del]",
      "delete tortoise (danger)": "#delT"
    }, "dark");

    // Cards use the dark surface, the chart picks up the dark colours when drawn
    const card = await colours(page, ".timeline .entry-card .body");
    expect(card.bg).toEqual([29, 34, 25]);
    await page.reload();
    await expect.poll(() => chartInfo(page).then(c => c && c.border)).toBe("#86B56A");
    await expect.poll(() => bodyColours(page).then(c => c.bg)).toBe(DARK_BG);

    // Light again
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(() => bodyColours(page).then(c => c.bg)).toBe(LIGHT_BG);
    const light = await colours(page, "body");
    expect(ratio(light.fg, light.bg)).toBeGreaterThanOrEqual(4.5);
  });

  for(const scheme of ["dark", "light"]){
    test(`${scheme}: the care views, dialogs and toast keep text readable`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openSeeded(page, {
        entries: t => [
          care(t, { soaked: true, food: ["Leafy greens", "Weeds", "Flowers"], notes: "Ate well" }),
          care(addDays(t, -1), { poop: "Runny", urates: "Soft white paste" })
        ]
      });
      await expect.poll(() => bodyColours(page).then(c => c.bg)).toBe(scheme === "dark" ? DARK_BG : LIGHT_BG);

      // 7 days
      await expect(page.locator(".days .day")).toHaveCount(7);
      await expectReadable(page, {
        "care stat value": "#panel .stats .stat .v",
        "care view, pressed": '.seg[aria-label="Care view"] button[aria-pressed="true"]',
        "care view, not pressed": '.seg[aria-label="Care view"] button[aria-pressed="false"]',
        "today label": ".days .day.today .dlabel b",
        "today date (muted)": ".days .day.today .dlabel small",
        "today soaked chip": ".days .day.today .chip.shell",
        "today food chip": ".days .day.today .chip:not(.shell)",
        "today note (muted)": ".days .day.today .nt",
        "older day date (muted)": ".days li:nth-child(2) .dlabel small",
        "attention chip": ".days .chip.bad",
        "nothing logged (muted)": ".days .marks .none",
        "hint (muted)": "#panel p.hint",
        "monthly view link": "#panel button.linkish"
      }, scheme);

      // Month
      await page.locator('.seg[aria-label="Care view"] button[data-cv=month]').click();
      await expect(page.locator(".cal")).toBeVisible();
      await expectReadable(page, {
        "month name": ".cal-head b",
        "weekday header (muted)": ".cal .wd",
        "day number": ".cal button.cell:not(:disabled):not(.today) .n",
        "today number": ".cal .cell.today .n",
        "legend (muted)": ".cal-legend span",
        "month summary (muted)": "#panel p.hint"
      }, scheme);

      // Settings dialog
      await page.locator("#openSettings").click();
      await expect(page.locator("#sDlg")).toBeVisible();
      await expectReadable(page, {
        "settings title": "#sDlgTitle",
        "settings legend": "#sDlg legend",
        "unit chip, chosen": "#unitChips input:checked + span",
        "unit chip": "#unitChips input:not(:checked) + span",
        "settings hint (muted)": "#sDlg .hint",
        "checkbox hint (muted)": "#sDlg .check small",
        "export button": "#exportJson"
      }, scheme);
      await page.locator("#sDlg [data-close]").click();
      await expect(page.locator("#sDlg")).toBeHidden();

      // Measurement dialog with its error message
      const dlg = await openMeasureDialog(page);
      await saveMeasure(dlg);
      await expect(page.locator("#mErr")).toBeVisible();
      await dlg.locator("[name=weight]").fill("450");
      await dlg.locator("[name=notes]").fill("Weighed after soaking");
      await expectReadable(page, {
        "dialog title": "#mDlgTitle",
        "field label": "#mDlg label.f",
        "field unit (muted)": "#mDlg label.f small",
        "typed weight": "#mDlg input[name=weight]",
        "unit select": "#mDlg select[name=wunit]",
        "typed notes": "#mDlg textarea[name=notes]",
        "error message (danger)": "#mErr",
        "save button": "#mDlg .dlg-foot .btn.primary",
        "cancel button": "#mDlg .dlg-foot .btn.ghost"
      }, scheme);

      // Toast
      await saveMeasure(dlg);
      await expectToast(page, "Measurement saved");
      await expectReadable(page, { "toast": "#toast" }, scheme);
    });
  }

  // Regression: `.hex` hard-coded white text on var(--shell); in dark mode --shell is the light gold #D7A44C, so the
  // initial of a tortoise without a photo dropped to about 2.3:1. It now uses the --on-shell token (dark in dark mode).
  test("the avatar initial stays readable (3:1 for large text) in dark mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await openSeeded(page);
    await expect.poll(() => bodyColours(page).then(c => c.bg)).toBe(DARK_BG);
    await expect(page.locator(".profile .hex")).toHaveText("S");
    const profile = await colours(page, ".profile .hex");
    expect(ratio(profile.fg, profile.bg), `profile initial ${profile.fg} on ${profile.bg}`).toBeGreaterThanOrEqual(3);
    await page.locator("#backBtn").click();
    await expect(page.locator(".t-card .hex")).toHaveText("S");
    const card = await colours(page, ".t-card .hex");
    expect(ratio(card.fg, card.bg), `home list initial ${card.fg} on ${card.bg}`).toBeGreaterThanOrEqual(3);
  });

  test("every colour token has its own dark value, and data-theme overrides the system preference both ways", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openApp(page);
    const light = await tokens(page);
    expect(light["--bg"]).toBe("#E6EADC");

    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => bodyColours(page).then(c => c.bg)).toBe(DARK_BG);
    const dark = await tokens(page);
    expect(dark["--bg"]).toBe("#141811");
    const same = TOKENS.filter(n => dark[n] === light[n]);
    expect(same, "tokens without a dark value").toEqual([]);

    const setTheme = v => page.evaluate(v => v == null ? document.documentElement.removeAttribute("data-theme") : document.documentElement.setAttribute("data-theme", v), v);

    // A light choice wins over a dark system setting
    await setTheme("light");
    expect(await tokens(page)).toEqual(light);
    await expect.poll(() => bodyColours(page)).toEqual({ bg: LIGHT_BG, fg: "rgb(30, 38, 25)", scheme: "light" });

    // A dark choice wins over a light system setting, with the same values as the system dark mode
    await page.emulateMedia({ colorScheme: "light" });
    await setTheme("dark");
    expect(await tokens(page)).toEqual(dark);
    await expect.poll(() => bodyColours(page)).toEqual({ bg: DARK_BG, fg: "rgb(229, 233, 219)", scheme: "dark" });

    // No choice: follow the system again
    await setTheme(null);
    expect(await tokens(page)).toEqual(light);
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await tokens(page)).toEqual(dark);
  });
});

/* ================================================================
   Form input and number display (fix 6)
   ================================================================ */
test.describe("Form input and number display", () => {

  // Regression: "0.04" g was stored as a 0 g weight, "0,04" cm as a 0 cm plastron, and "12 kg" / "14 cm" were cut down
  // to 12 / 14 (in the unit the form had selected), so a typo or a unit typed into the field became a wrong measurement.
  test("the measurement form refuses a value that rounds to 0 and a number with a unit typed after it; nothing is saved", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    const dlg = await openMeasureDialog(page);
    const err = page.locator("#mErr");
    await expect(dlg.locator("[name=wunit]")).toHaveValue("g");
    const field = name => dlg.locator(`[name=${name}]`);
    // Each attempt has the other fields filled in correctly; the error names the field with the typo.
    const refused = async text => {
      await saveMeasure(dlg);
      await expect(err).toBeVisible();
      await expect(err).toHaveText(text);
      await expect(dlg).toBeVisible();
      expect((await readDb(page)).entries).toEqual([]);
    };

    // A weight under 0.05 g rounds to 0 g
    await field("plastron").fill("12,5");
    await field("weight").fill("0.04");
    await refused("Check the weight: use a number like 12.5");

    // A plastron under 0.05 cm rounds to 0 cm (decimal comma)
    await field("weight").fill("450");
    await field("plastron").fill("0,04");
    await refused("Check the plastron length: use a number like 12.5");

    // A unit typed after the weight
    await field("plastron").fill("12,5");
    await field("weight").fill("12 kg");
    await refused("Check the weight: use a number like 12.5");

    // A unit typed after the carapace length
    await field("weight").fill("450");
    await field("scl").fill("14 cm");
    await refused("Check the carapace length: use a number like 12.5");

    // In kg too: 0.00004 kg is 0.04 g, which rounds to 0 g
    await field("scl").fill("14");
    await field("weight").fill("0,00004");
    await field("wunit").selectOption("kg");
    await refused("Check the weight: use a number like 12.5");

    // Corrected, the same form saves exactly the typed values
    await field("weight").fill("0,45");
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Measurement saved");
    const ms = (await readDb(page)).entries;
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ kind: "measure", plastron: 12.5, scl: 14, weightG: 450 });
    const entry = page.locator(".timeline .entry");
    await expect(entry).toHaveCount(1);
    await expect(entryVal(entry.first(), "Weight")).toHaveText("450 g");
    await expect(entryVal(entry.first(), "Plastron")).toHaveText("12.5 cm");
    await expect(entryVal(entry.first(), "Carapace")).toHaveText("14.0 cm");
  });

  // Regression: weights of 1 kg or more were offered back in kg with three decimals ("1.234" for 1234.5 g, "2.5" for
  // 2500.1 g), so saving the edit unchanged stored a different weight. The notes-only edit of 1234.5 g is covered in E3
  // above; this test checks the value the form offers.
  test("the edit form offers a stored weight with every digit: 1234.5 g as 1.2345 kg, 2500.1 g as 2.5001 kg", async ({ page }) => {
    const today = await openSeeded(page, {
      entries: t => [
        measure("m-a", t, { weightG: 1234.5 }),
        measure("m-b", addDays(t, -10), { weightG: 2500.1 }),
        measure("m-c", addDays(t, -20), { weightG: 1000 }),
        measure("m-d", addDays(t, -30), { weightG: 999.9 })
      ],
      settings: { tab: "growth" }
    });
    const entries = page.locator(".timeline .entry");
    await expect(entries).toHaveCount(4);
    const dlg = page.locator("#mDlg");
    const offered = async (i, value, unit) => {
      await entries.nth(i).getByRole("button", { name: "Edit" }).click();
      await expect(dlg).toBeVisible();
      await expect(dlg.locator("[name=weight]")).toHaveValue(value);
      await expect(dlg.locator("[name=wunit]")).toHaveValue(unit);
    };
    const cancel = async () => { await dlg.getByRole("button", { name: "Cancel" }).click(); await expect(dlg).toBeHidden(); };

    await offered(0, "1.2345", "kg"); await cancel();
    await offered(2, "1", "kg"); await cancel();
    await offered(3, "999.9", "g"); await cancel();

    // Saved without touching anything, 2500.1 g stays 2500.1 g
    await offered(1, "2.5001", "kg");
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Measurement updated");
    const db = await readDb(page);
    expect(Object.fromEntries(db.entries.map(e => [e.id, e.weightG]))).toEqual({ "m-a": 1234.5, "m-b": 2500.1, "m-c": 1000, "m-d": 999.9 });
    expect(db.entries.find(e => e.id === "m-b").date).toBe(addDays(today, -10));
  });

  // Regression: with Show weight in > Kilograms, a small monthly change was rounded in kg and read "+0.01 kg" or
  // "−0.00 kg per month", which hid a small gain or loss. Under 10 g a month it is shown in grams.
  test("with the Kilograms setting, a weight change under 10 g a month is shown in grams (+5.0 g, −3.0 g) and a larger one in kg", async ({ page }) => {
    const today = await openSeeded(page, {
      entries: t => [
        measure("m-now", t, { weightG: 150 }),
        measure("m-old", addDays(t, -30), { weightG: 145 })
      ],
      settings: { tab: "growth", unit: "kg" }
    });
    const w = stat(page, "Weight");
    // The weights themselves follow the setting
    await expect(w.locator(".v")).toHaveText("0.15 kg");

    // +5 g over 30 days
    await expect(w.locator(".d")).toHaveText("+5.0 g per month");
    await expect(w.locator(".d")).not.toHaveClass(/\bneg\b/);

    // Edit the newest to 142 g: −3 g over 30 days, shown as a loss
    const entries = page.locator(".timeline .entry");
    const dlg = page.locator("#mDlg");
    const editNewest = async grams => {
      await entries.nth(0).getByRole("button", { name: "Edit" }).click();
      await expect(dlg).toBeVisible();
      await expect(dlg.locator("[name=wunit]")).toHaveValue("g");
      await dlg.locator("[name=weight]").fill(grams);
      await saveMeasure(dlg);
      await expect(dlg).toBeHidden();
    };
    await editNewest("142");
    await expect(w.locator(".d")).toHaveText("−3.0 g per month");
    await expect(w.locator(".d")).toHaveClass(/\bneg\b/);
    await expect(w.locator(".v")).toHaveText("0.14 kg");

    // +30 g a month is shown in kg, as the setting asks
    await editNewest("175");
    await expect(w.locator(".d")).toHaveText("+0.03 kg per month");
    await expect(w.locator(".d")).not.toHaveClass(/\bneg\b/);

    expect((await readDb(page)).entries.find(e => e.id === "m-now")).toMatchObject({ date: today, weightG: 175 });
    expect((await storedSettings(page)).unit).toBe("kg");
  });

  // Regression: the confirm always said "and all N records", so a tortoise without records read "and all 0 records".
  // (1 and 2 records are covered in tortoise-care.spec.js.)
  test("deleting a tortoise that has no records left asks \"Delete Kuro? This can't be undone.\"", async ({ page }) => {
    const asked = [];
    let accept = false;
    page.on("dialog", d => { asked.push(d.message()); return accept ? d.accept() : d.dismiss(); });

    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    // One measurement, deleted again: nothing is left
    const dlg = await openMeasureDialog(page);
    await dlg.locator("[name=weight]").fill("450");
    await saveMeasure(dlg);
    await expect(dlg).toBeHidden();
    accept = true;
    await page.locator(".timeline .entry").first().getByRole("button", { name: "Delete" }).click();
    await expectToast(page, "Measurement deleted");
    await expect(page.locator(".timeline .entry")).toHaveCount(0);
    expect((await readDb(page)).entries).toEqual([]);
    expect(asked).toEqual(["Delete this measurement?"]);

    // Say no first: nothing changes
    accept = false;
    await page.getByRole("button", { name: "Delete Kuro" }).click();
    await expect.poll(() => asked.length).toBe(2);
    expect(asked[1]).toBe("Delete Kuro? This can't be undone.");
    await expect(page.locator(".profile h1")).toHaveText("Kuro");
    expect((await readDb(page)).tortoises).toHaveLength(1);

    // Then yes
    accept = true;
    await page.getByRole("button", { name: "Delete Kuro" }).click();
    await expectToast(page, "Kuro deleted");
    expect(asked).toEqual(["Delete this measurement?", "Delete Kuro? This can't be undone.", "Delete Kuro? This can't be undone."]);
    await expect(page.getByRole("heading", { name: "Start your first logbook" })).toBeVisible();
    expect(await readDb(page)).toEqual({ tortoises: [], entries: [] });
  });
});
