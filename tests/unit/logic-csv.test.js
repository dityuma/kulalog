// Unit tests for js/logic.js: CSV export of measurements (U7).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const L = require("../../js/logic.js");

const BOM = "﻿";
const HEADER = "Tortoise,Species,Date,Weight (g),Plastron (cm),Carapace SCL (cm),Notes,Has photo";
const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";

const measure = (id, tortoiseId, date, fields = {}, createdAt = 1) => ({
  id, kind: "measure", tortoiseId, date, createdAt, plastron: null, scl: null, weightG: null, photo: null, notes: "", ...fields
});
const lines = text => text.slice(1).split("\r\n");

describe("U7 CSV", () => {
  describe("csvCell", () => {
    it("leaves plain values alone and turns missing values into empty cells", () => {
      expect(L.csvCell("Shelly")).toBe("Shelly");
      expect(L.csvCell("a=b")).toBe("a=b");
      expect(L.csvCell("2026-10-18")).toBe("2026-10-18");
      expect(L.csvCell(null)).toBe("");
      expect(L.csvCell(undefined)).toBe("");
      expect(L.csvCell("")).toBe("");
    });

    it("keeps numbers as numbers, including negative ones", () => {
      expect(L.csvCell(310.5)).toBe("310.5");
      expect(L.csvCell(0)).toBe("0");
      expect(L.csvCell(-3)).toBe("-3");
      expect(L.csvCell(1234.5)).toBe("1234.5");
    });

    it("quotes commas, double quotes and line breaks", () => {
      expect(L.csvCell("a, b")).toBe("\"a, b\"");
      expect(L.csvCell("say \"hi\"")).toBe("\"say \"\"hi\"\"\"");
      expect(L.csvCell("line1\nline2")).toBe("\"line1\nline2\"");
      expect(L.csvCell("line1\r\nline2")).toBe("\"line1\r\nline2\"");
      expect(L.csvCell("a\rb")).toBe("\"a\rb\"");
    });

    it.each([
      ["=", "=SUM(A1:A2)", "'=SUM(A1:A2)"],
      ["+", "+1", "'+1"],
      ["-", "-3", "'-3"],
      ["@", "@cmd", "'@cmd"],
      ["tab", "\tx", "'\tx"],
      ["CR", "\rx", "\"'\rx\""]
    ])("neutralises a string starting with %s", (_label, input, out) => {
      expect(L.csvCell(input)).toBe(out);
    });

    it("neutralises and quotes a formula that also has quotes and commas", () => {
      expect(L.csvCell("=HYPERLINK(\"http://x\",\"y\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\",\"\"y\"\")\"");
      expect(L.csvCell("=1,2")).toBe("\"'=1,2\"");
    });

    it("only looks at the first character (current behaviour: a leading space is not neutralised)", () => {
      expect(L.csvCell(" =1+1")).toBe(" =1+1");
    });
  });

  describe("buildCsv", () => {
    const tortoises = [
      { id: "t1", name: "Zed", species: "Sulcata (African spurred)" },
      { id: "t2", name: "alpha", species: "Testudo graeca, ibera" },
      { id: "t3", name: "Beta", species: "Hermann's" }
    ];
    const entries = [
      measure("z2", "t1", "2026-09-10", { weightG: 500, plastron: 10.5, scl: 12 }, 20),
      measure("z1", "t1", "2026-08-01", { weightG: 450.5, photo: PHOTO, notes: "after a soak" }, 10),
      { id: "c_t1_2026-08-01", kind: "care", tortoiseId: "t1", date: "2026-08-01", createdAt: 11, soaked: true, food: ["Greens"], foodNote: "", poop: "", urates: "", notes: "care notes" },
      { id: "legacy", tortoiseId: "t1", date: "2026-07-01", createdAt: 5, weightG: 400 },
      measure("a2", "t2", "2026-09-01", { weightG: 1234.5, notes: "=cmd()" }, 30),
      measure("a1", "t2", "2026-09-01", { scl: 8.2 }, 25),
      measure("a0", "t2", "2026-06-15", { plastron: 7, notes: "says \"hi\", ok" }, 99),
      measure("orphan", "gone", "2026-09-01", { weightG: 1 }, 1)
    ];
    const ALL_ROWS = [
      "alpha,\"Testudo graeca, ibera\",2026-06-15,,7,,\"says \"\"hi\"\", ok\",no",
      "alpha,\"Testudo graeca, ibera\",2026-09-01,,,8.2,,no",
      "alpha,\"Testudo graeca, ibera\",2026-09-01,1234.5,,,'=cmd(),no",
      "Zed,Sulcata (African spurred),2026-08-01,450.5,,,after a soak,yes",
      "Zed,Sulcata (African spurred),2026-09-10,500,10.5,12,,no"
    ];

    it("starts with a byte order mark and the header row", () => {
      const { text } = L.buildCsv(tortoises, entries);
      expect(text.startsWith(BOM)).toBe(true);
      expect(text.startsWith(BOM + HEADER + "\r\n")).toBe(true);
    });

    it("has one row per measurement, tortoises by name, oldest first, weight in grams", () => {
      const { count, text } = L.buildCsv(tortoises, entries);
      expect(count).toBe(5);
      expect(text).toBe(BOM + [HEADER, ...ALL_ROWS].join("\r\n"));
    });

    it("only measurements: care records, prototype records and other tortoises' records are left out", () => {
      const { text } = L.buildCsv(tortoises, entries);
      expect(text).not.toContain("care notes");
      expect(text).not.toContain(",400,");
      expect(text).not.toContain("2026-07-01");
      // Beta has no measurements, so no rows.
      expect(lines(text).filter(l => l.startsWith("Beta"))).toEqual([]);
    });

    it("uses CRLF between lines, with no line break at the end", () => {
      const { text } = L.buildCsv(tortoises, entries);
      expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
      expect(text.endsWith("\r\n")).toBe(false);
      expect(lines(text)).toHaveLength(6);
    });

    it("keeps a line break inside notes in one quoted cell", () => {
      const { count, text } = L.buildCsv([tortoises[0]], [measure("n", "t1", "2026-09-01", { weightG: 5, notes: "line 1\nline 2" })]);
      expect(count).toBe(1);
      expect(text).toBe(BOM + HEADER + "\r\nZed,Sulcata (African spurred),2026-09-01,5,,,\"line 1\nline 2\",no");
    });

    it("filters to one tortoise by id", () => {
      const { count, text } = L.buildCsv(tortoises, entries, "t1");
      expect(count).toBe(2);
      expect(text).toBe(BOM + [HEADER, ALL_ROWS[3], ALL_ROWS[4]].join("\r\n"));
    });

    it("gives only the header and count 0 when there is nothing to export", () => {
      expect(L.buildCsv(tortoises, entries, "t3")).toStrictEqual({ count: 0, text: BOM + HEADER });
      expect(L.buildCsv(tortoises, entries, "nobody")).toStrictEqual({ count: 0, text: BOM + HEADER });
      expect(L.buildCsv([], [])).toStrictEqual({ count: 0, text: BOM + HEADER });
    });

    it("neutralises a tortoise name that looks like a formula", () => {
      const { text } = L.buildCsv([{ id: "t9", name: "=Evil", species: "-Other" }], [measure("e", "t9", "2026-09-01", { weightG: 99 })]);
      expect(lines(text)[1]).toBe("'=Evil,'-Other,2026-09-01,99,,,,no");
    });

    it("does not reorder the arrays it is given", () => {
      const ts = tortoises.slice(), es = entries.slice();
      L.buildCsv(ts, es);
      expect(ts).toEqual(tortoises);
      expect(es).toEqual(entries);
    });
  });

  describe("fileSlug", () => {
    it("lowercases and joins words with single hyphens", () => {
      expect(L.fileSlug("Shelly")).toBe("shelly");
      expect(L.fileSlug("Mr. Shell & Co!")).toBe("mr-shell-co");
      expect(L.fileSlug("  --Leo 2--  ")).toBe("leo-2");
      expect(L.fileSlug("Big_Tortoise#1")).toBe("big-tortoise-1");
    });
    it("drops letters outside a-z (current behaviour)", () => {
      expect(L.fileSlug("Tortue Été")).toBe("tortue-t");
      expect(L.fileSlug("龟")).toBe("");
    });
  });
});
