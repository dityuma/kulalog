// E1 (adding, editing, listing and deleting tortoises) and E2 (daily care log) end-to-end tests.
// Runs in both Playwright projects: desktop-chrome and pixel-7.
const { test, expect } = require("@playwright/test");
const { openApp, addTortoise, seed, readDb, expectToast, pageToday } = require("./helpers");

/* ---------- Local helpers ---------- */

// Every test reads "today" from the page and compares rows, titles and ids against it. Start the page clock at noon
// (Asia/Jakarta) of the real current day and let it run, so a run that crosses midnight can't move the app to the next
// day half way through a test. Time keeps flowing, so createdAt still differs between saves.
const noonToday = () => new Date(new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" }) + "T12:00:00+07:00");
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: noonToday() });
});

// Id of the tortoise whose page is open (URL hash is #t/<id>).
const currentTid = page => new URL(page.url()).hash.replace(/^#t\//, "");

// Handle the next confirm() once: accept or dismiss it, and resolve with its message.
function nextConfirm(page, accept){
  return new Promise(resolve => page.once("dialog", async d => {
    const info = { type: d.type(), message: d.message() };
    if(accept) await d.accept(); else await d.dismiss();
    resolve(info);
  }));
}

// Date helpers evaluated with the app's own date logic, in the page's timezone.
const shift = (page, iso, n) => page.evaluate(([iso, n]) => shiftDay(iso, n), [iso, n]);
const fmt = (page, iso) => page.evaluate(iso => fmtDate(iso), iso);
const dayMonth = (page, iso) => page.evaluate(iso => dateObj(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }), iso);

// A hatch date exactly 14 months before today (day clamped to 28 so the month always exists).
const hatchDate14MonthsAgo = page => page.evaluate(() => {
  const [y, m, d] = todayISO().split("-").map(Number);
  return todayISO(new Date(y, m - 1 - 14, Math.min(d, 28)));
});

const statValue = (page, label) =>
  page.locator(".stats .stat").filter({ has: page.locator(".k", { hasText: new RegExp(`^${label}$`) }) }).locator(".v");
const dayRow = (page, iso) => page.locator(`.days button.day[data-day="${iso}"]`);
const careDlg = page => page.locator("#cDlg");
const foodChip = (dlg, food) => dlg.locator("#foodChips label").filter({ hasText: food });
const foodBox = (dlg, food) => dlg.locator(`#foodChips input[value="${food}"]`);

// Fill the open care dialog. Food chips are toggled by clicking their visible label.
async function fillCare(dlg, { soaked, foods = [], other, poop, urates, notes } = {}){
  if(soaked != null) await dlg.locator("[name=soaked]").setChecked(soaked);
  for(const f of foods) await foodChip(dlg, f).click();
  if(other != null) await dlg.getByRole("textbox", { name: "Other food" }).fill(other);
  if(poop != null) await dlg.locator("[name=poop]").selectOption(poop);
  if(urates != null) await dlg.locator("[name=urates]").selectOption(urates);
  if(notes != null) await dlg.locator("[name=notes]").fill(notes);
}
const saveCare = dlg => dlg.getByRole("button", { name: "Save care" }).click();

// The app shows/hides some controls by toggling the `hidden` attribute. These check that the app's logic sets it;
// whether the page's CSS actually honours it is checked by the regression tests at the end of this file.
const expectMarkedHidden = loc => expect(loc).toHaveAttribute("hidden", "");
async function expectShown(loc){
  await expect(loc).not.toHaveAttribute("hidden");
  await expect(loc).toBeVisible();
}

// Care records of one tortoise in IndexedDB.
async function caresInDb(page, tid){
  const { entries } = await readDb(page);
  return entries.filter(e => e.kind === "care" && e.tortoiseId === tid);
}

/* ---------- E1: tortoises ---------- */

test.describe("E1 add / edit / list / delete tortoises", () => {
  test("first visit shows the empty state; the add form refuses a missing name or species", async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole("heading", { name: "Start your first logbook" })).toBeVisible();
    await expect(page.locator(".t-card")).toHaveCount(0);

    await page.locator("#addT").click();
    const dlg = page.locator("#tDlg");
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("#tDlgTitle")).toHaveText("Add tortoise");
    await expect(dlg.locator("#tSave")).toHaveText("Save tortoise");
    await expectMarkedHidden(dlg.locator("#speciesOtherWrap"));

    // Completely empty name: the field is `required`, so the browser blocks the submit and nothing is saved.
    await dlg.locator("#tSave").click();
    await expect(dlg).toBeVisible();
    expect(await dlg.locator("[name=name]").evaluate(el => el.validity.valueMissing)).toBe(true);
    expect((await readDb(page)).tortoises).toHaveLength(0);

    // A name of only spaces gets past the browser and the app's own check rejects it.
    await dlg.locator("[name=name]").fill("   ");
    await dlg.locator("#tSave").click();
    await expect(dlg.locator("#tErr")).toBeVisible();
    await expect(dlg.locator("#tErr")).toHaveText("Give your tortoise a name.");
    await expect(dlg).toBeVisible();
    expect((await readDb(page)).tortoises).toHaveLength(0);

    // "Other" reveals the species name field, which is then required.
    await dlg.locator("[name=name]").fill("Pebble");
    await dlg.locator("[name=species]").selectOption("Other");
    await expectShown(dlg.locator("#speciesOtherWrap"));
    await expect(dlg.getByLabel("Species name")).toBeVisible();
    await dlg.locator("#tSave").click();
    await expect(dlg.locator("#tErr")).toHaveText("Type the species name, or pick one from the list.");
    await dlg.locator("[name=speciesOther]").fill("   ");
    await dlg.locator("#tSave").click();
    await expect(dlg.locator("#tErr")).toHaveText("Type the species name, or pick one from the list.");
    await expect(dlg).toBeVisible();
    expect((await readDb(page)).tortoises).toHaveLength(0);

    // Picking a listed species hides the field again.
    await dlg.locator("[name=species]").selectOption("Leopard");
    await expectMarkedHidden(dlg.locator("#speciesOtherWrap"));

    // Cancel leaves nothing behind.
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByRole("heading", { name: "Start your first logbook" })).toBeVisible();
    expect((await readDb(page)).tortoises).toHaveLength(0);
  });

  test("add a tortoise with a custom species, see its page and home card, rename it", async ({ page }) => {
    await openApp(page);
    const birth = await hatchDate14MonthsAgo(page);

    await page.locator("#addT").click();
    const dlg = page.locator("#tDlg");
    await dlg.locator("[name=name]").fill("Kuro");
    await dlg.locator("[name=species]").selectOption("Other");
    await dlg.locator("[name=speciesOther]").fill("Pancake tortoise");
    await dlg.locator("[name=sex]").selectOption("Female");
    await dlg.locator("[name=birth]").fill(birth);
    await dlg.locator("#tSave").click();
    await expect(dlg).toBeHidden();

    // Lands on the tortoise page.
    await expect(page).toHaveURL(/#t\/[a-z0-9]+$/);
    const tid = currentTid(page);
    await expectToast(page, "Kuro added");
    await expect(page.locator(".profile h1")).toHaveText("Kuro");
    await expect(page.locator(".profile .sp")).toHaveText("Pancake tortoise");
    await expect(page.locator(".profile .meta .chip")).toHaveText(["Female", "1 yr 2 mo old"]);

    let db = await readDb(page);
    expect(db.tortoises).toHaveLength(1);
    expect(db.tortoises[0]).toMatchObject({ id: tid, name: "Kuro", species: "Pancake tortoise", sex: "Female", birth });

    // Back to the list.
    await page.getByRole("button", { name: "‹ All tortoises" }).click();
    await expect(page).not.toHaveURL(/#t\//);
    await expect(page.getByRole("heading", { name: "Your tortoises" })).toBeVisible();
    await expect(page.locator(".home-head p")).toHaveText("1 in your care");
    const card = page.locator(".t-card");
    await expect(card).toHaveCount(1);
    await expect(card.locator("h2")).toHaveText("Kuro");
    await expect(card.locator(".sp").first()).toHaveText("Pancake tortoise");
    await expect(card.locator(".sp").nth(1)).toHaveText("No care logged yet");

    // The card opens the tortoise again.
    await card.click();
    await expect(page).toHaveURL(new RegExp(`#t/${tid}$`));
    await expect(page.locator(".profile h1")).toHaveText("Kuro");

    // Edit details: the form is prefilled, including the custom species.
    await page.getByRole("button", { name: "Edit details" }).click();
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("#tDlgTitle")).toHaveText("Edit tortoise");
    await expect(dlg.locator("#tSave")).toHaveText("Save changes");
    await expect(dlg.locator("[name=name]")).toHaveValue("Kuro");
    await expect(dlg.locator("[name=species]")).toHaveValue("Other");
    await expectShown(dlg.locator("#speciesOtherWrap"));
    await expect(dlg.locator("[name=speciesOther]")).toHaveValue("Pancake tortoise");
    await expect(dlg.locator("[name=sex]")).toHaveValue("Female");
    await expect(dlg.locator("[name=birth]")).toHaveValue(birth);

    await dlg.locator("[name=name]").fill("Mochi");
    await dlg.locator("#tSave").click();
    await expect(dlg).toBeHidden();
    await expectToast(page, "Changes saved");
    await expect(page.locator(".profile h1")).toHaveText("Mochi");
    await expect(page).toHaveURL(new RegExp(`#t/${tid}$`));
    await expect(page.getByRole("button", { name: "Delete Mochi" })).toBeVisible();

    db = await readDb(page);
    expect(db.tortoises).toHaveLength(1);
    expect(db.tortoises[0]).toMatchObject({ id: tid, name: "Mochi", species: "Pancake tortoise", sex: "Female", birth });

    // The rename survives a reload.
    await page.reload();
    await expect(page.locator(".profile h1")).toHaveText("Mochi");
    await expect(page.locator(".profile .meta .chip")).toHaveText(["Female", "1 yr 2 mo old"]);
    await page.getByRole("button", { name: "‹ All tortoises" }).click();
    await expect(page.locator(".t-card h2")).toHaveText(["Mochi"]);
  });

  test("editing a listed-species tortoise: prefilled, Cancel keeps it, species/sex/hatch date changes save, Add afterwards makes a new one", async ({ page }) => {
    await openApp(page);
    const birth = await hatchDate14MonthsAgo(page);
    await addTortoise(page, { name: "Zeno", species: "Leopard", sex: "Male", birth });
    const zeno = currentTid(page);
    await expect(page.locator(".profile .meta .chip")).toHaveText(["Male", "1 yr 2 mo old"]);
    const dlg = page.locator("#tDlg");

    // The form opens on the listed species, not on "Other" with the name typed in.
    await page.getByRole("button", { name: "Edit details" }).click();
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("[name=species]")).toHaveValue("Leopard");
    await expectMarkedHidden(dlg.locator("#speciesOtherWrap"));
    await expect(dlg.locator("[name=speciesOther]")).toHaveValue("");
    await expect(dlg.locator("[name=sex]")).toHaveValue("Male");
    await expect(dlg.locator("[name=birth]")).toHaveValue(birth);

    // Cancel throws the changes away, and the next Edit shows the stored values again.
    await dlg.locator("[name=name]").fill("Nope");
    await dlg.locator("[name=sex]").selectOption("Female");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.locator(".profile h1")).toHaveText("Zeno");
    expect((await readDb(page)).tortoises).toEqual([expect.objectContaining({ id: zeno, name: "Zeno", species: "Leopard", sex: "Male", birth })]);
    await page.getByRole("button", { name: "Edit details" }).click();
    await expect(dlg.locator("[name=name]")).toHaveValue("Zeno");
    await expect(dlg.locator("[name=sex]")).toHaveValue("Male");

    // Change species, sex and clear the hatch date; surrounding spaces in the name are dropped.
    await dlg.locator("[name=name]").fill("  Zeno Jr  ");
    await dlg.locator("[name=species]").selectOption("Hermann's");
    await dlg.locator("[name=sex]").selectOption("Female");
    await dlg.locator("[name=birth]").fill("");
    await dlg.locator("#tSave").click();
    await expect(dlg).toBeHidden();
    await expectToast(page, "Changes saved");
    await expect(page.locator(".profile h1")).toHaveText("Zeno Jr");
    await expect(page.locator(".profile .sp")).toHaveText("Hermann's");
    await expect(page.locator(".profile .meta .chip")).toHaveText(["Female"]);
    let db = await readDb(page);
    expect(db.tortoises).toHaveLength(1);
    expect(db.tortoises[0]).toMatchObject({ id: zeno, name: "Zeno Jr", species: "Hermann's", sex: "Female", birth: null });

    // Add right after an edit: a blank form, and saving makes a second tortoise without touching the edited one.
    await page.getByRole("button", { name: "‹ All tortoises" }).click();
    await page.locator("#addT").click();
    await expect(dlg.locator("#tDlgTitle")).toHaveText("Add tortoise");
    await expect(dlg.locator("[name=name]")).toHaveValue("");
    await expect(dlg.locator("[name=species]")).toHaveValue("Sulcata (African spurred)");
    await expect(dlg.locator("[name=sex]")).toHaveValue("Unknown");
    await expect(dlg.locator("[name=birth]")).toHaveValue("");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await addTortoise(page, { name: "Bento", species: "Other", speciesOther: "Pancake tortoise" });
    await expectToast(page, "Bento added");
    const bento = currentTid(page);
    expect(bento).not.toBe(zeno);
    db = await readDb(page);
    expect(db.tortoises).toHaveLength(2);
    expect(db.tortoises.find(t => t.id === zeno)).toMatchObject({ name: "Zeno Jr", species: "Hermann's", sex: "Female", birth: null });
    expect(db.tortoises.find(t => t.id === bento)).toMatchObject({ name: "Bento", species: "Pancake tortoise", sex: "Unknown", birth: null });
    await page.getByRole("button", { name: "‹ All tortoises" }).click();
    await expect(page.locator(".t-card h2")).toHaveText(["Bento", "Zeno Jr"]);
  });

  test("two tortoises are listed sorted by name; deleting one removes it and its entries", async ({ page }) => {
    await openApp(page);
    // Added in reverse alphabetical order so the list order proves the sort.
    await addTortoise(page, { name: "Zeno", species: "Leopard", sex: "Male" });
    const zeno = currentTid(page);
    await page.getByRole("button", { name: "‹ All tortoises" }).click();
    await addTortoise(page, { name: "Bento", species: "Hermann's", sex: "Female" });
    const bento = currentTid(page);
    expect(bento).not.toBe(zeno);
    await page.getByRole("button", { name: "‹ All tortoises" }).click();

    await expect(page.locator(".home-head p")).toHaveText("2 in your care");
    await expect(page.locator(".t-card h2")).toHaveText(["Bento", "Zeno"]);
    await expect(page.locator(".t-card")).toHaveText([/Bento.*Hermann's/, /Zeno.*Leopard/]);

    // Give both tortoises some records.
    const today = await pageToday(page);
    const care = (tid, date, extra) => ({ id: `c_${tid}_${date}`, kind: "care", tortoiseId: tid, date, createdAt: 1,
      soaked: false, food: [], foodNote: "", poop: "", urates: "", notes: "", ...extra });
    await seed(page, { entries: [
      care(zeno, today, { soaked: true }),
      { id: "m_zeno_1", kind: "measure", tortoiseId: zeno, date: today, createdAt: 2, plastron: 10.2, scl: 11, weightG: 300, photo: null, notes: "" },
      care(bento, today, { food: ["Weeds"] })
    ] });
    await expect(page.locator(".t-card").filter({ hasText: "Zeno" })).toContainText("Last soaked today");
    await expect(page.locator(".t-card").filter({ hasText: "Bento" })).toContainText("Not soaked yet");

    await page.locator(".t-card").filter({ hasText: "Zeno" }).click();
    await expect(page.locator(".profile h1")).toHaveText("Zeno");

    // Dismissing the confirm keeps everything.
    let confirmP = nextConfirm(page, false);
    await page.getByRole("button", { name: "Delete Zeno" }).click();
    const dismissed = await confirmP;
    expect(dismissed.type).toBe("confirm");
    expect(dismissed.message).toBe("Delete Zeno and all 2 records? This can't be undone.");
    await expect(page.locator(".profile h1")).toHaveText("Zeno");
    let db = await readDb(page);
    expect(db.tortoises).toHaveLength(2);
    expect(db.entries).toHaveLength(3);

    // Accepting deletes the tortoise and all its records, but nothing of the other one.
    confirmP = nextConfirm(page, true);
    await page.getByRole("button", { name: "Delete Zeno" }).click();
    await confirmP;
    await expectToast(page, "Zeno deleted");
    await expect(page).not.toHaveURL(/#t\//);
    await expect(page.locator(".home-head p")).toHaveText("1 in your care");
    await expect(page.locator(".t-card h2")).toHaveText(["Bento"]);

    db = await readDb(page);
    expect(db.tortoises.map(t => t.id)).toEqual([bento]);
    expect(db.entries.filter(e => e.tortoiseId === zeno)).toEqual([]);
    expect(db.entries.map(e => e.id)).toEqual([`c_${bento}_${today}`]);

    // A link to the deleted tortoise falls back to the home list.
    await page.goto("./#t/" + zeno);
    await expect(page.getByRole("heading", { name: "Your tortoises" })).toBeVisible();
    await expect(page.locator(".profile")).toHaveCount(0);

    // Deleting the last one brings back the empty state.
    await page.locator(".t-card").filter({ hasText: "Bento" }).click();
    confirmP = nextConfirm(page, true);
    await page.getByRole("button", { name: "Delete Bento" }).click();
    // Singular for one record (regression: it used to say "all 1 records").
    expect((await confirmP).message).toBe("Delete Bento and its 1 record? This can't be undone.");
    await expect(page.getByRole("heading", { name: "Start your first logbook" })).toBeVisible();
    db = await readDb(page);
    expect(db.tortoises).toEqual([]);
    expect(db.entries).toEqual([]);
  });
});

/* ---------- E2: daily care ---------- */

test.describe("E2 daily care log", () => {
  test("logging today's care: an empty save is refused, a full log shows in the list, stats and home card", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    const tid = currentTid(page);
    const today = await pageToday(page);
    const yesterday = await shift(page, today, -1);

    // Before anything is logged.
    await expect(statValue(page, "Last soaked")).toHaveText("Not yet");
    await expect(statValue(page, "Last fed")).toHaveText("Not yet");
    await expect(statValue(page, "Last poop check")).toHaveText("Not yet");
    await expect(page.locator(".days li")).toHaveCount(7);
    await expect(dayRow(page, today).locator(".dlabel b")).toHaveText("Today");
    await expect(dayRow(page, yesterday).locator(".dlabel b")).toHaveText("Yesterday");
    // Newest first: Today at the top, then the six days before it, labelled by weekday.
    const week = [today];
    for(let i = 1; i < 7; i++) week.push(await shift(page, today, -i));
    const weekdays = await page.evaluate(days => days.map(d => dateObj(d).toLocaleDateString("en-GB", { weekday: "short" })), week.slice(2));
    for(const [i, iso] of week.entries()) await expect(page.locator(".days button.day").nth(i)).toHaveAttribute("data-day", iso);
    await expect(page.locator(".days button.day .dlabel b")).toHaveText(["Today", "Yesterday", ...weekdays]);
    await expect(dayRow(page, today).locator(".marks")).toHaveText("Nothing logged. Tap to add.");

    // The care button also works from the Growth tab; saving switches back to Daily care so the new record shows.
    await page.getByRole("tab", { name: "Growth" }).click();
    await expect(page.getByRole("tab", { name: "Growth" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".days")).toHaveCount(0);
    await page.getByRole("button", { name: "Log today's care" }).click();
    const dlg = careDlg(page);
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("#cDlgTitle")).toHaveText("Today's care");
    await expect(dlg.locator("[name=date]")).toHaveValue(today);
    await expect(dlg.locator("#cHint")).toBeHidden();
    await expectMarkedHidden(dlg.locator("#cClear"));

    // Nothing filled in.
    await saveCare(dlg);
    await expect(dlg.locator("#cErr")).toBeVisible();
    await expect(dlg.locator("#cErr")).toHaveText("Fill in at least one thing before saving.");
    await expect(dlg).toBeVisible();
    expect(await caresInDb(page, tid)).toHaveLength(0);

    await fillCare(dlg, { soaked: true, foods: ["Grass / hay", "Flowers"], other: "dandelion", poop: "Normal, firm", notes: "Active, ate well" });
    await expect(foodBox(dlg, "Grass / hay")).toBeChecked();
    await expect(foodBox(dlg, "Flowers")).toBeChecked();
    await expect(foodBox(dlg, "Leafy greens")).not.toBeChecked();
    await saveCare(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Care saved");
    await expect(page.getByRole("tab", { name: "Daily care" })).toHaveAttribute("aria-selected", "true");

    // The Today row in the 7-day list.
    const row = dayRow(page, today);
    await expect(row.locator(".marks .chip")).toHaveText(["Soaked", "Grass / hay, Flowers +1", "Poop: Normal, firm"]);
    await expect(row.locator(".chip.shell")).toHaveText("Soaked");
    await expect(row.locator(".chip", { hasText: "Poop:" })).not.toHaveClass(/\bbad\b/);
    await expect(row.locator(".nt")).toHaveText("Active, ate well");
    // Accessible name = hidden "Edit care for" + the visible label, so voice control can use what is on screen.
    await expect(row).not.toHaveAttribute("aria-label");
    await expect(row).toHaveAccessibleName(new RegExp(`^Edit care for Today ${await dayMonth(page, today)} Soaked`));

    await expect(statValue(page, "Last soaked")).toHaveText("Today");
    await expect(statValue(page, "Last fed")).toHaveText("Today");
    await expect(statValue(page, "Last poop check")).toHaveText("Today");

    const cares = await caresInDb(page, tid);
    expect(cares).toHaveLength(1);
    expect(cares[0]).toMatchObject({
      id: `c_${tid}_${today}`, kind: "care", tortoiseId: tid, date: today, soaked: true,
      food: ["Grass / hay", "Flowers"], foodNote: "dandelion", poop: "Normal, firm", urates: "", notes: "Active, ate well"
    });

    // Home card.
    await page.getByRole("button", { name: "‹ All tortoises" }).click();
    await expect(page.locator(".t-card").filter({ hasText: "Kuro" })).toContainText("Last soaked today");
  });

  test("re-opening today's care prefills it and saving updates the same single record", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    const tid = currentTid(page);
    const today = await pageToday(page);
    const dlg = careDlg(page);

    await page.getByRole("button", { name: "Log today's care" }).click();
    await fillCare(dlg, { soaked: true, foods: ["Grass / hay", "Flowers"], other: "dandelion", poop: "Normal, firm", notes: "Active" });
    await saveCare(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Care saved");
    const [first] = await caresInDb(page, tid);

    // Re-open through the Today row.
    await dayRow(page, today).click();
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("#cDlgTitle")).toHaveText("Today's care");
    await expect(dlg.locator("#cHint")).toBeVisible();
    await expect(dlg.locator("#cHint")).toHaveText(/^Already logged for this day\./);
    await expectShown(dlg.locator("#cClear"));
    await expect(dlg.locator("[name=date]")).toHaveValue(today);
    await expect(dlg.locator("[name=soaked]")).toBeChecked();
    await expect(foodBox(dlg, "Grass / hay")).toBeChecked();
    await expect(foodBox(dlg, "Flowers")).toBeChecked();
    await expect(foodBox(dlg, "Leafy greens")).not.toBeChecked();
    await expect(dlg.getByRole("textbox", { name: "Other food" })).toHaveValue("dandelion");
    await expect(dlg.locator("[name=poop]")).toHaveValue("Normal, firm");
    await expect(dlg.locator("[name=urates]")).toHaveValue("");
    await expect(dlg.locator("[name=notes]")).toHaveValue("Active");

    // Change it.
    await fillCare(dlg, { soaked: false, foods: ["Flowers"], poop: "Soft", urates: "Soft white paste", notes: "Quiet day" });
    await expect(foodBox(dlg, "Flowers")).not.toBeChecked();
    await saveCare(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Care updated");

    const cares = await caresInDb(page, tid);
    expect(cares).toHaveLength(1);
    expect(cares[0]).toMatchObject({
      id: `c_${tid}_${today}`, date: today, soaked: false, food: ["Grass / hay"], foodNote: "dandelion",
      poop: "Soft", urates: "Soft white paste", notes: "Quiet day", createdAt: first.createdAt
    });
    expect((await readDb(page)).entries).toHaveLength(1);

    const row = dayRow(page, today);
    await expect(row.locator(".marks .chip")).toHaveText(["Grass / hay, dandelion", "Poop: Soft", "Urates: Soft white paste"]);
    await expect(statValue(page, "Last soaked")).toHaveText("Not yet");
    await expect(statValue(page, "Last fed")).toHaveText("Today");
    await expect(statValue(page, "Last poop check")).toHaveText("Today");

    // Emptying an existing day is refused with a pointer to "Clear this day"; the record stays.
    await page.getByRole("button", { name: "Log today's care" }).click();
    await expect(dlg.locator("#cHint")).toBeVisible();
    await expect(foodBox(dlg, "Grass / hay")).toBeChecked();
    await fillCare(dlg, { foods: ["Grass / hay"], other: "", poop: "", urates: "", notes: "" });
    await saveCare(dlg);
    await expect(dlg.locator("#cErr")).toHaveText("Nothing is filled in. Use Clear this day to remove the record.");
    await expect(dlg).toBeVisible();
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();
    expect(await caresInDb(page, tid)).toHaveLength(1);
    expect((await caresInDb(page, tid))[0].food).toEqual(["Grass / hay"]);
  });

  test("yesterday via its row, switching the dialog date loads and saves that day, clearing a day, bad poop chip", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    const tid = currentTid(page);
    const today = await pageToday(page);
    const yesterday = await shift(page, today, -1);
    const threeAgo = await shift(page, today, -3);
    const tenAgo = await shift(page, today, -10);
    const dlg = careDlg(page);

    // A care record older than the 7-day list.
    await seed(page, { entries: [{ id: `c_${tid}_${tenAgo}`, kind: "care", tortoiseId: tid, date: tenAgo, createdAt: 1,
      soaked: false, food: [], foodNote: "", poop: "", urates: "", notes: "Old note" }] });
    await expect(page.locator(".profile h1")).toHaveText("Kuro");
    await expect(page.locator(`.days [data-day="${tenAgo}"]`)).toHaveCount(0);

    // Today.
    await page.getByRole("button", { name: "Log today's care" }).click();
    await fillCare(dlg, { soaked: true, foods: ["Leafy greens"] });
    await saveCare(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Care saved");

    // Yesterday, through its row in the 7-day list.
    await dayRow(page, yesterday).click();
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("#cDlgTitle")).toHaveText("Yesterday's care");
    await expect(dlg.locator("[name=date]")).toHaveValue(yesterday);
    await expect(dlg.locator("#cHint")).toBeHidden();
    await expectMarkedHidden(dlg.locator("#cClear"));
    await expect(dlg.locator("[name=soaked]")).not.toBeChecked();
    await expect(dlg.locator("#foodChips input:checked")).toHaveCount(0);
    await fillCare(dlg, { foods: ["Grass / hay"], poop: "Runny", urates: "Gritty / chalky" });
    await saveCare(dlg);
    await expect(dlg).toBeHidden();

    let cares = await caresInDb(page, tid);
    expect(cares.map(c => c.id).sort()).toEqual([`c_${tid}_${tenAgo}`, `c_${tid}_${today}`, `c_${tid}_${yesterday}`].sort());
    expect(cares.find(c => c.date === yesterday)).toMatchObject({ soaked: false, food: ["Grass / hay"], poop: "Runny", urates: "Gritty / chalky" });

    // Bad poop and urates are flagged; normal values are not.
    const yRow = dayRow(page, yesterday);
    await expect(yRow.locator(".marks .chip")).toHaveText(["Grass / hay", "Poop: Runny", "Urates: Gritty / chalky"]);
    await expect(yRow.locator(".chip", { hasText: "Poop: Runny" })).toHaveClass(/\bbad\b/);
    await expect(yRow.locator(".chip", { hasText: "Urates: Gritty / chalky" })).toHaveClass(/\bbad\b/);
    await expect(yRow.locator(".chip", { hasText: "Grass / hay" })).not.toHaveClass(/\bbad\b/);
    await expect(dayRow(page, today).locator(".marks .chip")).toHaveText(["Soaked", "Leafy greens"]);
    await expect(dayRow(page, today).locator(".chip.bad")).toHaveCount(0);

    // Inside the dialog, changing the date loads the chosen day's record.
    await page.getByRole("button", { name: "Log today's care" }).click();
    await expect(dlg.locator("#cDlgTitle")).toHaveText("Today's care");
    await expect(dlg.locator("[name=soaked]")).toBeChecked();
    await dlg.locator("[name=date]").fill(yesterday);
    await expect(dlg.locator("#cDlgTitle")).toHaveText("Yesterday's care");
    await expect(dlg.locator("#cHint")).toBeVisible();
    await expectShown(dlg.locator("#cClear"));
    await expect(dlg.locator("[name=soaked]")).not.toBeChecked();
    await expect(foodBox(dlg, "Grass / hay")).toBeChecked();
    await expect(foodBox(dlg, "Leafy greens")).not.toBeChecked();
    await expect(dlg.locator("[name=poop]")).toHaveValue("Runny");
    await expect(dlg.locator("[name=urates]")).toHaveValue("Gritty / chalky");

    // A day older than the list also loads.
    await dlg.locator("[name=date]").fill(tenAgo);
    await expect(dlg.locator("#cDlgTitle")).toHaveText(`Care on ${await fmt(page, tenAgo)}`);
    await expect(dlg.locator("#cHint")).toBeVisible();
    await expect(dlg.locator("[name=notes]")).toHaveValue("Old note");
    await expect(dlg.locator("[name=poop]")).toHaveValue("");

    // A day without care gives an empty form.
    await dlg.locator("[name=date]").fill(threeAgo);
    await expect(dlg.locator("#cDlgTitle")).toHaveText(`Care on ${await fmt(page, threeAgo)}`);
    await expect(dlg.locator("#cHint")).toBeHidden();
    await expectMarkedHidden(dlg.locator("#cClear"));
    await expect(dlg.locator("[name=notes]")).toHaveValue("");
    await expect(dlg.locator("#foodChips input:checked")).toHaveCount(0);

    // Saving after switching stores the care on the chosen day (a note alone is enough), and today's record is untouched.
    await fillCare(dlg, { notes: "Shell looks good" });
    await saveCare(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Care saved");
    cares = await caresInDb(page, tid);
    expect(cares).toHaveLength(4);
    expect(cares.find(c => c.date === threeAgo)).toMatchObject({ id: `c_${tid}_${threeAgo}`, soaked: false, food: [], foodNote: "",
      poop: "", urates: "", notes: "Shell looks good" });
    expect(cares.find(c => c.date === today)).toMatchObject({ id: `c_${tid}_${today}`, soaked: true, food: ["Leafy greens"], notes: "" });
    await expect(dayRow(page, threeAgo).locator(".marks .chip")).toHaveCount(0);
    await expect(dayRow(page, threeAgo).locator(".nt")).toHaveText("Shell looks good");
    await expect(dayRow(page, today).locator(".marks .chip")).toHaveText(["Soaked", "Leafy greens"]);

    // Switching to a day that already has care and saving updates that day's single record.
    await page.getByRole("button", { name: "Log today's care" }).click();
    await dlg.locator("[name=date]").fill(yesterday);
    await expect(dlg.locator("#cHint")).toBeVisible();
    await expect(dlg.locator("[name=poop]")).toHaveValue("Runny");
    await fillCare(dlg, { notes: "Ate less" });
    await saveCare(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Care updated");
    cares = await caresInDb(page, tid);
    expect(cares).toHaveLength(4);
    expect(cares.find(c => c.date === yesterday)).toMatchObject({ id: `c_${tid}_${yesterday}`, soaked: false, food: ["Grass / hay"],
      poop: "Runny", urates: "Gritty / chalky", notes: "Ate less" });
    expect(cares.find(c => c.date === today)).toMatchObject({ id: `c_${tid}_${today}`, soaked: true, food: ["Leafy greens"], notes: "" });
    await expect(yRow.locator(".nt")).toHaveText("Ate less");

    // Clear this day: dismissing the confirm keeps the record...
    await yRow.click();
    await expectShown(dlg.locator("#cClear"));
    let confirmP = nextConfirm(page, false);
    await dlg.getByRole("button", { name: "Clear this day" }).click();
    const asked = await confirmP;
    expect(asked.type).toBe("confirm");
    expect(asked.message).toBe(`Clear all care logged on ${await fmt(page, yesterday)}?`);
    await expect(dlg).toBeVisible();
    expect((await caresInDb(page, tid)).some(c => c.date === yesterday)).toBe(true);

    // ...accepting it removes it.
    confirmP = nextConfirm(page, true);
    await dlg.getByRole("button", { name: "Clear this day" }).click();
    await confirmP;
    await expect(dlg).toBeHidden();
    await expectToast(page, "Day cleared");
    await expect(yRow.locator(".marks")).toHaveText("Nothing logged. Tap to add.");
    await expect(yRow).toHaveAccessibleName(`Add care for Yesterday ${await dayMonth(page, yesterday)} Nothing logged. Tap to add.`);
    await expect(dayRow(page, today).locator(".marks .chip")).toHaveText(["Soaked", "Leafy greens"]);

    cares = await caresInDb(page, tid);
    expect(cares.map(c => c.id).sort()).toEqual([`c_${tid}_${tenAgo}`, `c_${tid}_${today}`, `c_${tid}_${threeAgo}`].sort());

    // Still gone after a reload.
    await page.reload();
    await expect(dayRow(page, yesterday).locator(".marks")).toHaveText("Nothing logged. Tap to add.");
    await expect(statValue(page, "Last soaked")).toHaveText("Today");
  });

  test("a day with just one thing logged is saved; the summary and home card show the newest soak, feed and poop check", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    const tid = currentTid(page);
    const today = await pageToday(page);
    const yesterday = await shift(page, today, -1);
    const twoAgo = await shift(page, today, -2);
    const fiveAgo = await shift(page, today, -5);
    const dlg = careDlg(page);
    const blank = { kind: "care", tortoiseId: tid, soaked: false, food: [], foodNote: "", poop: "", urates: "", notes: "" };

    // An older day with everything done.
    await seed(page, { entries: [{ ...blank, id: `c_${tid}_${fiveAgo}`, date: fiveAgo, createdAt: 1,
      soaked: true, food: ["Pellets"], poop: "Normal, firm" }] });
    await expect(statValue(page, "Last soaked")).toHaveText("5 days ago");
    await expect(statValue(page, "Last fed")).toHaveText("5 days ago");
    await expect(statValue(page, "Last poop check")).toHaveText("5 days ago");

    // Today: soaked only.
    await page.getByRole("button", { name: "Log today's care" }).click();
    await fillCare(dlg, { soaked: true });
    await saveCare(dlg);
    await expect(dlg).toBeHidden();
    await expectToast(page, "Care saved");
    await expect(dayRow(page, today).locator(".marks .chip")).toHaveText(["Soaked"]);

    // Yesterday: only a food typed into "Other food", which still counts as fed.
    await dayRow(page, yesterday).click();
    await expect(dlg.locator("#cDlgTitle")).toHaveText("Yesterday's care");
    await fillCare(dlg, { other: "hibiscus" });
    await saveCare(dlg);
    await expect(dlg).toBeHidden();
    await expect(dayRow(page, yesterday).locator(".marks .chip")).toHaveText(["hibiscus"]);

    // Two days ago: urates only, which is not a poop check.
    await dayRow(page, twoAgo).click();
    await fillCare(dlg, { urates: "Clear / liquid" });
    await saveCare(dlg);
    await expect(dlg).toBeHidden();
    await expect(dayRow(page, twoAgo).locator(".marks .chip")).toHaveText(["Urates: Clear / liquid"]);

    const cares = await caresInDb(page, tid);
    expect(cares).toHaveLength(4);
    expect(cares.find(c => c.date === today)).toMatchObject({ ...blank, id: `c_${tid}_${today}`, soaked: true });
    expect(cares.find(c => c.date === yesterday)).toMatchObject({ ...blank, id: `c_${tid}_${yesterday}`, foodNote: "hibiscus" });
    expect(cares.find(c => c.date === twoAgo)).toMatchObject({ ...blank, id: `c_${tid}_${twoAgo}`, urates: "Clear / liquid" });

    // The summary takes the newest day for each.
    await expect(statValue(page, "Last soaked")).toHaveText("Today");
    await expect(statValue(page, "Last fed")).toHaveText("Yesterday");
    await expect(statValue(page, "Last poop check")).toHaveText("5 days ago");
    await page.getByRole("button", { name: "‹ All tortoises" }).click();
    await expect(page.locator(".t-card").filter({ hasText: "Kuro" })).toContainText("Last soaked today");
  });

  test("every poop and urates choice is offered, and only the ones that need attention are flagged in the 7-day list", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    const tid = currentTid(page);
    const today = await pageToday(page);
    const dlg = careDlg(page);

    await page.getByRole("button", { name: "Log today's care" }).click();
    await expect(dlg.locator("[name=poop] option")).toHaveText(["Not checked", "Normal, firm", "Soft", "Runny", "Dry / hard", "Contains undigested food", "None"]);
    await expect(dlg.locator("[name=urates] option")).toHaveText(["Not checked", "Clear / liquid", "Soft white paste", "Gritty / chalky", "None"]);
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();

    // One day per combination, newest first, all inside the 7-day list.
    const looks = [
      { poop: "Normal, firm", urates: "Clear / liquid", bad: [] },
      { poop: "Soft", urates: "Soft white paste", bad: [] },
      { poop: "Runny", urates: "", bad: ["Poop: Runny"] },
      { poop: "Dry / hard", urates: "None", bad: ["Poop: Dry / hard"] },
      { poop: "Contains undigested food", urates: "", bad: ["Poop: Contains undigested food"] },
      { poop: "None", urates: "Gritty / chalky", bad: ["Urates: Gritty / chalky"] }
    ];
    const days = [];
    for(let i = 0; i < looks.length; i++) days.push(await shift(page, today, -i));
    await seed(page, { entries: looks.map((l, i) => ({ id: `c_${tid}_${days[i]}`, kind: "care", tortoiseId: tid, date: days[i], createdAt: i + 1,
      soaked: false, food: [], foodNote: "", poop: l.poop, urates: l.urates, notes: "" })) });

    for(const [i, l] of looks.entries()){
      const row = dayRow(page, days[i]);
      await expect(row.locator(".marks .chip")).toHaveText([`Poop: ${l.poop}`, ...(l.urates ? [`Urates: ${l.urates}`] : [])]);
      if(l.bad.length) await expect(row.locator(".chip.bad")).toHaveText(l.bad);
      else await expect(row.locator(".chip.bad")).toHaveCount(0);
    }
  });
});

/* ---------- Elements the app marks `hidden` must really be hidden (regression: CSS display rules used to override [hidden]) ---------- */

test.describe("controls marked hidden are really hidden", () => {
  // `label.f{display:grid}` used to beat `[hidden]`, so "Species name" showed for every listed species.
  test("Species name field is hidden unless the species is Other", async ({ page }) => {
    await openApp(page);
    await page.locator("#addT").click();
    const dlg = page.locator("#tDlg");
    await expect(dlg).toBeVisible();
    await expect(dlg.locator("[name=species]")).toHaveValue("Sulcata (African spurred)");
    await expectMarkedHidden(dlg.locator("#speciesOtherWrap"));
    await expect(dlg.getByLabel("Species name")).toBeHidden({ timeout: 3000 });
  });

  // `.btn{display:inline-flex}` used to beat `[hidden]`, so "Clear this day" showed for days with nothing logged.
  test("Clear this day is hidden for a day with nothing logged", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    await page.getByRole("button", { name: "Log today's care" }).click();
    const dlg = careDlg(page);
    await expect(dlg).toBeVisible();
    await expectMarkedHidden(dlg.locator("#cClear"));
    await expect(dlg.getByRole("button", { name: "Clear this day" })).toBeHidden({ timeout: 3000 });
  });
});

/* ---------- Food options ---------- */

test.describe("food options", () => {
  const LIST = ["Leafy greens", "Grass / hay", "Flowers", "Cactus pad", "Pumpkin", "Chayote", "Fruit", "Pellets"];
  const chipLabels = dlg => dlg.locator("#foodChips label");

  test("the list offers Pumpkin and Chayote; Weeds and Vegetables are gone", async ({ page }) => {
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    const tid = currentTid(page), today = await pageToday(page);
    await page.getByRole("button", { name: "Log today's care" }).click();
    const dlg = careDlg(page);
    await expect(chipLabels(dlg)).toHaveText(LIST);
    await fillCare(dlg, { foods: ["Chayote", "Pumpkin"] });
    await saveCare(dlg);
    await expectToast(page, "Care saved");
    expect((await caresInDb(page, tid))[0].food).toEqual(["Pumpkin", "Chayote"]);
    await expect(dayRow(page, today).locator(".marks .chip")).toHaveText(["Pumpkin, Chayote"]);
  });

  // Days logged before the list changed keep their foods: they show as extra chips, checked, and survive a re-save.
  test("a day logged with a food that left the list keeps it when saved again; other days don't show it", async ({ page }) => {
    await openApp(page);
    const today = await pageToday(page), yesterday = await shift(page, today, -1);
    const old = { id: `c_t1_${today}`, kind: "care", tortoiseId: "t1", date: today, createdAt: 1, soaked: false,
      food: ["Weeds", "Flowers", "Vegetables"], foodNote: "", poop: "", urates: "", notes: "" };
    await seed(page, { tortoises: [{ id: "t1", name: "Lama", species: "Leopard", sex: "Unknown", birth: null, createdAt: 1 }], entries: [old] });
    await page.locator(".t-card").click();
    await expect(dayRow(page, today).locator(".marks .chip")).toHaveText(["Weeds, Flowers +1"]);

    // The old day: the list plus its two old foods, all three of its foods checked.
    await dayRow(page, today).click();
    const dlg = careDlg(page);
    await expect(chipLabels(dlg)).toHaveText([...LIST, "Weeds", "Vegetables"]);
    for(const f of ["Weeds", "Flowers", "Vegetables"]) await expect(foodBox(dlg, f)).toBeChecked();

    // Another day in the same dialog shows only the current list; back on the old day the old foods return.
    await dlg.locator("[name=date]").fill(yesterday);
    await expect(chipLabels(dlg)).toHaveText(LIST);
    await dlg.locator("[name=date]").fill(today);
    await expect(chipLabels(dlg)).toHaveText([...LIST, "Weeds", "Vegetables"]);
    await expect(foodBox(dlg, "Vegetables")).toBeChecked();

    // Saving the day again (only a note changed) keeps every food.
    await dlg.locator("[name=notes]").fill("Re-saved");
    await saveCare(dlg);
    await expectToast(page, "Care updated");
    expect((await caresInDb(page, "t1"))[0].food).toEqual(["Flowers", "Weeds", "Vegetables"]);

    // Unticking an old food removes it like any other.
    await dayRow(page, today).click();
    await foodChip(dlg, "Weeds").click();
    await saveCare(dlg);
    await expect(dlg).toBeHidden();
    expect((await caresInDb(page, "t1"))[0].food).toEqual(["Flowers", "Vegetables"]);
    await page.reload();
    await dayRow(page, today).click();
    await expect(chipLabels(dlg)).toHaveText([...LIST, "Vegetables"]);
  });
});

/* ---------- Scrolling behind dialogs ---------- */

test.describe("dialogs", () => {
  // Scroll by yDistance (negative = down) starting at (x, y). On the Pixel 7 project it is a finger: separate swipes of
  // at most 180 px (press, drag in small steps, lift), because Chrome's synthesized touch gesture does nothing in
  // headless mode and a scroll only moves on to the page behind on a NEW swipe after the dialog hit its end.
  // On desktop it is Chrome's synthesized mouse-wheel gesture.
  async function scrollGesture(page, x, y, yDistance){
    const cdp = await page.context().newCDPSession(page);
    const isMobile = await page.evaluate(() => navigator.maxTouchPoints > 0);
    if(isMobile){
      for(let left = yDistance; Math.abs(left) > 0.5;){
        const chunk = Math.sign(left) * Math.min(180, Math.abs(left));
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for(let i = 1; i <= 9; i++){
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: Math.round(y + chunk * i / 9) }] });
          await page.waitForTimeout(16);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(250);   // let the fling settle before the next swipe
        left -= chunk;
      }
    }else{
      await cdp.send("Input.synthesizeScrollGesture", { x, y, yDistance, speed: 3000, gestureSourceType: "mouse" });
    }
    await cdp.detach();
  }
  const scrollY = page => page.evaluate(() => Math.round(window.scrollY));

  // Regression: scrolling inside a dialog (or on its backdrop) also scrolled the page behind it.
  test("the page behind an open dialog doesn't scroll, and keeps its place when the dialog closes", async ({ page }) => {
    const vp = page.viewportSize();
    await page.setViewportSize({ width: vp.width, height: 480 });   // short screen: the page and the dialog both overflow
    await openApp(page);
    await addTortoise(page, { name: "Kuro" });
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(200);
    await page.evaluate(() => window.scrollTo(0, 120));
    await expect.poll(() => scrollY(page)).toBe(120);

    await page.getByRole("button", { name: "Log measurement" }).click();
    const dlg = page.locator("#mDlg");
    await expect(dlg).toBeVisible();

    // Scroll down inside the dialog, far past its end: the dialog scrolls, the page doesn't.
    const box = await dlg.boundingBox();
    const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
    await scrollGesture(page, cx, cy, -900);
    await expect.poll(() => dlg.evaluate(d => d.scrollTop)).toBeGreaterThan(0);
    await scrollGesture(page, cx, cy, -900);
    expect(await scrollY(page)).toBe(120);
    // And back up past the top.
    await scrollGesture(page, cx, cy, 1800);
    await expect.poll(() => dlg.evaluate(d => d.scrollTop)).toBe(0);
    expect(await scrollY(page)).toBe(120);
    // On the backdrop beside the dialog (left edge, lower half, so a finger stays on screen).
    await scrollGesture(page, 4, 400, -400);
    expect(await scrollY(page)).toBe(120);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).toBe("hidden");

    // Closed: the page is where it was and scrolls again.
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe("hidden");
    expect(await scrollY(page)).toBe(120);
    await scrollGesture(page, cx, 200, -200);
    await expect.poll(() => scrollY(page)).toBeGreaterThan(120);
  });
});
