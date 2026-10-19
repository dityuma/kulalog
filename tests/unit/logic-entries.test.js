// Unit tests for js/logic.js: growth per month (U3) and one care record per tortoise per day (U4).
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("../../js/logic.js");

// A measurement as the app stores it.
const measure = (id, date, fields = {}, createdAt = 1) => ({
  id, kind: "measure", tortoiseId: "t1", date, createdAt,
  plastron: null, scl: null, weightG: null, photo: null, notes: "", ...fields
});
// A care record as the app stores it.
const care = (tid, date, fields = {}, createdAt = 1) => ({
  id: L.careId(tid, date), kind: "care", tortoiseId: tid, date, createdAt,
  soaked: false, food: [], foodNote: "", poop: "", urates: "", notes: "", ...fields
});
// The form data the care dialog passes to upsertCare.
const careForm = (fields = {}) => ({ soaked: false, food: [], foodNote: "", poop: "", urates: "", notes: "", ...fields });

/* ---------------------------------------------------------------- U3 */
describe("U3 growth per month (perMonth)", () => {
  // 300 g on 1 Jan, 420 g on 1 Apr 2026: 90 days, +120 g, so 40 g per 30 days.
  const jan = measure("m-jan", "2026-01-01", { weightG: 300, plastron: 8 });
  const apr = measure("m-apr", "2026-04-01", { weightG: 420, plastron: 9.5 });

  it("gives the change per 30 days between the oldest and the newest value", () => {
    expect(L.daysBetween("2026-01-01", "2026-04-01")).toBe(90);
    expect(L.perMonth(L.sortEntries([jan, apr]), "weightG")).toBeCloseTo(40, 9);
    expect(L.perMonth(L.sortEntries([jan, apr]), "plastron")).toBeCloseTo(0.5, 9);
  });

  it("expects the newest-first order the app passes (sortEntries); an oldest-first list gives no rate", () => {
    const shuffled = [apr, measure("m-feb", "2026-02-10", { weightG: 350 }), jan];
    const newestFirst = L.sortEntries(shuffled.slice().reverse());
    expect(newestFirst.map(e => e.id)).toEqual(["m-apr", "m-feb", "m-jan"]);
    expect(L.perMonth(newestFirst, "weightG")).toBeCloseTo(40, 9);
    // Oldest first, the span comes out negative (-90 days), which fails the 7-day check.
    expect(L.perMonth(newestFirst.slice().reverse(), "weightG")).toBeNull();
  });

  it("is negative when the tortoise shrinks", () => {
    const a = measure("a", "2026-05-01", { weightG: 420 }), b = measure("b", "2026-05-31", { weightG: 390 });
    expect(L.perMonth(L.sortEntries([a, b]), "weightG")).toBeCloseTo(-30, 9);
  });

  it("uses only the oldest and newest values, not the ones in between", () => {
    const spike = measure("spike", "2026-02-15", { weightG: 1000 });
    expect(L.perMonth(L.sortEntries([jan, spike, apr]), "weightG")).toBeCloseTo(40, 9);
  });

  it("ignores entries that don't have the value", () => {
    // Newer measurements with only a plastron, or with no weight field at all, don't end the weight span.
    const plastronOnly = measure("p", "2026-06-01", { plastron: 10 });
    const noField = { id: "x", kind: "measure", tortoiseId: "t1", date: "2026-07-01", createdAt: 1, scl: 11 };
    const list = L.sortEntries([jan, apr, plastronOnly, noField]);
    expect(L.perMonth(list, "weightG")).toBeCloseTo(40, 9);
    // Plastron: 8 on 1 Jan to 10 on 1 Jun (151 days).
    expect(L.perMonth(list, "plastron")).toBeCloseTo((10 - 8) / 151 * 30, 9);
  });

  it("needs at least two values", () => {
    expect(L.perMonth([], "weightG")).toBeNull();
    expect(L.perMonth([apr], "weightG")).toBeNull();
    // Two entries but only one has a weight.
    expect(L.perMonth(L.sortEntries([apr, measure("p", "2026-01-01", { plastron: 8 })]), "weightG")).toBeNull();
    // A value of 0 still counts as a value.
    expect(L.perMonth(L.sortEntries([measure("z", "2026-01-01", { scl: 0 }), measure("y", "2026-01-31", { scl: 3 })]), "scl")).toBeCloseTo(3, 9);
  });

  it("needs the values to be at least 7 days apart", () => {
    const d0 = measure("d0", "2026-10-01", { weightG: 100 });
    expect(L.perMonth(L.sortEntries([d0, measure("d6", "2026-10-07", { weightG: 106 })]), "weightG")).toBeNull();
    expect(L.perMonth(L.sortEntries([d0, measure("d7", "2026-10-08", { weightG: 107 })]), "weightG")).toBeCloseTo(30, 9);
    // Same day twice: no span at all.
    expect(L.perMonth(L.sortEntries([d0, measure("d0b", "2026-10-01", { weightG: 120 }, 5)]), "weightG")).toBeNull();
  });

  it("on the newest day, the latest-created measurement is the end point", () => {
    const early = measure("early", "2026-04-01", { weightG: 410 }, 1);
    const late = measure("late", "2026-04-01", { weightG: 420 }, 2);
    expect(L.perMonth(L.sortEntries([early, jan, late]), "weightG")).toBeCloseTo(40, 9);
  });
});

/* ---------------------------------------------------------------- U4 */
describe("U4 one care record per tortoise per day", () => {
  it("careId is deterministic and unique per tortoise and day", () => {
    expect(L.careId("t1", "2026-10-18")).toBe("c_t1_2026-10-18");
    expect(L.careId("t1", "2026-10-18")).toBe(L.careId("t1", "2026-10-18"));
    expect(L.careId("t2", "2026-10-18")).not.toBe(L.careId("t1", "2026-10-18"));
    expect(L.careId("t1", "2026-10-19")).not.toBe(L.careId("t1", "2026-10-18"));
  });

  it("upsertCare on an empty list creates a new record with the deterministic id", () => {
    const list = [];
    const data = careForm({ soaked: true, food: ["Greens"], poop: "Normal, firm" });
    const r = L.upsertCare(list, "t1", "2026-10-18", data, 1234);
    expect(r.created).toBe(true);
    expect(r.entry).toStrictEqual({
      id: "c_t1_2026-10-18", tortoiseId: "t1", createdAt: 1234, kind: "care", date: "2026-10-18",
      soaked: true, food: ["Greens"], foodNote: "", poop: "Normal, firm", urates: "", notes: ""
    });
    // The caller adds it to its list; upsertCare itself doesn't, and the form data is left alone.
    expect(list).toHaveLength(0);
    expect(r.entry).not.toBe(data);
    expect(data).toStrictEqual(careForm({ soaked: true, food: ["Greens"], poop: "Normal, firm" }));
  });

  it("createdAt defaults to now", () => {
    const before = Date.now();
    const { entry } = L.upsertCare([], "t1", "2026-10-18", careForm({ soaked: true }));
    expect(entry.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt).toBeLessThanOrEqual(Date.now());
  });

  // The caller (the care form) adds a new record, or replaces the day's record once the save succeeded.
  const saveInto = (list, tid, date, data, now) => {
    const r = L.upsertCare(list, tid, date, data, now);
    if(r.created) list.push(r.entry); else list[list.indexOf(r.old)] = r.entry;
    return r;
  };

  it("a second save for the same tortoise and day updates that day's record (same id, no duplicate)", () => {
    const list = [];
    const save = (data, now) => saveInto(list, "t1", "2026-10-18", data, now);
    const r1 = save(careForm({ soaked: true, food: ["Greens"] }), 1000);
    const r2 = save(careForm({ soaked: false, food: ["Pellets"], poop: "Runny", notes: "check tomorrow" }), 2000);
    expect(r1.created).toBe(true);
    expect(r1.old).toBeNull();
    expect(r2.created).toBe(false);
    expect(r2.old).toBe(r1.entry);
    expect(r2.entry.id).toBe(r1.entry.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toStrictEqual({
      id: "c_t1_2026-10-18", tortoiseId: "t1", createdAt: 1000, kind: "care", date: "2026-10-18",
      soaked: false, food: ["Pellets"], foodNote: "", poop: "Runny", urates: "", notes: "check tomorrow"
    });
  });

  it("finds the day's record loaded from storage and returns an updated copy with its id and createdAt", () => {
    const stored = care("t1", "2026-10-18", { soaked: true }, 500);
    const snapshot = structuredClone(stored);
    const list = [measure("m1", "2026-10-18"), stored];
    const r = L.upsertCare(list, "t1", "2026-10-18", careForm({ food: ["Greens"] }), 9999);
    expect(r.created).toBe(false);
    expect(r.old).toBe(stored);
    expect(r.entry).not.toBe(stored);
    expect(r.entry).toMatchObject({ id: "c_t1_2026-10-18", createdAt: 500, food: ["Greens"], kind: "care" });
    expect(stored).toStrictEqual(snapshot);
  });

  // Regression: upsertCare changed the stored record in place, so a save that storage refused still left the
  // unsaved values (including fields the stored record didn't have) in memory and on screen.
  it("never changes the records it is given, so a failed save leaves the day as it was", () => {
    const stored = { id: "c_t1_2026-10-18", kind: "care", tortoiseId: "t1", date: "2026-10-18", createdAt: 5, soaked: true };
    const snapshot = structuredClone(stored);
    const list = [stored];
    L.upsertCare(list, "t1", "2026-10-18", careForm({ notes: "never stored", food: ["Weeds"] }), 6);
    expect(stored).toStrictEqual(snapshot);
    expect(list).toEqual([snapshot]);
  });

  describe("saving a past day (the care form's date field)", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("updates or creates the record of the date it is given, never today's record", () => {
      // Today is 18 Oct 2026 (10:00 WIB) and already has a record; the keeper back-fills 16 Oct.
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
      const todays = care("t1", "2026-10-18", { soaked: true }, 100);
      const todaySnapshot = structuredClone(todays);
      const list = [todays];

      const r1 = L.upsertCare(list, "t1", "2026-10-16", careForm({ food: ["Greens"] }), 200);
      expect(r1.created).toBe(true);
      expect(r1.entry).not.toBe(todays);
      expect(r1.entry).toMatchObject({ id: "c_t1_2026-10-16", date: "2026-10-16", createdAt: 200, food: ["Greens"] });
      list.push(r1.entry);

      // A second save for 16 Oct updates that record; today's record is never touched.
      const r2 = saveInto(list, "t1", "2026-10-16", careForm({ poop: "Soft" }), 300);
      expect(r2.created).toBe(false);
      expect(r2.old).toBe(r1.entry);
      expect(r2.entry).toMatchObject({ id: "c_t1_2026-10-16", createdAt: 200, poop: "Soft", food: [] });
      expect(todays).toStrictEqual(todaySnapshot);
      expect(list).toHaveLength(2);

      // An existing past record loaded from storage is found too.
      const stored = care("t1", "2026-03-05", { notes: "old" }, 50);
      const r3 = L.upsertCare([todays, stored], "t1", "2026-03-05", careForm({ soaked: true }), 400);
      expect(r3.created).toBe(false);
      expect(r3.old).toBe(stored);
      expect(r3.entry).toMatchObject({ id: "c_t1_2026-03-05", createdAt: 50, soaked: true });
      expect(todays).toStrictEqual(todaySnapshot);
    });
  });

  it("another tortoise on the same day gets its own record", () => {
    const list = [];
    for(const tid of ["t1", "t2"]){ const r = L.upsertCare(list, tid, "2026-10-18", careForm({ soaked: true })); expect(r.created).toBe(true); list.push(r.entry); }
    expect(list.map(e => e.id)).toEqual(["c_t1_2026-10-18", "c_t2_2026-10-18"]);
    expect(list.map(e => e.tortoiseId)).toEqual(["t1", "t2"]);
  });

  it("the same tortoise on another day gets its own record", () => {
    const list = [];
    for(const date of ["2026-10-17", "2026-10-18"]){ const r = L.upsertCare(list, "t1", date, careForm({ soaked: true })); expect(r.created).toBe(true); list.push(r.entry); }
    expect(list.map(e => e.id)).toEqual(["c_t1_2026-10-17", "c_t1_2026-10-18"]);
    expect(list.map(e => e.date)).toEqual(["2026-10-17", "2026-10-18"]);
  });

  it("ignores measurements on that day", () => {
    const m = measure("m1", "2026-10-18", { weightG: 420, notes: "weighed" });
    const snapshot = structuredClone(m);
    const list = [m];
    const r = L.upsertCare(list, "t1", "2026-10-18", careForm({ soaked: true }), 1);
    expect(r.created).toBe(true);
    expect(r.entry).not.toBe(m);
    expect(r.entry.id).toBe("c_t1_2026-10-18");
    expect(r.entry.kind).toBe("care");
    expect(m).toStrictEqual(snapshot);
  });

  it("findCare matches kind, tortoise and date", () => {
    const c = care("t1", "2026-10-18");
    const list = [measure("m1", "2026-10-18"), care("t2", "2026-10-18"), care("t1", "2026-10-17"), c];
    expect(L.findCare(list, "t1", "2026-10-18")).toBe(c);
    expect(L.findCare(list, "t3", "2026-10-18")).toBeUndefined();
    expect(L.findCare([measure("m1", "2026-10-18")], "t1", "2026-10-18")).toBeUndefined();
  });

  describe("isEmptyCare", () => {
    it("is true for an untouched form and for an empty object", () => {
      expect(L.isEmptyCare(careForm())).toBe(true);
      expect(L.isEmptyCare({})).toBe(true);
    });
    it.each([
      ["soaked", { soaked: true }],
      ["food", { food: ["Greens"] }],
      ["foodNote", { foodNote: "dandelion" }],
      ["poop", { poop: "Normal, firm" }],
      ["urates", { urates: "Clear / liquid" }],
      ["notes", { notes: "basked all day" }]
    ])("is false when only %s is filled in", (_k, fields) => {
      expect(L.isEmptyCare(careForm(fields))).toBe(false);
    });
  });
});
