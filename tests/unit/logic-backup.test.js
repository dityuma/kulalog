// Unit tests for js/logic.js: JSON backup export, parsing and merging (U6).
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("../../js/logic.js");

const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";
const PHOTO2 = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAg==";
const NOW = new Date("2026-10-18T03:00:00Z");

const makeTortoises = () => [
  { id: "t1", name: "Shelly", species: "Sulcata (African spurred)", sex: "Female", birth: "2025-03-01", createdAt: 1700000000000 },
  { id: "t2", name: "Leo", species: "Leopard", sex: "Unknown", birth: null, createdAt: 1700000000001 }
];
const makeEntries = () => [
  { id: "m1", kind: "measure", tortoiseId: "t1", date: "2026-09-01", createdAt: 1, plastron: 8.1, scl: 9.2, weightG: 310.5, photo: PHOTO, notes: "first \"big\" day, ok" },
  { id: "m2", kind: "measure", tortoiseId: "t2", date: "2026-09-02", createdAt: 2, plastron: null, scl: null, weightG: 120, photo: null, notes: "" },
  { id: "c_t1_2026-09-01", kind: "care", tortoiseId: "t1", date: "2026-09-01", createdAt: 3,
    soaked: true, food: ["Greens", "Flowers"], foodNote: "dandelion", poop: "Normal, firm", urates: "", notes: "line 1\nline 2" }
];
const empty = () => ({ tortoises: [], entries: [] });

afterEach(() => { vi.useRealTimers(); });

describe("U6 backup", () => {
  describe("buildBackup", () => {
    it("with photos: tags the file and keeps every record as it is", () => {
      const ts = makeTortoises(), es = makeEntries();
      const b = L.buildBackup(ts, es, true, NOW);
      expect(b).toStrictEqual({ app: "kulalog", version: 1, exported: "2026-10-18T03:00:00.000Z", tortoises: makeTortoises(), entries: makeEntries() });
      expect(b.entries[0].photo).toBe(PHOTO);
    });

    it("without photos: every entry has photo:null, everything else unchanged", () => {
      const es = makeEntries();
      const b = L.buildBackup(makeTortoises(), es, false, NOW);
      expect(b.entries).toHaveLength(3);
      for(const [i, e] of b.entries.entries()){
        expect(e.photo).toBeNull();
        const { photo: _a, ...rest } = e, { photo: _b, ...orig } = makeEntries()[i];
        expect(rest).toStrictEqual(orig);
      }
      // Care records get a photo:null field too (harmless; current behaviour).
      expect(b.entries[2]).toHaveProperty("photo", null);
    });

    it("without photos: does not change the records it was given", () => {
      const ts = makeTortoises(), es = makeEntries();
      const b = L.buildBackup(ts, es, false, NOW);
      expect(es).toStrictEqual(makeEntries());
      expect(es[0].photo).toBe(PHOTO);
      expect(b.entries[0]).not.toBe(es[0]);
      expect(ts).toStrictEqual(makeTortoises());
    });

    it("exported defaults to now", () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(L.buildBackup([], [], true).exported).toBe("2026-10-18T03:00:00.000Z");
    });
  });

  describe("parseBackup", () => {
    it.each([
      ["plain text", "this is not json"],
      ["an empty file", ""],
      ["truncated JSON", "{\"app\":\"kulalog\",\"tortoises\":["],
      ["JSON null", "null"],
      ["a JSON array", "[]"],
      ["a JSON number", "42"],
      ["a JSON string", "\"kulalog\""],
      ["another app's JSON", JSON.stringify({ app: "tortoise-tracker", version: 1, tortoises: [], entries: [] })],
      ["JSON without app", JSON.stringify({ tortoises: [], entries: [] })],
      ["app in another case", JSON.stringify({ app: "Kulalog", tortoises: [] })],
      ["missing tortoises", JSON.stringify({ app: "kulalog", version: 1, entries: [] })],
      ["tortoises not an array", JSON.stringify({ app: "kulalog", tortoises: { t1: { id: "t1", name: "x" } }, entries: [] })],
      ["undefined", undefined],
      ["null", null]
    ])("rejects %s", (_label, text) => {
      expect(L.parseBackup(text)).toBeNull();
    });

    it("accepts a backup with a leading byte order mark", () => {
      const json = JSON.stringify(L.buildBackup(makeTortoises(), makeEntries(), true, NOW));
      const expected = { tortoises: makeTortoises(), entries: makeEntries() };
      expect(L.parseBackup(json)).toStrictEqual(expected);
      expect(L.parseBackup("﻿" + json)).toStrictEqual(expected);
    });

    it("treats a missing or broken entries list as no entries", () => {
      expect(L.parseBackup(JSON.stringify({ app: "kulalog", tortoises: [] }))).toStrictEqual({ tortoises: [], entries: [] });
      expect(L.parseBackup(JSON.stringify({ app: "kulalog", tortoises: [], entries: "nope" }))).toStrictEqual({ tortoises: [], entries: [] });
    });

    it("keeps records from the first prototype (no kind) so the app can migrate them after the import", () => {
      // A backup made with the first prototype: entries have no `kind` and mix growth and care fields.
      const old = { id: "p1", tortoiseId: "t1", date: "2026-03-05", createdAt: 7, weightG: 300, photo: PHOTO, soaked: true, food: ["Greens"], notes: "" };
      const careOnly = { id: "p2", tortoiseId: "t1", date: "2026-03-06", createdAt: 8, poop: "Runny" };
      const text = JSON.stringify({ app: "kulalog", version: 1, tortoises: [makeTortoises()[0]], entries: [old, careOnly] });
      const data = L.parseBackup(text);
      expect(data.entries).toStrictEqual([old, careOnly]);

      // What the import does next: merge, then migrate (js/app.js importFile -> migrate()).
      const merged = L.mergeBackup(empty(), data);
      const r = L.migrateEntries(merged.entries);
      const byId = Object.fromEntries(r.entries.map(e => [e.id, e]));
      expect(Object.keys(byId).sort()).toEqual(["c_t1_2026-03-05", "c_t1_2026-03-06", "p1"]);
      expect(byId.p1).toMatchObject({ kind: "measure", weightG: 300, photo: PHOTO });
      expect(byId["c_t1_2026-03-05"]).toMatchObject({ kind: "care", soaked: true, food: ["Greens"] });
      expect(byId["c_t1_2026-03-06"]).toMatchObject({ kind: "care", poop: "Runny" });
    });

    it("drops malformed records and keeps the good ones", () => {
      const good = makeEntries();
      const text = JSON.stringify({
        app: "kulalog", version: 1,
        tortoises: [null, "t9", 7, { id: 1, name: "Numeric id" }, { id: "t8", name: 5 }, { id: "t7" }, { name: "No id" }, makeTortoises()[0], makeTortoises()[1]],
        entries: [null, 3, "m9", { id: 9, tortoiseId: "t1", date: "2026-01-01" }, { id: "e1", date: "2026-01-01" },
          { id: "e2", tortoiseId: "t1" }, { id: "e3", tortoiseId: "t1", date: 20260101 }, { id: "e4", tortoiseId: 1, date: "2026-01-01" }, ...good]
      });
      const r = L.parseBackup(text);
      expect(r.tortoises).toStrictEqual(makeTortoises());
      expect(r.entries).toStrictEqual(makeEntries());
    });
  });

  describe("mergeBackup", () => {
    it("round trip: buildBackup -> JSON -> parseBackup -> mergeBackup into an empty store gives identical records", () => {
      const text = JSON.stringify(L.buildBackup(makeTortoises(), makeEntries(), true, NOW));
      const data = L.parseBackup(text);
      const r = L.mergeBackup(empty(), data);
      expect(r.tortoises).toStrictEqual(makeTortoises());
      expect(r.entries).toStrictEqual(makeEntries());
      expect(r.tortoisePuts).toStrictEqual(makeTortoises());
      expect(r.entryPuts).toStrictEqual(makeEntries());
    });

    it("round trip without photos into a store that has them keeps the photos on the device", () => {
      const store = { tortoises: makeTortoises(), entries: makeEntries() };
      const data = L.parseBackup(JSON.stringify(L.buildBackup(makeTortoises(), makeEntries(), false, NOW)));
      expect(data.entries.every(e => e.photo === null)).toBe(true);
      const r = L.mergeBackup(store, data);
      const m1 = r.entries.find(e => e.id === "m1");
      expect(m1.photo).toBe(PHOTO);
      // What gets written to storage keeps the photo too.
      expect(r.entryPuts.find(e => e.id === "m1").photo).toBe(PHOTO);
      expect(r.entries).toHaveLength(3);
    });

    it("round trip without photos into an empty store has no photos", () => {
      const data = L.parseBackup(JSON.stringify(L.buildBackup(makeTortoises(), makeEntries(), false, NOW)));
      const r = L.mergeBackup(empty(), data);
      expect(r.entries.map(e => e.photo)).toEqual([null, null, null]);
    });

    it("replaces matching ids, adds new ones and never deletes others", () => {
      const store = {
        tortoises: [{ id: "t1", name: "Shell", species: "Leopard", sex: "Unknown", birth: null, createdAt: 1 },
          { id: "t3", name: "Keep me", species: "Hermann's", sex: "Male", birth: null, createdAt: 3 }],
        entries: [
          { id: "m1", kind: "measure", tortoiseId: "t1", date: "2026-09-01", createdAt: 1, plastron: 8, scl: 9, weightG: 300, photo: PHOTO, notes: "old" },
          { id: "x1", kind: "measure", tortoiseId: "t1", date: "2026-08-01", createdAt: 1, plastron: null, scl: null, weightG: 280, photo: PHOTO, notes: "" },
          { id: "keep", kind: "measure", tortoiseId: "t3", date: "2026-07-01", createdAt: 1, plastron: null, scl: null, weightG: 900, photo: null, notes: "" }
        ]
      };
      const snapshot = structuredClone(store);
      const tArr = store.tortoises, eArr = store.entries;
      const data = {
        tortoises: [{ id: "t1", name: "Shelly", species: "Sulcata (African spurred)", sex: "Female", birth: "2025-03-01", createdAt: 1 },
          { id: "t2", name: "Leo", species: "Leopard", sex: "Unknown", birth: null, createdAt: 2 }],
        entries: [
          { id: "m1", kind: "measure", tortoiseId: "t1", date: "2026-09-01", createdAt: 1, plastron: 8.5, scl: 9.5, weightG: 310, photo: null, notes: "new" },
          { id: "x1", kind: "measure", tortoiseId: "t1", date: "2026-08-01", createdAt: 1, plastron: null, scl: null, weightG: 280, photo: PHOTO2, notes: "" },
          { id: "m2", kind: "measure", tortoiseId: "t2", date: "2026-09-02", createdAt: 2, plastron: null, scl: null, weightG: 120, photo: null, notes: "" }
        ]
      };
      const dataSnapshot = structuredClone(data);
      const r = L.mergeBackup(store, data);

      // Tortoises: t1 replaced in place, t3 kept, t2 added.
      expect(r.tortoises.map(t => t.id)).toEqual(["t1", "t3", "t2"]);
      expect(r.tortoises[0]).toStrictEqual(data.tortoises[0]);
      expect(r.tortoises[1]).toStrictEqual(snapshot.tortoises[1]);
      expect(r.tortoisePuts).toBe(data.tortoises);

      // Entries: m1 replaced but keeps the device photo, x1 gets the backup's photo, keep stays, m2 added.
      expect(r.entries.map(e => e.id)).toEqual(["m1", "x1", "keep", "m2"]);
      expect(r.entries[0]).toStrictEqual({ ...data.entries[0], photo: PHOTO });
      expect(r.entries[1].photo).toBe(PHOTO2);
      expect(r.entries[2]).toStrictEqual(snapshot.entries[2]);
      expect(r.entries[3]).toStrictEqual(data.entries[2]);
      expect(r.entryPuts.map(e => e.id)).toEqual(["m1", "x1", "m2"]);
      expect(r.entryPuts[0].photo).toBe(PHOTO);

      // Nothing passed in is changed.
      expect(store.tortoises).toBe(tArr);
      expect(store.entries).toBe(eArr);
      expect(store).toStrictEqual(snapshot);
      expect(data).toStrictEqual(dataSnapshot);
      expect(r.tortoises).not.toBe(tArr);
      expect(r.entries).not.toBe(eArr);
    });

    it("an entry without a photo field in the backup also keeps the device photo", () => {
      const store = { tortoises: [], entries: [{ id: "m1", kind: "measure", tortoiseId: "t1", date: "2026-09-01", createdAt: 1, weightG: 300, photo: PHOTO }] };
      const data = { tortoises: [], entries: [{ id: "m1", kind: "measure", tortoiseId: "t1", date: "2026-09-01", createdAt: 1, weightG: 305 }] };
      const r = L.mergeBackup(store, data);
      expect(r.entries).toHaveLength(1);
      expect(r.entries[0]).toMatchObject({ weightG: 305, photo: PHOTO });
    });

    it("an entry with no photo on the device and none in the backup stays without a photo", () => {
      const store = { tortoises: [], entries: [{ id: "m1", kind: "measure", tortoiseId: "t1", date: "2026-09-01", createdAt: 1, weightG: 300, photo: null }] };
      const data = { tortoises: [], entries: [{ id: "m1", kind: "measure", tortoiseId: "t1", date: "2026-09-01", createdAt: 1, weightG: 305, photo: null }] };
      expect(L.mergeBackup(store, data).entries[0].photo).toBeNull();
    });

    it("importing the same backup twice changes nothing the second time", () => {
      const data = L.parseBackup(JSON.stringify(L.buildBackup(makeTortoises(), makeEntries(), true, NOW)));
      const once = L.mergeBackup(empty(), data);
      const twice = L.mergeBackup({ tortoises: once.tortoises, entries: once.entries }, data);
      expect(twice.tortoises).toStrictEqual(once.tortoises);
      expect(twice.entries).toStrictEqual(once.entries);
    });
  });
});

/* ---------- Fix 1: hostile backups ----------
   Backups are shared between keepers, so a file can be written by an attacker. Everything parseBackup returns ends up
   in the page (ids and dates in HTML attributes, photos in <img src>), so nothing in it may be able to leave an attribute. */
describe("U6 backup: hostile backups are cleaned before they reach the page (fix 1)", () => {
  const XSS = "\"><img src=x onerror=alert(1)>";
  const T = (over = {}) => ({ id: "t1", name: "Shelly", species: "Leopard", sex: "Female", birth: "2025-03-01", createdAt: 5, ...over });
  const M = (over = {}) => ({ id: "m1", kind: "measure", tortoiseId: "t1", date: "2026-09-01", createdAt: 1,
    plastron: 8.1, scl: 9.2, weightG: 310.5, photo: null, notes: "", ...over });
  const C = (over = {}) => ({ id: "c_t1_2026-09-01", kind: "care", tortoiseId: "t1", date: "2026-09-01", createdAt: 3,
    soaked: true, food: ["Weeds"], foodNote: "", poop: "", urates: "", notes: "", ...over });
  const backupText = (tortoises, entries) => JSON.stringify({ app: "kulalog", version: 1, exported: "2026-10-18T03:00:00.000Z", tortoises, entries });
  const without = (o, key) => { const c = { ...o }; delete c[key]; return c; };
  const show = v => typeof v === "string" ? JSON.stringify(v) : String(v);

  it("ids: only 1 to 100 letters, digits, _ and -; anything else drops the record", () => {
    const good = ["t1", "a", "A-Z_az-09", "mgx1k2abcde", "c_t1_2026-09-01", "x".repeat(100)];
    const bad = ["", " ", "t 1", "t1 ", " t1", "t1\n", "t\t1", "t\"1", "t'1", "t`1", "t<1", "t>1", "t&1", "t/1", "t\\1", "t.1", "t#1", "t%221", "t=1",
      "x".repeat(101), "\u01631", "t1\u0000", "t1\u2028", XSS, "t1\" onmouseover=\"alert(1)", "t1' autofocus onfocus='alert(1)"];
    for(const id of good){
      expect(L.cleanTortoise(T({ id }))?.id, `tortoise id ${show(id)}`).toBe(id);
      expect(L.cleanEntry(M({ id }))?.id, `entry id ${show(id)}`).toBe(id);
      expect(L.cleanEntry(C({ tortoiseId: id }))?.tortoiseId, `tortoiseId ${show(id)}`).toBe(id);
    }
    for(const id of [...bad, 1, 0, null, undefined, true, {}, ["t1"]]){
      expect(L.cleanTortoise(T({ id })), `tortoise id ${show(id)}`).toBeNull();
      expect(L.cleanEntry(M({ id })), `entry id ${show(id)}`).toBeNull();
      expect(L.cleanEntry(C({ tortoiseId: id })), `tortoiseId ${show(id)}`).toBeNull();
    }
    expect(L.cleanTortoise(without(T(), "id"))).toBeNull();
    expect(L.cleanEntry(without(M(), "id"))).toBeNull();
    expect(L.cleanEntry(without(M(), "tortoiseId"))).toBeNull();
  });

  it("dates: only real calendar days written yyyy-mm-dd; an entry with any other date is dropped, a birth date becomes null", () => {
    const good = ["2026-01-01", "2026-12-31", "2024-02-29", "2000-02-29", "1999-06-15", "1950-05-01"];
    const bad = ["2026-02-30", "2025-02-29", "1900-02-29", "2026-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "2026-01-32",
      "2026-1-1", "2026-01-1", "2026-1-01", "26-01-01", "2026/01/01", "01-01-2026", "20260101", "2026-01-01T00:00", "2026-01-01T00:00:00Z",
      "2026-01-01 ", " 2026-01-01", "2026-01-01\n", "+002026-01-01", "", "today", "Invalid Date", XSS,
      "9999-12-31\"><img src=x onerror=alert(1)>", "2026-01-01\" autofocus onfocus=\"alert(1)", "2026-01-01<script>alert(1)</script>"];
    for(const d of good){
      expect(L.cleanEntry(M({ date: d }))?.date, d).toBe(d);
      expect(L.cleanEntry(C({ date: d }))?.date, d).toBe(d);
      expect(L.cleanTortoise(T({ birth: d })).birth, d).toBe(d);
    }
    for(const d of [...bad, 20260101, null, undefined, true, {}, ["2026-01-01"], new Date("2026-01-01T00:00:00")]){
      expect(L.cleanEntry(M({ date: d })), `measure date ${show(d)}`).toBeNull();
      expect(L.cleanEntry(C({ date: d })), `care date ${show(d)}`).toBeNull();
      expect(L.cleanTortoise(T({ birth: d })), `birth ${show(d)}`).toMatchObject({ id: "t1", birth: null });
    }
  });

  it("photos: only base64 jpeg, png, webp or gif data URLs are kept; any other photo becomes null and the entry stays", () => {
    const good = ["data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==", "data:image/png;base64,iVBORw0KGgo=", "data:image/webp;base64,UklGRg",
      "data:image/gif;base64,R0lGODlhAQABAAAAACw=", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="];
    const bad = [
      "javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "java\nscript:alert(1)", "vbscript:msgbox(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", "data:text/html,<script>alert(1)</script>",
      "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIG9ubG9hZD0iYWxlcnQoMSkiLz4=",
      "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "data:image/svg+xml;utf8,<svg onload=alert(1)>",
      "data:image/png;base64,AAAA\" onerror=\"alert(1)", "data:image/png;base64,AAAA' onerror='alert(1)", "data:image/png;base64,AAAA onerror=alert(1)",
      "data:image/png;base64,AAAA\"><script>alert(1)</script>", "data:image/png;base64,AAAA\n", "data:image/png;base64,AAAA==\"",
      "data:image/png;base64,", "data:image/png,iVBORw0KGgo", "data:image/png;charset=utf-8;base64,AAAA", "data:image/bmp;base64,Qk0=",
      "data:image/x-icon;base64,AAAB", "data:;base64,AAAA", "https://tracker.example/pixel.gif", "http://192.168.1.1/x.png", "//evil.example/x.png",
      "blob:http://localhost:8090/0b8e8f3e", "file:///C:/Windows/win.ini", "x", "", XSS];
    for(const p of good) expect(L.cleanEntry(M({ photo: p })).photo, p).toBe(p);
    for(const p of [...bad, 1, true, {}, [good[0]]]){
      const e = L.cleanEntry(M({ photo: p }));
      expect(e, `photo ${show(p)}`).not.toBeNull();
      expect(e.photo, `photo ${show(p)}`).toBeNull();
    }
    expect(L.cleanEntry(M({ photo: null })).photo).toBeNull();
    // Through the whole parse as well: every entry is kept, none with its photo.
    const r = L.parseBackup(backupText([T()], bad.map((photo, i) => M({ id: "m" + i, photo }))));
    expect(r.entries).toHaveLength(bad.length);
    expect(r.entries.every(e => e.photo === null)).toBe(true);
  });

  it("measurements: only finite numbers above 0 and within range are kept, anything else becomes null", () => {
    for(const v of [12.5, 0.1, 3, 1e-3, 1000]){
      expect(L.cleanEntry(M({ plastron: v, scl: v, weightG: v }))).toMatchObject({ plastron: v, scl: v, weightG: v });
    }
    // Lengths up to 1000 cm, weights up to 1,000,000 g (1000 kg): well above any tortoise.
    expect(L.cleanEntry(M({ plastron: 1000.1, scl: 250000, weightG: 1e6 }))).toMatchObject({ plastron: null, scl: null, weightG: 1e6 });
    expect(L.cleanEntry(M({ weightG: 1e6 + 0.1 }))).toMatchObject({ weightG: null });
    for(const v of ["12", "12.5", "1e3", " 7", "<b>12</b>", NaN, Infinity, -Infinity, -5, 0, -0, null, true, [], [12], {}]){
      expect(L.cleanEntry(M({ plastron: v, scl: v, weightG: v })), show(v)).toMatchObject({ plastron: null, scl: null, weightG: null });
    }
    // JSON can't write NaN or Infinity, but a hand-edited 1e999 parses to Infinity.
    const r = L.parseBackup("{\"app\":\"kulalog\",\"tortoises\":[],\"entries\":[{\"id\":\"m1\",\"kind\":\"measure\",\"tortoiseId\":\"t1\"," +
      "\"date\":\"2026-09-01\",\"weightG\":1e999,\"plastron\":-1e999,\"scl\":\"9\",\"createdAt\":1e999}]}");
    expect(r.entries).toStrictEqual([{ id: "m1", kind: "measure", tortoiseId: "t1", date: "2026-09-01", weightG: null, plastron: null, scl: null, createdAt: 0 }]);
  });

  it("kind: measure, care or none (a first-prototype record); any other kind drops the entry", () => {
    expect(L.cleanEntry(M()).kind).toBe("measure");
    expect(L.cleanEntry(C()).kind).toBe("care");
    const legacy = L.cleanEntry(without(C(), "kind"));
    expect(legacy).not.toBeNull();
    expect(legacy).not.toHaveProperty("kind");
    for(const kind of ["Measure", "CARE", "", "note", "measure ", "<script>alert(1)</script>", null, 1, true, ["care"], {}]){
      expect(L.cleanEntry(M({ kind })), `kind ${show(kind)}`).toBeNull();
    }
  });

  it("tortoises: sex is Unknown, Male or Female, a missing species is Other, and nothing but the known fields is kept", () => {
    for(const sex of ["Unknown", "Male", "Female"]) expect(L.cleanTortoise(T({ sex })).sex).toBe(sex);
    for(const sex of ["male", "FEMALE", "", "M", "<b>Male</b>", XSS, 1, null, undefined, {}, ["Male"]]){
      expect(L.cleanTortoise(T({ sex })).sex, `sex ${show(sex)}`).toBe("Unknown");
    }
    for(const species of ["", null, undefined, 7, {}, ["Leopard"]]){
      expect(L.cleanTortoise(T({ species })).species, `species ${show(species)}`).toBe("Other");
    }
    // Extra fields (and a "__proto__" key, which JSON.parse keeps as a plain key) don't survive.
    const hostile = JSON.parse(JSON.stringify(T({ createdAt: "1700000000000", onclick: "alert(1)", style: "x", html: XSS }))
      .replace(/^\{/, "{\"__proto__\":{\"isAdmin\":true,\"photo\":\"javascript:alert(1)\"},"));
    const t = L.cleanTortoise(hostile);
    expect(t).toStrictEqual({ id: "t1", createdAt: 0, name: "Shelly", species: "Leopard", sex: "Female", birth: "2025-03-01" });
    expect(Object.getPrototypeOf(t)).toBe(Object.prototype);
    expect(t.isAdmin).toBeUndefined();
    for(const createdAt of [NaN, Infinity, "5", null, {}]) expect(L.cleanTortoise(T({ createdAt })).createdAt).toBe(0);
  });

  it("text: markup is kept as text, long text is cut to what the forms allow, anything that isn't text becomes empty", () => {
    const t = L.cleanTortoise(T({ name: "N".repeat(500), species: "S".repeat(500) }));
    expect(t.name).toBe("N".repeat(40));
    expect(t.species).toBe("S".repeat(60));
    // Markup stays as typed: the page escapes it when it shows it.
    expect(L.cleanTortoise(T({ name: "<b>Kuro</b>", species: XSS }))).toMatchObject({ name: "<b>Kuro</b>", species: XSS });

    const e = L.cleanEntry(C({ notes: "n".repeat(5000), foodNote: "f".repeat(500), poop: "p".repeat(500), urates: "u".repeat(500),
      food: ["x".repeat(200), 7, null, { a: 1 }, ["Weeds"], "Weeds", XSS], soaked: "true" }));
    expect(e).toMatchObject({ notes: "n".repeat(1000), foodNote: "f".repeat(120), poop: "p".repeat(60), urates: "u".repeat(60),
      food: ["x".repeat(60), "Weeds", XSS], soaked: false });
    expect(L.cleanEntry(M({ notes: "m".repeat(5000) })).notes).toBe("m".repeat(1000));
    for(const v of [5, null, true, {}, ["a"]]){
      expect(L.cleanEntry(C({ notes: v, foodNote: v, poop: v, urates: v })), show(v)).toMatchObject({ notes: "", foodNote: "", poop: "", urates: "" });
    }
    for(const food of ["Weeds", 5, null, { 0: "Weeds", length: 1 }]) expect(L.cleanEntry(C({ food })).food, show(food)).toEqual([]);
    for(const soaked of [1, "yes", "true", {}, [true]]) expect(L.cleanEntry(C({ soaked })).soaked, show(soaked)).toBe(false);
    expect(L.cleanEntry(C({ soaked: true })).soaked).toBe(true);
  });

  it("a tortoise without a usable name is dropped", () => {
    for(const name of ["", " ", "  \n\t ", null, undefined, 42, true, {}, ["Kuro"]]){
      expect(L.cleanTortoise(T({ name })), `name ${show(name)}`).toBeNull();
    }
    expect(L.cleanTortoise(without(T(), "name"))).toBeNull();
    expect(L.cleanTortoise(T({ name: " Kuro " })).name).toBe(" Kuro ");
    const r = L.parseBackup(backupText([T({ id: "t1", name: "" }), T({ id: "t2", name: "  " }), T({ id: "t3", name: "Kuro" })], []));
    expect(r.tortoises.map(t => t.id)).toEqual(["t3"]);
  });

  it("first-prototype entries (no kind) keep their mixed growth and care fields, each one checked, and still migrate", () => {
    const legacy = { id: "p1", tortoiseId: "t1", date: "2026-03-05", createdAt: "x", weightG: "300", plastron: -2, scl: 9.5,
      photo: "javascript:alert(1)", soaked: "yes", food: ["Greens", 7, "<b>x</b>"], foodNote: 42, poop: "P".repeat(80), urates: null, notes: ["a"] };
    expect(L.cleanEntry(legacy)).toStrictEqual({ id: "p1", tortoiseId: "t1", date: "2026-03-05", createdAt: 0, weightG: null, plastron: null, scl: 9.5,
      photo: null, soaked: false, food: ["Greens", "<b>x</b>"], foodNote: "", poop: "P".repeat(60), urates: "", notes: "" });
    // Fields an old record doesn't carry are not added.
    expect(L.cleanEntry({ id: "p2", tortoiseId: "t1", date: "2026-03-06", poop: "Runny" }))
      .toStrictEqual({ id: "p2", tortoiseId: "t1", date: "2026-03-06", createdAt: 0, poop: "Runny" });
    // A hostile old record can't get past the checks through the migration either.
    const hostile = { id: "p3", tortoiseId: "t1", date: "2026-03-07", photo: "data:image/png;base64,AAAA\" onerror=\"alert(1)", weightG: 5, notes: XSS, poop: XSS };
    const r = L.migrateEntries(L.parseBackup(backupText([T()], [legacy, hostile])).entries);
    const byId = Object.fromEntries(r.entries.map(e => [e.id, e]));
    expect(Object.keys(byId).sort()).toEqual(["c_t1_2026-03-05", "c_t1_2026-03-07", "p1", "p3"]);
    expect(byId.p1).toMatchObject({ kind: "measure", scl: 9.5, weightG: null, plastron: null, photo: null });
    expect(byId["c_t1_2026-03-05"]).toMatchObject({ kind: "care", food: ["Greens", "<b>x</b>"], poop: "P".repeat(60), soaked: false });
    // Markup stays text (the page escapes it); the bad photo is gone.
    expect(byId.p3).toMatchObject({ kind: "measure", weightG: 5, photo: null, notes: XSS });
    expect(byId["c_t1_2026-03-07"]).toMatchObject({ kind: "care", poop: XSS });
  });

  it("entries of dropped records go too: entries whose own id, tortoise id or date is unsafe are dropped, their good siblings stay", () => {
    const text = backupText(
      [T({ id: "t1" }), T({ id: XSS, name: "Evil id" }), T({ id: "t 4", name: "Spaced" })],
      [M({ id: "m1" }), M({ id: "m2", tortoiseId: XSS }), M({ id: "m3", tortoiseId: "t 4" }), M({ id: XSS }), M({ id: "m4", date: "2026-02-30" }),
        C({ id: "c1", date: "2026-1-1" }), M({ id: "m5", kind: "script" }), C({ id: "c2", tortoiseId: "t1\" onclick=\"x" }), C({ id: "c3" })]
    );
    const r = L.parseBackup(text);
    expect(r.tortoises.map(t => t.id)).toEqual(["t1"]);
    expect(r.entries.map(e => e.id)).toEqual(["m1", "c3"]);
  });

  it("nothing a parsed hostile backup puts in an HTML attribute can leave the attribute", () => {
    const payloads = [XSS, "\" onerror=\"alert(1)", "' onerror='alert(1)", "<script>alert(1)</script>", "x onerror=alert(1)", "javascript:alert(1)",
      "&quot; onerror=alert(1)", "`onerror=alert(1)`", "\u0000\"<", "2026-01-01\"><img src=x onerror=alert(1)>"];
    const tortoises = [], entries = [];
    payloads.forEach((p, i) => {
      tortoises.push(T({ id: p }), T({ id: "t" + i, name: p, species: p, sex: p, birth: p }));
      entries.push(M({ id: p }), M({ id: "m" + i, tortoiseId: p }), M({ id: "d" + i, date: p }), M({ id: "p" + i, tortoiseId: "t" + i, photo: p, notes: p }),
        M({ id: "q" + i, tortoiseId: "t" + i, photo: "data:image/png;base64,AAAA" + p }), C({ id: "c" + i, tortoiseId: "t" + i, date: p }),
        C({ id: "k" + i, tortoiseId: "t" + i, poop: p, urates: p, foodNote: p, notes: p, food: [p] }));
    });
    const r = L.parseBackup(backupText(tortoises, entries));
    const unsafe = /["'<>&`\s\u0000]/;
    expect(r.tortoises).toHaveLength(payloads.length);
    for(const t of r.tortoises){
      expect(t.id).not.toMatch(unsafe);
      expect(["Unknown", "Male", "Female"]).toContain(t.sex);
      expect(t.birth).toBeNull();
    }
    expect(r.entries.map(e => e.id).sort()).toEqual(payloads.flatMap((_, i) => ["k" + i, "p" + i, "q" + i]).sort());
    for(const e of r.entries){
      for(const k of ["id", "tortoiseId", "date"]) expect(e[k]).not.toMatch(unsafe);
      expect(e.photo ?? null).toBeNull();
    }
  });

  it("a \"__proto__\" key in a backup entry can't carry unchecked fields into the records the import writes and shows", () => {
    const hostilePhoto = "data:image/png;base64,AAAA\" onerror=\"alert(1)";
    // JSON.stringify would drop a __proto__ key, so it is written into the text by hand, as an attacker would.
    const text = backupText([T()], [without(M(), "photo")]).replace("\"id\":\"m1\",",
      `"id":"m1","__proto__":{"photo":${JSON.stringify(hostilePhoto)},"notes":${JSON.stringify(XSS)},"date":${JSON.stringify(XSS)}},`);
    expect(text).toContain("\"__proto__\"");
    const merged = L.mergeBackup({ tortoises: [], entries: [] }, L.parseBackup(text));
    expect(merged.entries).toHaveLength(1);
    for(const e of [...merged.entries, ...merged.entryPuts]){
      expect(e.photo ?? null).toBeNull();
      expect(e.notes).toBe("");
      expect(e.date).toBe("2026-09-01");
      expect(Object.getPrototypeOf(e)).toBe(Object.prototype);
    }
  });

  // Regression: cleanEntry copied the record with Object.assign, which treats a "__proto__" key from JSON.parse as the
  // prototype setter, so the record parseBackup returned inherited the unchecked photo. It is now built field by field.
  it("records from parseBackup don't inherit unchecked fields from a \"__proto__\" key", () => {
    const text = backupText([T()], [without(M(), "photo")]).replace("\"id\":\"m1\",", "\"id\":\"m1\",\"__proto__\":{\"photo\":\"javascript:alert(1)\"},");
    const e = L.parseBackup(text).entries[0];
    expect(e.photo ?? null).toBeNull();
    expect(Object.getPrototypeOf(e)).toBe(Object.prototype);
  });

  // Regression: any finite number above 0 passed, also 1.79e308. Chart.js 4.4.1 rounds the axis maximum of such a value up
  // to Infinity and never leaves its tick loop, so the tab froze as soon as that chart was drawn.
  it("impossible sizes such as a 1.79e308 cm plastron are not accepted from a backup", () => {
    const e = L.cleanEntry(M({ plastron: 1.79e308, scl: 1e300, weightG: Number.MAX_VALUE }));
    expect(e).toMatchObject({ plastron: null, scl: null, weightG: null });
  });
});
