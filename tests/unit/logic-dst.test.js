// Date logic in a timezone with daylight saving time (Europe/London).
// The app is a PWA that can run anywhere; dates are stored as local yyyy-mm-dd, so calendar maths
// must not depend on the 23/25-hour days around a clock change.
// This file switches TZ for its own worker and puts it back afterwards.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("../../js/logic.js");

const m = (id, date, weightG) => ({ id, kind: "measure", tortoiseId: "t1", date, createdAt: 1, plastron: null, scl: null, weightG, photo: null, notes: "" });

describe("dates in a DST timezone (Europe/London, clocks go forward 29 Mar 2026, back 25 Oct 2026)", () => {
  let savedTZ;
  beforeAll(() => { savedTZ = process.env.TZ; process.env.TZ = "Europe/London"; });
  afterAll(() => { process.env.TZ = savedTZ; });

  it("the switch to London time took effect", () => {
    // Setting process.env.TZ at runtime works in the default "forks" pool. Under --pool=threads each worker
    // thread has its own copy of process.env and the switch is ignored, so this guard fails instead of the
    // tests below passing in Jakarta time without testing anything.
    const why = "TZ switch ignored: run this file in the default forks pool, not --pool=threads";
    expect(new Date(2026, 0, 15).getTimezoneOffset(), why).toBe(0);
    expect(new Date(2026, 6, 15).getTimezoneOffset(), why).toBe(-60);
  });

  it("shiftDay, daysBetween and todayISO are not thrown off by the clock change", () => {
    expect(L.shiftDay("2026-03-28", 1)).toBe("2026-03-29");
    expect(L.shiftDay("2026-03-29", 1)).toBe("2026-03-30");
    expect(L.shiftDay("2026-10-25", 1)).toBe("2026-10-26");
    expect(L.shiftDay("2026-10-26", -1)).toBe("2026-10-25");
    expect(L.daysBetween("2026-03-25", "2026-04-01")).toBe(7);
    expect(L.daysBetween("2026-01-01", "2026-04-01")).toBe(90);
    expect(L.todayISO(new Date("2026-07-01T23:30:00Z"))).toBe("2026-07-02");
    expect(L.ageText("2026-03-01", new Date(2026, 3, 1))).toBe("1 month old");
  });

  // Regression: perMonth used to measure the span in milliseconds / 864e5, so a span containing the spring clock
  // change was 1 hour short and exactly one week apart gave 6.958 days < 7 -> null. It now counts calendar days.
  it("perMonth gives a rate for two weights exactly a week apart across the spring clock change", () => {
    const list = L.sortEntries([m("a", "2026-03-25", 100), m("b", "2026-04-01", 107)]);
    expect(L.perMonth(list, "weightG")).toBeCloseTo(30, 9);
  });

  // Regression, same cause: 300 g -> 420 g from 1 Jan to 1 Apr (90 calendar days) gave 40.0185 g/month instead of 40.
  it("perMonth uses calendar days across the clock change (300 g -> 420 g over 90 days = 40 g/month)", () => {
    const list = L.sortEntries([m("a", "2026-01-01", 300), m("b", "2026-04-01", 420)]);
    expect(L.perMonth(list, "weightG")).toBeCloseTo(40, 9);
  });

  // 25 Oct 2026 has 25 hours in London, so a span containing it is 1 hour longer than its calendar days.
  it("daysBetween counts calendar days across the autumn clock change (25-hour day)", () => {
    expect(L.daysBetween("2026-10-25", "2026-10-26")).toBe(1);
    expect(L.daysBetween("2026-10-26", "2026-10-25")).toBe(-1);
    expect(L.daysBetween("2026-10-20", "2026-10-27")).toBe(7);
    expect(L.daysBetween("2026-10-01", "2026-11-01")).toBe(31);
    // ...and across the spring one (23-hour day).
    expect(L.daysBetween("2026-03-29", "2026-03-30")).toBe(1);
    expect(L.daysBetween("2026-03-30", "2026-03-29")).toBe(-1);
  });

  it("shiftDay and todayISO around the autumn clock change", () => {
    expect(L.shiftDay("2026-10-24", 2)).toBe("2026-10-26");
    expect(L.shiftDay("2026-10-27", -7)).toBe("2026-10-20");
    // 23:30 UTC on 24 Oct is 00:30 BST on 25 Oct; 23:30 UTC on 25 Oct is 23:30 GMT, still 25 Oct.
    expect(L.todayISO(new Date("2026-10-24T23:30:00Z"))).toBe("2026-10-25");
    expect(L.todayISO(new Date("2026-10-25T23:30:00Z"))).toBe("2026-10-25");
  });

  it("perMonth across the autumn clock change: exactly a week gives 30/month, 6 days is still too short", () => {
    expect(L.perMonth(L.sortEntries([m("a", "2026-10-22", 100), m("b", "2026-10-29", 107)]), "weightG")).toBeCloseTo(30, 9);
    expect(L.perMonth(L.sortEntries([m("a", "2026-10-22", 100), m("b", "2026-10-28", 106)]), "weightG")).toBeNull();
  });

  it("perMonth is exact for spans that don't contain a clock change", () => {
    const list = L.sortEntries([m("a", "2026-05-01", 300), m("b", "2026-07-30", 420)]);
    expect(L.perMonth(list, "weightG")).toBeCloseTo(40, 9);
  });
});
