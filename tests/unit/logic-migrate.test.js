// Unit tests for js/logic.js: migrating records from the first prototype (U5).
// Old entries had no `kind` and mixed growth fields (plastron, scl, weightG, photo) with care fields
// (soaked, food, foodNote, poop, urates). migrateEntries splits them into measurements and day care records.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("../../js/logic.js");

const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const D = "2026-03-05";

const legacy = (id, fields = {}, { tortoiseId = "t1", date = D, createdAt = 1000 } = {}) => ({ id, tortoiseId, date, createdAt, ...fields });
const measure = (id, fields = {}, { tortoiseId = "t1", date = D, createdAt = 1 } = {}) => ({
  id, kind: "measure", tortoiseId, date, createdAt, plastron: null, scl: null, weightG: null, photo: null, notes: "", ...fields
});
const care = (tid, date, fields = {}, createdAt = 1) => ({
  id: L.careId(tid, date), kind: "care", tortoiseId: tid, date, createdAt,
  soaked: false, food: [], foodNote: "", poop: "", urates: "", notes: "", ...fields
});
const byId = list => Object.fromEntries(list.map(e => [e.id, e]));
const ids = list => list.map(e => e.id).sort();

// What the app does with the result: IndexedDB holds copies; delete r.dels, then put r.puts.
function migrateLikeApp(entries){
  const db = new Map(entries.map(e => [e.id, structuredClone(e)]));
  const r = L.migrateEntries(entries);
  for(const id of r.dels) db.delete(id);
  for(const e of r.puts) db.set(e.id, structuredClone(e));
  return { r, db };
}
function expectConsistent(r, db){
  const putIds = r.puts.map(e => e.id);
  // No id is both deleted and written, and nothing is written twice.
  expect(r.dels.filter(id => putIds.includes(id))).toEqual([]);
  expect(new Set(putIds).size).toBe(putIds.length);
  expect(new Set(r.dels).size).toBe(r.dels.length);
  // The in-memory list has no duplicates and no legacy records left.
  expect(new Set(r.entries.map(e => e.id)).size).toBe(r.entries.length);
  expect(r.entries.filter(e => !e.kind)).toEqual([]);
  // After applying dels and puts, storage holds exactly the in-memory list.
  expect([...db.keys()].sort()).toEqual(ids(r.entries));
  for(const e of r.entries) expect(db.get(e.id)).toStrictEqual(e);
  // A care record is unique per tortoise and day.
  const careKeys = r.entries.filter(e => e.kind === "care").map(e => e.tortoiseId + "|" + e.date);
  expect(new Set(careKeys).size).toBe(careKeys.length);
}

describe("U5 migrating records from the first prototype", () => {
  it("splits an entry with growth and care fields into a measurement (same id) and the day's care record", () => {
    const old = legacy("e1", {
      plastron: 8.2, scl: 9.1, weightG: 310, photo: PHOTO, notes: "after soak",
      soaked: true, food: ["Greens", "Flowers"], foodNote: "dandelion", poop: "Normal, firm", urates: "Clear / liquid"
    });
    const { r, db } = migrateLikeApp([old]);
    expect(r.entries).toHaveLength(2);
    const e = byId(r.entries);
    expect(e.e1).toStrictEqual({
      id: "e1", kind: "measure", tortoiseId: "t1", date: D, createdAt: 1000,
      plastron: 8.2, scl: 9.1, weightG: 310, photo: PHOTO, notes: "after soak"
    });
    expect(e["c_t1_" + D]).toStrictEqual({
      id: "c_t1_2026-03-05", kind: "care", tortoiseId: "t1", date: D, createdAt: 1000,
      soaked: true, food: ["Greens", "Flowers"], foodNote: "dandelion", poop: "Normal, firm", urates: "Clear / liquid",
      notes: "" // the notes went to the measurement
    });
    // The old id is rewritten as the measurement, so it must not be deleted.
    expect(r.dels).toEqual([]);
    expect(ids(r.puts)).toEqual(["c_t1_2026-03-05", "e1"]);
    expectConsistent(r, db);
  });

  it("a care-only entry becomes only a care record and the old id is deleted", () => {
    const old = legacy("e2", { soaked: true, food: ["Pellets"], poop: "Runny", urates: "", notes: "seemed tired" });
    const { r, db } = migrateLikeApp([old]);
    expect(r.entries).toStrictEqual([{
      id: "c_t1_2026-03-05", kind: "care", tortoiseId: "t1", date: D, createdAt: 1000,
      soaked: true, food: ["Pellets"], foodNote: "", poop: "Runny", urates: "", notes: "seemed tired"
    }]);
    expect(r.dels).toEqual(["e2"]);
    expect(ids(r.puts)).toEqual(["c_t1_2026-03-05"]);
    expect(r.entries.filter(e => e.kind === "measure")).toEqual([]);
    expectConsistent(r, db);
  });

  it("a notes-only entry becomes a measurement with those notes and no values", () => {
    const old = legacy("e3", { notes: "moved to the big enclosure" });
    const { r, db } = migrateLikeApp([old]);
    expect(r.entries).toStrictEqual([{
      id: "e3", kind: "measure", tortoiseId: "t1", date: D, createdAt: 1000,
      plastron: null, scl: null, weightG: null, photo: null, notes: "moved to the big enclosure"
    }]);
    expect(r.dels).toEqual([]);
    expect(ids(r.puts)).toEqual(["e3"]);
    expectConsistent(r, db);
  });

  it("a photo-only entry becomes a measurement", () => {
    const { r, db } = migrateLikeApp([legacy("e4", { photo: PHOTO })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ id: "e4", kind: "measure", photo: PHOTO, weightG: null, notes: "" });
    expectConsistent(r, db);
  });

  it("a weight of 0 still counts as a measurement value", () => {
    const { r } = migrateLikeApp([legacy("e0", { weightG: 0 })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ id: "e0", kind: "measure", weightG: 0 });
  });

  // Each growth field on its own is enough to keep the record as a measurement (no care record, old id kept).
  it.each([
    ["plastron", { plastron: 8.2 }],
    ["scl", { scl: 9.1 }],
    ["weightG", { weightG: 310 }],
    ["photo", { photo: PHOTO }],
    ["plastron of 0", { plastron: 0 }],
    ["scl of 0", { scl: 0 }]
  ])("an entry with only %s becomes a measurement with that value", (_label, fields) => {
    const { r, db } = migrateLikeApp([legacy("g1", { soaked: false, food: [], foodNote: "", poop: "", urates: "", ...fields })]);
    expect(r.entries).toStrictEqual([{
      id: "g1", kind: "measure", tortoiseId: "t1", date: D, createdAt: 1000,
      plastron: null, scl: null, weightG: null, photo: null, notes: "", ...fields
    }]);
    expect(r.dels).toEqual([]);
    expect(ids(r.puts)).toEqual(["g1"]);
    expectConsistent(r, db);
  });

  // Each care field on its own is enough to make the day's care record (old id deleted, no measurement).
  it.each([
    ["soaked", { soaked: true }],
    ["food", { food: ["Greens"] }],
    ["foodNote", { foodNote: "dandelion" }],
    ["poop", { poop: "Runny" }],
    ["urates", { urates: "Gritty / chalky" }]
  ])("an entry with only %s becomes the day's care record with that value", (_label, fields) => {
    const { r, db } = migrateLikeApp([legacy("k1", { plastron: null, scl: null, weightG: null, photo: null, ...fields })]);
    expect(r.entries).toStrictEqual([{
      id: "c_t1_2026-03-05", kind: "care", tortoiseId: "t1", date: D, createdAt: 1000,
      soaked: false, food: [], foodNote: "", poop: "", urates: "", notes: "", ...fields
    }]);
    expect(r.dels).toEqual(["k1"]);
    expect(ids(r.puts)).toEqual(["c_t1_2026-03-05"]);
    expectConsistent(r, db);
  });

  it("an entry with nothing in it is only deleted", () => {
    const { r, db } = migrateLikeApp([legacy("e5", { soaked: false, food: [], foodNote: "", poop: "", urates: "", notes: "" })]);
    expect(r.entries).toEqual([]);
    expect(r.puts).toEqual([]);
    expect(r.dels).toEqual(["e5"]);
    expectConsistent(r, db);
  });

  it("two old entries on the same day merge into one care record", () => {
    const a = legacy("a", { food: ["Greens"], foodNote: "dandelion", poop: "Normal, firm", urates: "", soaked: false, notes: "ate well" }, { createdAt: 1000 });
    const b = legacy("b", { food: ["Greens", "Pellets"], foodNote: "hibiscus", poop: "Runny", urates: "Gritty / chalky", soaked: true, notes: "slept" }, { createdAt: 2000 });
    const { r, db } = migrateLikeApp([a, b]);
    expect(r.entries).toStrictEqual([{
      id: "c_t1_2026-03-05", kind: "care", tortoiseId: "t1", date: D, createdAt: 1000,
      soaked: true,                      // either soaked
      food: ["Greens", "Pellets"],       // union, no duplicates
      foodNote: "dandelion, hibiscus",   // joined
      poop: "Normal, firm",              // the first one is kept
      urates: "Gritty / chalky",         // the first non-empty one
      notes: "ate well\nslept"
    }]);
    expect(r.dels.slice().sort()).toEqual(["a", "b"]);
    expect(ids(r.puts)).toEqual(["c_t1_2026-03-05"]);
    expectConsistent(r, db);
  });

  it("when two records of a day both have poop and urates, the earlier record's choices are kept", () => {
    const a = legacy("a", { poop: "Soft", urates: "Clear / liquid" }, { createdAt: 1000 });
    const b = legacy("b", { poop: "Runny", urates: "Gritty / chalky", soaked: false }, { createdAt: 2000 });
    const { r, db } = migrateLikeApp([a, b]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ id: "c_t1_2026-03-05", poop: "Soft", urates: "Clear / liquid", soaked: false });
    expectConsistent(r, db);

    // Same with a care record that already exists for the day: its values win over the old entry's,
    // and an old entry that wasn't soaked doesn't clear "soaked".
    const existing = care("t1", D, { soaked: true, poop: "Normal, firm", urates: "Soft white paste" }, 50);
    const old = legacy("old", { soaked: false, poop: "Runny", urates: "Gritty / chalky", foodNote: "clover" });
    const m2 = migrateLikeApp([existing, old]);
    expect(m2.r.entries).toStrictEqual([{
      id: "c_t1_2026-03-05", kind: "care", tortoiseId: "t1", date: D, createdAt: 50,
      soaked: true, food: [], foodNote: "clover", poop: "Normal, firm", urates: "Soft white paste", notes: ""
    }]);
    expectConsistent(m2.r, m2.db);
  });

  it("a mixed entry and a care-only entry on the same day give one measurement and one merged care record", () => {
    const mixed = legacy("mx", { weightG: 400, notes: "weighed", food: ["Greens"], poop: "" });
    const careOnly = legacy("co", { soaked: true, poop: "Soft", foodNote: "clover" });
    const { r, db } = migrateLikeApp([mixed, careOnly]);
    const e = byId(r.entries);
    expect(ids(r.entries)).toEqual(["c_t1_2026-03-05", "mx"]);
    expect(e.mx).toMatchObject({ kind: "measure", weightG: 400, notes: "weighed" });
    expect(e["c_t1_" + D]).toMatchObject({ soaked: true, food: ["Greens"], foodNote: "clover", poop: "Soft", notes: "" });
    expect(r.dels).toEqual(["co"]);
    expectConsistent(r, db);
  });

  it("merges into a care record that already exists for that day instead of adding a second one", () => {
    const existing = care("t1", D, { food: ["Greens"], foodNote: "kale", poop: "Soft", notes: "existing" }, 50);
    const old = legacy("old", { soaked: true, food: ["Pellets", "Greens"], foodNote: "hibiscus", poop: "Runny" });
    const { r, db } = migrateLikeApp([existing, old]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toStrictEqual({
      id: "c_t1_2026-03-05", kind: "care", tortoiseId: "t1", date: D, createdAt: 50,
      soaked: true, food: ["Greens", "Pellets"], foodNote: "kale, hibiscus", poop: "Soft", urates: "", notes: "existing"
    });
    expect(r.dels).toEqual(["old"]);
    expect(ids(r.puts)).toEqual(["c_t1_2026-03-05"]);
    expectConsistent(r, db);
  });

  it("keeps different tortoises and different days apart", () => {
    const list = [
      legacy("x1", { soaked: true }, { tortoiseId: "t1" }),
      legacy("x2", { soaked: true }, { tortoiseId: "t2" }),
      legacy("x3", { food: ["Greens"] }, { tortoiseId: "t1", date: "2026-03-06" })
    ];
    const { r, db } = migrateLikeApp(list);
    expect(ids(r.entries)).toEqual(["c_t1_2026-03-05", "c_t1_2026-03-06", "c_t2_2026-03-05"]);
    expect(r.dels.slice().sort()).toEqual(["x1", "x2", "x3"]);
    expectConsistent(r, db);
  });

  it("leaves already-migrated records alone when there is nothing to migrate", () => {
    const list = [measure("m1", { weightG: 300 }), care("t1", D, { soaked: true }), measure("m2", { scl: 9 }, { tortoiseId: "t2" })];
    const snapshot = structuredClone(list);
    const r = L.migrateEntries(list);
    expect(r.dels).toEqual([]);
    expect(r.puts).toEqual([]);
    expect(r.entries).toHaveLength(3);
    r.entries.forEach((e, i) => expect(e).toBe(list[i]));
    expect(list).toStrictEqual(snapshot);
  });

  it("leaves already-migrated records of other days alone in a mixed list, and does not change the input", () => {
    const m1 = measure("m1", { weightG: 300 }, { date: "2026-03-01" });
    const c1 = care("t1", "2026-03-01", { soaked: true });
    const old = legacy("old", { weightG: 320, soaked: true });
    const list = [m1, c1, old];
    const snapM1 = structuredClone(m1), snapC1 = structuredClone(c1), snapOld = structuredClone(old);
    const { r, db } = migrateLikeApp(list);
    expect(r.entries).toContain(m1);
    expect(r.entries).toContain(c1);
    expect(m1).toStrictEqual(snapM1);
    expect(c1).toStrictEqual(snapC1);
    expect(r.puts).not.toContain(m1);
    expect(r.puts).not.toContain(c1);
    // The input array and the old record are not modified.
    expect(list).toHaveLength(3);
    expect(list[2]).toBe(old);
    expect(old).toStrictEqual(snapOld);
    expectConsistent(r, db);
  });

  it("dels and puts stay consistent on a larger mixed set, and a second run has nothing to do", () => {
    const list = [
      measure("m-old", { weightG: 250 }, { date: "2026-02-01" }),
      care("t1", "2026-02-01", { food: ["Greens"] }),
      legacy("l1", { weightG: 300, soaked: true, notes: "n1" }),
      legacy("l2", { food: ["Pellets"], notes: "n2" }),
      legacy("l3", { notes: "only notes" }, { date: "2026-03-06" }),
      legacy("l4", {}, { date: "2026-03-07" }),
      legacy("l5", { poop: "Runny", soaked: true }, { date: "2026-02-01" }),
      legacy("l6", { scl: 10.2, photo: PHOTO, urates: "Soft white paste" }, { tortoiseId: "t2" })
    ];
    const { r, db } = migrateLikeApp(list);
    expectConsistent(r, db);
    // Every old id is either deleted or rewritten as a measurement.
    for(const old of list.filter(e => !e.kind)){
      const rewritten = r.puts.some(p => p.id === old.id && p.kind === "measure");
      expect(r.dels.includes(old.id) !== rewritten, old.id).toBe(true);
    }
    expect(r.dels.slice().sort()).toEqual(["l2", "l4", "l5"]);
    expect(ids(r.entries)).toEqual(["c_t1_2026-02-01", "c_t1_2026-03-05", "c_t2_2026-03-05", "l1", "l3", "l6", "m-old"]);
    expect(byId(r.entries)["c_t1_2026-02-01"]).toMatchObject({ food: ["Greens"], poop: "Runny", soaked: true });
    expect(byId(r.entries)["c_t1_2026-03-05"]).toMatchObject({ food: ["Pellets"], soaked: true, notes: "n2" });
    const again = L.migrateEntries(r.entries);
    expect(again.dels).toEqual([]);
    expect(again.puts).toEqual([]);
    expect(ids(again.entries)).toEqual(ids(r.entries));
  });
});
