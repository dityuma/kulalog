// @ts-check
// Security and robustness of data Kulalog reads: shared backup files and records already in IndexedDB.
// Payloads only set window.__pwned; every test checks that no script ran and no markup was injected.
const { test, expect } = require("@playwright/test");
const { openApp, seed, readDb, expectToast, pageToday } = require("./helpers");

const BAD = "<img src=x onerror=__pwned=1>";            // markup that runs script if it reaches innerHTML
const BREAK = '" onmouseover="__pwned=1" x="';           // breaks out of a double-quoted attribute
const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Fonts aren't needed here. Chart.js is: the growth chart must draw with hostile data around.
test.beforeEach(async ({ context }) => {
  await context.route(/fonts\.googleapis\.com|fonts\.gstatic\.com/, r => r.abort());
});

const shift = (page, iso, n) => page.evaluate(([iso, n]) => shiftDay(iso, n), [iso, n]);

// Script ran, or an element carries an event-handler attribute it shouldn't (the fonts <link onload> is the app's own).
async function expectNothingInjected(page){
  const state = await page.evaluate(() => ({
    pwned: window["__pwned"] ?? null,
    handlers: [...document.querySelectorAll("*")]
      .filter(el => el.tagName !== "LINK" && [...el.attributes].some(a => a.name.startsWith("on")))
      .map(el => el.outerHTML.slice(0, 120)),
    strayImages: [...document.querySelectorAll('img[src="x"], svg[onload], #app script, dialog script')].length
  }));
  expect(state).toEqual({ pwned: null, handlers: [], strayImages: 0 });
}

function backupFile(tortoises, entries){
  return { name: "shared-backup.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ app: "kulalog", version: 1, exported: "2026-10-01T00:00:00.000Z", tortoises, entries })) };
}

async function importBackup(page, file){
  await page.locator("#importFile").setInputFiles(file);
}

test.describe("a hostile shared backup", () => {
  test("runs no script on any screen; text fields show literally; unusable records are dropped", async ({ page }) => {
    page.on("dialog", d => { throw new Error("unexpected dialog: " + d.message()); });
    await openApp(page);
    const today = await pageToday(page), yesterday = await shift(page, today, -1), older = await shift(page, today, -40), mid = await shift(page, today, -20);

    const name = "K" + BAD;                                  // 30 chars: kept whole, shown as text
    const tortoises = [
      { id: "t-evil", name, species: "<svg onload=__pwned=1>", sex: "Female", birth: "2024-02-30", createdAt: 1 },
      { id: "t" + BREAK, name: "Breakout id", species: "Leopard", sex: "Male", birth: null, createdAt: 2 }   // unsafe id: dropped
    ];
    const entries = [
      { id: "m-old", tortoiseId: "t-evil", kind: "measure", date: older, createdAt: 3, plastron: 10.2, scl: 12, weightG: 300,
        photo: PNG_1X1, notes: "=HYPERLINK(\"http://x\")" },
      { id: "m-mid", tortoiseId: "t-evil", kind: "measure", date: mid, createdAt: 3, plastron: 11, scl: null, weightG: null, photo: null, notes: "" },
      { id: "m-new", tortoiseId: "t-evil", kind: "measure", date: yesterday, createdAt: 4, plastron: 1.79e308, scl: 13, weightG: 420,
        photo: "data:image/png;base64,AAAA" + BREAK, notes: BAD },
      { id: "c-today", tortoiseId: "t-evil", kind: "care", date: today, createdAt: 5, soaked: true,
        food: [BAD, "Weeds"], foodNote: "<b onmouseover=__pwned=1>x</b>", poop: BAD, urates: "<i onclick=__pwned=1>u</i>", notes: BAD },
      { id: "c-break", tortoiseId: "t-evil", kind: "care", date: yesterday + BREAK, createdAt: 6, soaked: true },   // bad date: dropped
      { id: "m" + BREAK, tortoiseId: "t-evil", kind: "measure", date: older, createdAt: 7, weightG: 999 },          // bad id: dropped
      { id: "x-kind", tortoiseId: "t-evil", kind: "script", date: today, createdAt: 8 }                              // unknown kind: dropped
    ];
    await importBackup(page, backupFile(tortoises, entries));
    // Wording is covered in backup.spec.js; here only the counts matter.
    await expect(page.locator("#toast")).toContainText(/Imported 1 tortoises? and 4 entr/);

    // Home list: nothing injected, and the name is text, not markup.
    const card = page.locator(".t-card");
    await expect(card).toHaveCount(1);
    await expectNothingInjected(page);
    await expect(card.locator("h2")).toHaveText(name);
    await expect(card.locator(".sp").first()).toHaveText("<svg onload=__pwned=1>");
    await expectNothingInjected(page);

    // Tortoise page, Daily care, 7 days.
    await card.click();
    await expect(page.locator(".profile h1")).toHaveText(name);
    await expect(page.locator(".profile .meta .chip")).toHaveText(["Female"]);   // the impossible hatch date was dropped: no age chip
    const todayRow = page.locator(`button.day[data-day="${today}"]`);
    await expect(todayRow.locator(".chip", { hasText: "Poop:" })).toHaveText("Poop: " + BAD);
    await expect(todayRow.locator(".nt")).toHaveText(BAD);
    await expectNothingInjected(page);

    // Re-opening the day fills the form with the text as plain values.
    await todayRow.click();
    const cDlg = page.locator("#cDlg");
    await expect(cDlg).toBeVisible();
    await expect(cDlg.locator("[name=foodNote]")).toHaveValue("<b onmouseover=__pwned=1>x</b>");
    await expect(cDlg.locator("[name=notes]")).toHaveValue(BAD);
    await cDlg.locator("[data-close]").first().click();
    await expectNothingInjected(page);

    // Month view.
    await page.locator('[data-cv="month"]').first().click();
    await expect(page.locator(".cal .cell.today .dot")).not.toHaveCount(0);
    await expectNothingInjected(page);

    // Growth tab: the absurd plastron was dropped, so the plastron chart draws (Chart.js froze on 1.79e308).
    await page.locator("#tab-growth").click();
    await expect(page.locator(".timeline .entry")).toHaveCount(3);
    await expect(page.locator(".timeline .entry").first().locator(".entry-notes")).toHaveText(BAD);
    await expect(page.locator(".timeline .entry-photo")).toHaveCount(1);     // the broken-out photo became null; the good one stays
    await page.locator('[data-m="plastron"]').click();
    await expect.poll(() => page.evaluate(() => { const c = window["Chart"] && window["Chart"].getChart("cv"); return c ? c.data.datasets[0].data.map(p => p.y) : null; }),
      { timeout: 20_000 }).toEqual([10.2, 11]);
    await expectNothingInjected(page);

    // Lightbox.
    await page.locator(".timeline .entry-photo").click();
    await expect(page.locator("#lightbox")).toBeVisible();
    await expectNothingInjected(page);
    await page.locator("#lightbox [data-close]").click();

    // Stored data is the cleaned data.
    const db = await readDb(page);
    expect(db.tortoises.map(t => t.id)).toEqual(["t-evil"]);
    expect(db.tortoises[0].birth).toBeNull();
    expect(db.entries.map(e => e.id).sort()).toEqual(["c-today", "m-mid", "m-new", "m-old"]);
    const mNew = db.entries.find(e => e.id === "m-new");
    expect(mNew.photo).toBeNull();
    expect(mNew.plastron).toBeNull();
    expect(mNew.scl).toBe(13);

    // After a reload (records come from storage) nothing runs either.
    await page.reload();
    await expect(page.locator(".profile h1")).toHaveText(name);
    await expectNothingInjected(page);
  });

  test("CSV export keeps the text and neutralises spreadsheet formulas", async ({ page }) => {
    await openApp(page);
    const today = await pageToday(page);
    await importBackup(page, backupFile(
      [{ id: "t1", name: "=cmd|' /C calc'!A0", species: "Leopard", sex: "Unknown", birth: null, createdAt: 1 }],
      [{ id: "m1", tortoiseId: "t1", kind: "measure", date: today, createdAt: 2, weightG: 300, plastron: null, scl: null, photo: null, notes: "@SUM(1+1)" }]
    ));
    await expect(page.locator("#toast")).toContainText(/Imported 1 tortoises? and 1 entr/);
    await page.locator("#openSettings").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#exportCsv").click()]);
    const csv = require("fs").readFileSync(await download.path(), "utf8");
    expect(csv).toContain(`'=cmd|' /C calc'!A0`);
    expect(csv).toContain(`'@SUM(1+1)`);
    expect(csv).not.toMatch(/(^|,)=cmd/m);
  });
});

test.describe("records already in storage", () => {
  test("records written straight into IndexedDB with attribute breakouts run no script and don't break the page", async ({ page }) => {
    await openApp(page);
    const today = await pageToday(page);
    // Written directly, bypassing the backup checks (as data imported by an older version would be).
    await seed(page, {
      tortoises: [
        { id: "good", name: "Goodie", species: "Leopard", sex: "Male", birth: null, createdAt: 1 },
        { id: "bad" + BREAK, name: "Bad id", species: "Leopard", sex: "Male", birth: null, createdAt: 2 }
      ],
      entries: [
        { id: "m1", tortoiseId: "good", kind: "measure", date: today, createdAt: 3, weightG: 500, plastron: null, scl: null,
          photo: "data:image/jpeg;base64,AAAA" + BREAK, notes: "" },
        { id: "c1", tortoiseId: "good", kind: "care", date: today + BREAK, createdAt: 4, soaked: true },
        { id: "e" + BREAK, tortoiseId: "good", kind: "care", date: today, createdAt: 5, soaked: true }
      ]
    });
    await expect(page.locator(".t-card").first()).toBeVisible();
    await expectNothingInjected(page);
    await expect(page.locator(".t-card h2")).toHaveText(["Goodie"]);
    await page.locator(".t-card").click();
    await expect(page.locator(".profile h1")).toHaveText("Goodie");
    await expectNothingInjected(page);
    await page.locator("#tab-growth").click();
    await expect(page.locator(".timeline .entry")).toHaveCount(1);
    await expect(page.locator(".timeline .entry-photo")).toHaveCount(0);
    await expectNothingInjected(page);
    // The malformed records are not deleted from storage, only not shown.
    expect((await readDb(page)).entries).toHaveLength(3);
  });

  // Regression: one malformed stored record (e.g. from an import before backups were checked) threw while rendering
  // and left the home list or the tortoise page blank, or made the boot migration throw so nothing rendered at all.
  test("malformed stored records don't blank the home list, the tortoise page or the boot", async ({ page }) => {
    await openApp(page);
    const today = await pageToday(page), yesterday = await shift(page, today, -1);
    await seed(page, {
      tortoises: [{ id: "t1", name: "Sturdy", species: "Leopard", sex: "Female", birth: null, createdAt: 1 }],
      entries: [
        { id: "m1", tortoiseId: "t1", kind: "measure", date: today, createdAt: 2, plastron: "12", scl: null, weightG: 450, photo: null, notes: "" },
        { id: "c1", tortoiseId: "t1", kind: "care", date: today, createdAt: 3, soaked: true, food: 5, foodNote: "", poop: "", urates: "", notes: "" },
        { id: "legacy1", tortoiseId: "t1", date: yesterday, createdAt: 4, weightG: 400, soaked: true, food: 5 }
      ]
    });
    await expect(page.locator(".t-card h2")).toHaveText(["Sturdy"]);
    await expect(page.locator(".t-card .nums b")).toHaveText("450 g");
    await page.locator(".t-card").click();
    await expect(page.locator(".profile h1")).toHaveText("Sturdy");
    await expect(page.locator(`button.day[data-day="${today}"] .chip.shell`)).toHaveText("Soaked");
    await expect(page.locator(`button.day[data-day="${yesterday}"] .chip.shell`)).toHaveText("Soaked");   // migrated legacy record
    await page.locator("#tab-growth").click();
    await expect(page.locator(".timeline .entry")).toHaveCount(2);
    await expect(page.locator(".timeline .entry").first()).toContainText("450 g");
  });

  test("a hash route with markup in it renders nothing from the hash", async ({ page }) => {
    await openApp(page);
    await page.goto("./#t/" + encodeURIComponent(BAD));
    await expect(page.locator(".empty h2")).toHaveText("Start your first logbook");
    await page.goto("./#t/" + BAD);
    await expect(page.locator(".empty h2")).toHaveText("Start your first logbook");
    await expectNothingInjected(page);
  });
});
