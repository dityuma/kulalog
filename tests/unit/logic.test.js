// Unit tests for js/logic.js: units and numbers (U1, U2) and dates and small entry helpers (U8).
// Runs in Asia/Jakarta (WIB, UTC+7, no DST); vitest.config.mjs sets TZ.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const L = require("../../js/logic.js");

const DASH = "–"; // en dash shown for a missing value

// A keeper's browser may be set to Indonesian, where toLocaleString() writes 1235 as "1.235" and October as "Okt".
// The app's text is English ("1,235 g" next to "1.25 kg"), so its formats must not follow the browser locale.
// Node's default locale is usually English, which would hide such a mistake, so simulate an Indonesian default
// for calls that pass no locale.
function useIndonesianBrowserLocale(){
  const numFmt = Number.prototype.toLocaleString, dateFmt = Date.prototype.toLocaleDateString;
  vi.spyOn(Number.prototype, "toLocaleString").mockImplementation(function(locales, options){ return numFmt.call(this, locales ?? "id-ID", options); });
  vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function(locales, options){ return dateFmt.call(this, locales ?? "id-ID", options); });
  // Guard: the simulation is really active.
  expect((1235).toLocaleString()).toBe("1.235");
  expect(new Date(2026, 9, 18).toLocaleDateString(undefined, { month: "short" })).toBe("Okt");
}
afterEach(() => { vi.restoreAllMocks(); });

describe("test environment", () => {
  it("runs in Asia/Jakarta (UTC+7 all year)", () => {
    expect(process.env.TZ).toBe("Asia/Jakarta");
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-420);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(-420);
  });
});

/* ---------------------------------------------------------------- U1 */
describe("U1 weight units", () => {
  describe("useKgFor", () => {
    it("auto switches to kg at exactly 1000 g", () => {
      expect(L.useKgFor(0, "auto")).toBe(false);
      expect(L.useKgFor(450, "auto")).toBe(false);
      expect(L.useKgFor(999.9, "auto")).toBe(false);
      expect(L.useKgFor(1000, "auto")).toBe(true);
      expect(L.useKgFor(25000, "auto")).toBe(true);
    });
    it("kg is always kg, g is always g", () => {
      expect(L.useKgFor(1, "kg")).toBe(true);
      expect(L.useKgFor(999, "kg")).toBe(true);
      expect(L.useKgFor(1000, "g")).toBe(false);
      expect(L.useKgFor(50000, "g")).toBe(false);
    });
    it("an unknown or missing unit falls back to grams", () => {
      expect(L.useKgFor(5000, undefined)).toBe(false);
      expect(L.useKgFor(5000, "lb")).toBe(false);
    });
  });

  describe("fmtWeight", () => {
    it("auto shows grams below 1000 g, whole grams", () => {
      expect(L.fmtWeight(450, "auto")).toBe("450 g");
      expect(L.fmtWeight(0, "auto")).toBe("0 g");
      expect(L.fmtWeight(450.4, "auto")).toBe("450 g");
      expect(L.fmtWeight(450.5, "auto")).toBe("451 g");
      expect(L.fmtWeight(999.4, "auto")).toBe("999 g");
    });
    it("auto: 999.6 g is still below the kg threshold, so it rounds to \"1,000 g\" (current behaviour)", () => {
      // The g/kg choice is made on the raw value, before rounding. 1000 g itself shows in kg.
      expect(L.fmtWeight(999.6, "auto")).toBe("1,000 g");
      expect(L.fmtWeight(999.9, "auto")).toBe("1,000 g");
    });
    it("auto shows kg with two decimals from 1000 g", () => {
      expect(L.fmtWeight(1000, "auto")).toBe("1.00 kg");
      expect(L.fmtWeight(1500, "auto")).toBe("1.50 kg");
      expect(L.fmtWeight(1250, "auto")).toBe("1.25 kg");
      expect(L.fmtWeight(12340, "auto")).toBe("12.34 kg");
    });
    it("g always shows whole grams with a thousands separator", () => {
      expect(L.fmtWeight(1234.5, "g")).toBe("1,235 g");
      expect(L.fmtWeight(1000, "g")).toBe("1,000 g");
      expect(L.fmtWeight(25000, "g")).toBe("25,000 g");
      expect(L.fmtWeight(450, "g")).toBe("450 g");
    });
    it("kg always shows kg with two decimals, even for small weights", () => {
      expect(L.fmtWeight(450, "kg")).toBe("0.45 kg");
      expect(L.fmtWeight(1000, "kg")).toBe("1.00 kg");
      expect(L.fmtWeight(1250, "kg")).toBe("1.25 kg");
      expect(L.fmtWeight(5, "kg")).toBe("0.01 kg");
      expect(L.fmtWeight(4, "kg")).toBe("0.00 kg");
    });
    it("keeps the English thousands comma when the browser is set to Indonesian (\"1.235 g\" would read as 1.235 g)", () => {
      useIndonesianBrowserLocale();
      expect(L.fmtWeight(1234.5, "g")).toBe("1,235 g");
      expect(L.fmtWeight(25000, "g")).toBe("25,000 g");
      expect(L.fmtWeight(999.6, "auto")).toBe("1,000 g");
      expect(L.fmtWeight(1250, "auto")).toBe("1.25 kg");
    });
    it("a missing weight shows an en dash in every unit", () => {
      for(const unit of ["auto", "g", "kg"]){
        expect(L.fmtWeight(null, unit)).toBe(DASH);
        expect(L.fmtWeight(undefined, unit)).toBe(DASH);
      }
    });
  });

  describe("fmtWeightRate (the app passes the absolute rate and adds the sign itself)", () => {
    it("keeps one decimal for small gram rates under 10 g", () => {
      expect(L.fmtWeightRate(0, "auto")).toBe("0.0 g");
      expect(L.fmtWeightRate(0.5, "auto")).toBe("0.5 g");
      expect(L.fmtWeightRate(3.24, "auto")).toBe("3.2 g");
      expect(L.fmtWeightRate(9.94, "auto")).toBe("9.9 g");
      expect(L.fmtWeightRate(3.24, "g")).toBe("3.2 g");
    });
    it("whole grams from 10 g", () => {
      expect(L.fmtWeightRate(10, "auto")).toBe("10 g");
      expect(L.fmtWeightRate(12.6, "auto")).toBe("13 g");
      expect(L.fmtWeightRate(40, "auto")).toBe("40 g");
      expect(L.fmtWeightRate(40, "g")).toBe("40 g");
    });
    it("just under 10 g rounds up but keeps the decimal (current behaviour)", () => {
      expect(L.fmtWeightRate(9.96, "auto")).toBe("10.0 g");
    });
    it("kg rates use two decimals", () => {
      expect(L.fmtWeightRate(1500, "auto")).toBe("1.50 kg");
      expect(L.fmtWeightRate(40, "kg")).toBe("0.04 kg");
      expect(L.fmtWeightRate(10, "kg")).toBe("0.01 kg");
    });
    // Regression: under 10 g a month the Kilograms setting showed "0.00 kg", hiding a small loss or gain.
    it("rates under 10 g a month stay in grams even with the Kilograms setting", () => {
      expect(L.fmtWeightRate(2.5, "kg")).toBe("2.5 g");
      expect(L.fmtWeightRate(9.94, "kg")).toBe("9.9 g");
      expect(L.fmtWeightRate(0.4, "kg")).toBe("0.4 g");
    });
    it("large gram rates have no thousands separator, unlike fmtWeight (current behaviour)", () => {
      expect(L.fmtWeightRate(2500, "g")).toBe("2500 g");
    });
  });

  describe("toGrams", () => {
    it("converts kg to grams", () => {
      expect(L.toGrams("1.25", "kg")).toBe(1250);
      expect(L.toGrams(" 2,5 ", "kg")).toBe(2500);
      expect(L.toGrams("0.0004", "kg")).toBe(0.4);
    });
    it("keeps grams and accepts a decimal comma", () => {
      expect(L.toGrams("450", "g")).toBe(450);
      expect(L.toGrams("450,5", "g")).toBe(450.5);
      expect(L.toGrams("450.5", "g")).toBe(450.5);
    });
    it("rounds to 0.1 g", () => {
      expect(L.toGrams("450.56", "g")).toBe(450.6);
      expect(L.toGrams("450.54", "g")).toBe(450.5);
      expect(L.toGrams("1.23456", "kg")).toBe(1234.6);
    });
    it("treats a missing or unknown unit as grams", () => {
      expect(L.toGrams("450", undefined)).toBe(450);
      expect(L.toGrams("450", "auto")).toBe(450);
    });
    it("returns null for empty, zero, negative or junk input", () => {
      for(const v of ["", "  ", "abc", "0", "0,0", "-5", null, undefined]){
        expect(L.toGrams(v, "g"), JSON.stringify(v)).toBeNull();
        expect(L.toGrams(v, "kg"), JSON.stringify(v)).toBeNull();
      }
    });
    // Regression: "0.04" g rounded to 0 and a 0 g weight was saved; it is now refused like "0".
    it("a positive value that rounds to 0 g is refused", () => {
      expect(L.toGrams("0.04", "g")).toBeNull();
      expect(L.toGrams("0.00004", "kg")).toBeNull();
      expect(L.toGrams("0.05", "g")).toBe(0.1);
    });
    it("refuses trailing text such as a unit typed into the field", () => {
      expect(L.toGrams("1.2 kg", "g")).toBeNull();
      expect(L.toGrams("450g", "g")).toBeNull();
    });
  });

  describe("toCm", () => {
    it("rounds to 0.1 cm and accepts a decimal comma", () => {
      expect(L.toCm("12,46")).toBe(12.5);
      expect(L.toCm(" 14.2 ")).toBe(14.2);
      expect(L.toCm("7")).toBe(7);
    });
    it("returns null for empty, junk, zero or a value that rounds to 0", () => {
      for(const v of ["", "  ", "abc", "0", "-3", "0.04", "12 cm", null, undefined]) expect(L.toCm(v), JSON.stringify(v)).toBeNull();
    });
  });

  // Regression: any finite number was accepted, and an absurd size (e.g. "1.7e308") froze the growth chart.
  describe("upper bounds (no tortoise is over 1000 cm or 1000 kg)", () => {
    it("toCm accepts up to 1000 cm and refuses more", () => {
      expect(L.MAX_CM).toBe(1000);
      expect(L.toCm("1000")).toBe(1000);
      expect(L.toCm("1000.1")).toBeNull();
      expect(L.toCm("1.7e308")).toBeNull();
    });
    it("toGrams accepts up to 1000 kg and refuses more, in g and in kg", () => {
      expect(L.MAX_G).toBe(1e6);
      expect(L.toGrams("1.000.000", "g")).toBe(1e6);
      expect(L.toGrams("1000", "kg")).toBe(1e6);
      expect(L.toGrams("1000.1", "kg")).toBeNull();
      expect(L.toGrams("1000001", "g")).toBeNull();
      expect(L.toGrams("1.7e308", "g")).toBeNull();
    });
  });

  describe("round1 and fmtCm", () => {
    it("round1 rounds to one decimal", () => {
      expect(L.round1(12.34)).toBe(12.3);
      expect(L.round1(12.36)).toBe(12.4);
      expect(L.round1(1234.56)).toBe(1234.6);
      expect(L.round1(7)).toBe(7);
      expect(L.round1(0.04)).toBe(0);
      expect(L.round1(-1.26)).toBe(-1.3);
    });
    it("fmtCm shows one decimal and cm, en dash when missing", () => {
      expect(L.fmtCm(12.34)).toBe("12.3 cm");
      expect(L.fmtCm(12.36)).toBe("12.4 cm");
      expect(L.fmtCm(7)).toBe("7.0 cm");
      expect(L.fmtCm(0)).toBe("0.0 cm");
      expect(L.fmtCm(null)).toBe(DASH);
      expect(L.fmtCm(undefined)).toBe(DASH);
    });
  });
});

/* ---------------------------------------------------------------- U2 */
describe("U2 num (decimal comma)", () => {
  it("accepts a decimal comma, a dot, spaces and numbers", () => {
    expect(L.num("12,5")).toBe(12.5);
    expect(L.num("12.5")).toBe(12.5);
    expect(L.num(" 12.5 ")).toBe(12.5);
    expect(L.num(" 12,5 ")).toBe(12.5);
    expect(L.num("\t7\n")).toBe(7);
    expect(L.num("12")).toBe(12);
    expect(L.num(12)).toBe(12);
    expect(L.num(12.5)).toBe(12.5);
    expect(L.num("0.5")).toBe(0.5);
    expect(L.num(",5")).toBe(0.5);
    expect(L.num("12,50")).toBe(12.5);
  });

  it.each([
    ["\"0\"", "0"], ["\"0,0\"", "0,0"], ["\"-0\"", "-0"], ["\"-3\"", "-3"], ["\"-3,5\"", "-3,5"],
    ["\"abc\"", "abc"], ["\"\"", ""], ["\"  \"", "  "], ["null", null], ["undefined", undefined],
    ["0", 0], ["-1", -1], ["NaN", NaN], ["\"Infinity\"", "Infinity"], ["\"abc12\"", "abc12"], ["true", true]
  ])("rejects %s", (_label, v) => {
    expect(L.num(v)).toBeNull();
  });

  // Regression: num() used to turn only the first comma into a dot and parseFloat the rest, so a number with a
  // thousands separator was cut at the separator and saved silently: "1.234,5" (how Indonesian keepers write 1234.5)
  // became 1.234 g, a weight 1000 times too small.
  it.each([
    ["\"1.234,5\" (Indonesian thousands, decimal comma)", "1.234,5", 1234.5],
    ["\"1,234.5\" (English thousands, decimal dot)", "1,234.5", 1234.5],
    ["\"1 234\" (space as thousands separator)", "1 234", 1234],
    ["\"1 234,5\" (no-break space, decimal comma)", "1 234,5", 1234.5],
    ["\"1.234.567\" (repeated dots group thousands)", "1.234.567", 1234567],
    ["\"1,234,567.25\" (English, several groups)", "1,234,567.25", 1234567.25],
    ["\"2.500,75\" (Indonesian)", "2.500,75", 2500.75]
  ])("reads %s in full", (_label, input, whole) => {
    expect(L.num(input)).toBe(whole);
  });

  it.each([
    ["\"12,5,3\" (repeated comma that is not a thousands group)", "12,5,3"],
    ["\"1,2.3\" (thousands group of one digit)", "1,2.3"],
    ["\"1.234,5,6\" (two decimal commas)", "1.234,5,6"],
    ["\"1.23.456\" (short group)", "1.23.456"],
    ["\"1.2345.678\" (long group)", "1.2345.678"],
    ["\"1.234.5678\" (last group too long, would read as 12345678)", "1.234.5678"],
    ["\"1,234,5678\" (last group too long, commas)", "1,234,5678"],
    ["\"1.234.56\" (last group too short)", "1.234.56"]
  ])("rejects the malformed %s so the form asks again", (_label, input) => {
    expect(L.num(input)).toBeNull();
  });

  it("a single dot or comma is always the decimal mark (\"1.250\" is 1.25, \"1,250\" is 1.25)", () => {
    // Ambiguous on its own (1250 for Indonesian thousands, 1.25 in English); the form examples use a decimal mark.
    expect(L.num("1.250")).toBe(1.25);
    expect(L.num("1,250")).toBe(1.25);
  });

  describe("other odd inputs", () => {
    // Regression: parseFloat ignored trailing text, so "12 kg" typed into the gram field was saved as 12 g.
    it("trailing text is refused: \"12abc\", \"12 kg\", \"450g\", \"12.5.\"", () => {
      for(const v of ["12abc", "12 kg", "450g", "1.2 kg", "12.5cm", "12.5."]) expect(L.num(v), v).toBeNull();
    });
    it("a leading plus sign is accepted: \"+5\" is 5", () => {
      expect(L.num("+5")).toBe(5);
    });
    it("exponent notation is accepted: \"1e3\" is 1000", () => {
      expect(L.num("1e3")).toBe(1000);
    });
  });
});

/* ---------------------------------------------------------------- U8 */
describe("U8 dates", () => {
  afterEach(() => { vi.useRealTimers(); });

  describe("todayISO", () => {
    it("uses the local (WIB) date, not the UTC date, near midnight", () => {
      // 18:30 UTC on 17 Oct is 01:30 WIB on 18 Oct.
      expect(L.todayISO(new Date("2026-10-17T18:30:00Z"))).toBe("2026-10-18");
      expect(L.todayISO(new Date("2026-10-17T16:59:59.999Z"))).toBe("2026-10-17");
      expect(L.todayISO(new Date("2026-10-17T17:00:00Z"))).toBe("2026-10-18");
      expect(L.todayISO(new Date("2026-10-18T16:59:59Z"))).toBe("2026-10-18");
    });
    it("rolls over the year at WIB midnight", () => {
      expect(L.todayISO(new Date("2026-12-31T16:59:00Z"))).toBe("2026-12-31");
      expect(L.todayISO(new Date("2026-12-31T17:30:00Z"))).toBe("2027-01-01");
    });
    it("accepts a timestamp and does not change the Date it is given", () => {
      const d = new Date("2026-10-17T18:30:00Z"), t = d.getTime();
      expect(L.todayISO(t)).toBe("2026-10-18");
      L.todayISO(d);
      expect(d.getTime()).toBe(t);
    });
    it("defaults to now", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-17T18:30:00Z"));
      expect(L.todayISO()).toBe("2026-10-18");
    });
  });

  describe("dateObj and fmtDate", () => {
    it("dateObj is local midnight of that day", () => {
      const d = L.dateObj("2026-10-18");
      expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 18, 0, 0]);
      expect(d.toISOString()).toBe("2026-10-17T17:00:00.000Z");
    });
    it("fmtDate uses day month year (en-GB)", () => {
      expect(L.fmtDate("2026-10-18")).toBe("18 Oct 2026");
      expect(L.fmtDate("2028-02-29")).toBe("29 Feb 2028");
    });
    it("fmtDate stays English when the browser is set to Indonesian (not \"18 Okt 2026\")", () => {
      useIndonesianBrowserLocale();
      expect(L.fmtDate("2026-10-18")).toBe("18 Oct 2026");
      expect(L.fmtDate("2026-05-01")).toBe("1 May 2026");
    });
  });

  describe("shiftDay", () => {
    it("moves within a month and by zero", () => {
      expect(L.shiftDay("2026-10-18", 0)).toBe("2026-10-18");
      expect(L.shiftDay("2026-10-18", 1)).toBe("2026-10-19");
      expect(L.shiftDay("2026-10-18", -7)).toBe("2026-10-11");
    });
    it("crosses a month end both ways", () => {
      expect(L.shiftDay("2026-10-31", 1)).toBe("2026-11-01");
      expect(L.shiftDay("2026-11-01", -1)).toBe("2026-10-31");
      expect(L.shiftDay("2026-04-30", 1)).toBe("2026-05-01");
    });
    it("crosses a year end both ways", () => {
      expect(L.shiftDay("2026-12-31", 1)).toBe("2027-01-01");
      expect(L.shiftDay("2027-01-01", -1)).toBe("2026-12-31");
      expect(L.shiftDay("2026-10-18", 365)).toBe("2027-10-18");
    });
    it("handles the leap day 2028-02-29", () => {
      expect(L.shiftDay("2028-02-28", 1)).toBe("2028-02-29");
      expect(L.shiftDay("2028-02-29", 1)).toBe("2028-03-01");
      expect(L.shiftDay("2028-03-01", -1)).toBe("2028-02-29");
      expect(L.shiftDay("2027-02-28", 1)).toBe("2027-03-01");
    });
  });

  describe("shiftMonth", () => {
    it("moves within a year and by zero", () => {
      expect(L.shiftMonth("2026-10", 0)).toBe("2026-10");
      expect(L.shiftMonth("2026-10", 1)).toBe("2026-11");
      expect(L.shiftMonth("2026-10", -1)).toBe("2026-09");
    });
    it("crosses year boundaries forwards and backwards", () => {
      expect(L.shiftMonth("2026-12", 1)).toBe("2027-01");
      expect(L.shiftMonth("2027-01", -1)).toBe("2026-12");
      expect(L.shiftMonth("2026-10", 15)).toBe("2028-01");
      expect(L.shiftMonth("2026-01", -13)).toBe("2024-12");
      expect(L.shiftMonth("2026-10", -22)).toBe("2024-12");
    });
  });

  describe("daysBetween", () => {
    it("counts whole days, signed", () => {
      expect(L.daysBetween("2026-10-18", "2026-10-18")).toBe(0);
      expect(L.daysBetween("2026-10-01", "2026-10-18")).toBe(17);
      expect(L.daysBetween("2026-10-18", "2026-10-01")).toBe(-17);
      expect(L.daysBetween("2026-01-01", "2027-01-01")).toBe(365);
    });
    it("knows leap years", () => {
      expect(L.daysBetween("2028-02-01", "2028-03-01")).toBe(29);
      expect(L.daysBetween("2027-02-01", "2027-03-01")).toBe(28);
      expect(L.daysBetween("2028-01-01", "2029-01-01")).toBe(366);
    });
  });

  describe("ageText", () => {
    const now = new Date(2026, 9, 18, 10, 0); // 18 Oct 2026, 10:00 WIB
    it("is null with no birth date", () => {
      expect(L.ageText(null, now)).toBeNull();
      expect(L.ageText(undefined, now)).toBeNull();
      expect(L.ageText("", now)).toBeNull();
    });
    it("is null for a birth date in the future", () => {
      expect(L.ageText("2026-10-19", now)).toBeNull();
      expect(L.ageText("2027-01-01", now)).toBeNull();
    });
    it("counts months under a year", () => {
      expect(L.ageText("2026-10-18", now)).toBe("0 months old");
      expect(L.ageText("2026-09-18", now)).toBe("1 month old");
      expect(L.ageText("2026-07-18", now)).toBe("3 months old");
      expect(L.ageText("2025-10-19", now)).toBe("11 months old");
    });
    it("uses years and months from one year", () => {
      expect(L.ageText("2025-10-18", now)).toBe("1 yr old");
      expect(L.ageText("2024-07-18", now)).toBe("2 yr 3 mo old");
      expect(L.ageText("2016-10-18", now)).toBe("10 yr old");
      expect(L.ageText("2024-09-18", now)).toBe("2 yr 1 mo old");
    });
    it("a month only counts once the day of the month is reached", () => {
      expect(L.ageText("2026-07-19", now)).toBe("2 months old");
      expect(L.ageText("2024-07-19", now)).toBe("2 yr 2 mo old");
      expect(L.ageText("2026-01-31", new Date(2026, 1, 28))).toBe("0 months old");
      expect(L.ageText("2026-01-31", new Date(2026, 2, 1))).toBe("1 month old");
      expect(L.ageText("2024-02-29", new Date(2025, 1, 28))).toBe("11 months old");
      expect(L.ageText("2024-02-29", new Date(2025, 2, 1))).toBe("1 yr old");
    });
    it("works on the local day: 18:30 UTC on 17 Oct is already 18 Oct in WIB", () => {
      expect(L.ageText("2026-07-18", new Date("2026-10-17T18:30:00Z"))).toBe("3 months old");
    });
    it("defaults to now", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-18T03:00:00Z"));
      expect(L.ageText("2024-07-18")).toBe("2 yr 3 mo old");
    });
  });

  describe("sortEntries", () => {
    const list = [
      { id: "a", date: "2026-10-01", createdAt: 5 },
      { id: "b", date: "2026-10-18", createdAt: 1 },
      { id: "c", date: "2026-10-18", createdAt: 9 },
      { id: "d", date: "2025-12-31", createdAt: 100 },
      { id: "e", date: "2026-10-18", createdAt: 4 }
    ];
    it("orders newest date first, then newest createdAt first on the same day", () => {
      expect(L.sortEntries(list).map(e => e.id)).toEqual(["c", "e", "b", "a", "d"]);
    });
    it("returns a new array and leaves the input order alone", () => {
      const out = L.sortEntries(list);
      expect(out).not.toBe(list);
      expect(list.map(e => e.id)).toEqual(["a", "b", "c", "d", "e"]);
    });
  });

  describe("latest", () => {
    it("returns the first non-missing value of a newest-first list, keeping 0", () => {
      const list = [{ weightG: null, scl: 0 }, { weightG: 420 }, { weightG: 300, scl: 9 }];
      expect(L.latest(list, "weightG")).toBe(420);
      expect(L.latest(list, "scl")).toBe(0);
      expect(L.latest(list, "plastron")).toBeNull();
      expect(L.latest([], "weightG")).toBeNull();
    });
  });

  describe("isFed", () => {
    it("is true when food was picked or a food note was written", () => {
      expect(L.isFed({ food: ["Greens"] })).toBe(true);
      expect(L.isFed({ food: [], foodNote: "dandelion" })).toBe(true);
      expect(L.isFed({ foodNote: "hibiscus" })).toBe(true);
    });
    it("is false without food", () => {
      expect(L.isFed({})).toBe(false);
      expect(L.isFed({ food: [], foodNote: "" })).toBe(false);
      expect(L.isFed({ soaked: true, poop: "Normal, firm" })).toBe(false);
    });
  });

  describe("BAD_POOP and BAD_URATES", () => {
    // The app's dropdown choices live in js/app.js; read them so a renamed option is caught.
    const appSrc = readFileSync(new URL("../../js/app.js", import.meta.url), "utf8");
    const listFrom = name => JSON.parse(appSrc.match(new RegExp("const " + name + " = (\\[[^\\]]*\\]);"))[1]);
    const POOP = listFrom("POOP"), URATES = listFrom("URATES");

    it("flag the worrying choices", () => {
      expect(L.BAD_POOP).toEqual(["Runny", "Dry / hard", "Contains undigested food"]);
      expect(L.BAD_URATES).toEqual(["Gritty / chalky"]);
    });
    it("every flagged value is a choice the care form offers", () => {
      for(const p of L.BAD_POOP) expect(POOP).toContain(p);
      for(const u of L.BAD_URATES) expect(URATES).toContain(u);
    });
    it("healthy choices are not flagged", () => {
      for(const p of ["Normal, firm", "Soft", "None"]){ expect(POOP).toContain(p); expect(L.BAD_POOP).not.toContain(p); }
      for(const u of ["Clear / liquid", "Soft white paste", "None"]){ expect(URATES).toContain(u); expect(L.BAD_URATES).not.toContain(u); }
    });
  });
});
