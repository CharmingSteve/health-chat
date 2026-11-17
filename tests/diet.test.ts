import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExclusions, parseDayFirst, parseLegacyCsv, parseSnapshotLines, splitCsvLine, unmarshal } from "../src/ingest/diet.js";
import { readParquet, writeParquet } from "../src/ingest/parquet.js";

const OWNER = "owner";

// Lines in the same shape as the stuntman-diet DynamoDB export. Values are made up for the tests,
// and each expected number is worked out by hand below.
const entryLine = (day: string, calories: number, superseded: string | null) =>
  JSON.stringify({
    Item: {
      PK: { S: "USER#x" },
      SK: { S: `DAY#${day}#ENTRY#id-${calories}` },
      entity: { S: "entry" },
      version: { N: "1" },
      data: {
        M: {
          day_key: { S: day },
          calories: { N: String(calories) },
          display_name: { S: `food ${calories}` },
          raw_text: { S: "raw" },
          occurred_at: { S: `${day}T12:00:00.000Z` },
          quantity: { N: "1" },
          unit: { S: "portion" },
          food_id: { NULL: true },
          superseded_by: superseded === null ? { NULL: true } : { S: superseded },
        },
      },
    },
  });

const dayLine = (day: string, burn: number) =>
  JSON.stringify({
    Item: {
      PK: { S: "USER#x" },
      SK: { S: `DAY#${day}#META` },
      entity: { S: "day" },
      version: { N: "8" },
      data: {
        M: {
          day_key: { S: day },
          burn_total: { N: String(burn) },
          completeness: { S: "complete" },
          eligibility: { S: "tracked" },
          burn_source: { S: "recorded" },
        },
      },
    },
  });

describe("unmarshal", () => {
  it("converts DynamoDB attribute values to plain JavaScript values", () => {
    expect(unmarshal({ M: { a: { S: "x" }, b: { N: "2.5" }, c: { BOOL: true }, d: { NULL: true }, e: { L: [{ N: "5" }] } } }))
      .toEqual({ a: "x", b: 2.5, c: true, d: null, e: [5] });
  });

  it("rejects an unknown attribute type rather than guessing", () => {
    expect(() => unmarshal({ SS: ["a"] })).toThrow("Unsupported DynamoDB attribute");
  });
});

describe("parseSnapshotLines", () => {
  it("keeps entries and days, counts other items, and marks superseded entries", () => {
    const lines = [
      entryLine("2026-10-25", 900, null), // active
      entryLine("2026-10-25", 300, "some-other-entry"), // superseded by a correction
      dayLine("2026-10-25", 2000),
      JSON.stringify({ Item: { PK: { S: "USER#x" }, SK: { S: "PROFILE" }, entity: { S: "profile" }, data: { M: {} } } }),
    ];
    const { entries, days, skipped } = parseSnapshotLines(lines, OWNER);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ source: "stuntman", owner: OWNER, day: "2026-10-25", calories: 900, superseded: false });
    expect(entries[1]).toMatchObject({ calories: 300, superseded: true });
    expect(days).toEqual([
      { owner: OWNER, day: "2026-10-25", burn_total: 2000, completeness: "complete", eligibility: "tracked", burn_source: "recorded" },
    ]);
    expect(skipped).toBe(1);
  });

  it("refuses an entry without calories instead of storing zero", () => {
    const bad = JSON.stringify({
      Item: { entity: { S: "entry" }, data: { M: { day_key: { S: "2026-10-25" } } } },
    });
    expect(() => parseSnapshotLines([bad], OWNER)).toThrow("without calories");
  });

  it("refuses a malformed day key", () => {
    const bad = JSON.stringify({ Item: { entity: { S: "day" }, data: { M: { day_key: { S: "25/10/2026" } } } } });
    expect(() => parseSnapshotLines([bad], OWNER)).toThrow("Bad day");
  });
});

describe("parseDayFirst", () => {
  it("reads 01/05/2025 as 1 May 2025 (day first), matching the ISO master file", () => {
    expect(parseDayFirst("01/05/2025")).toBe("2025-05-01");
  });
  it("reads 05/03/2026 as 5 March 2026", () => {
    expect(parseDayFirst("05/03/2026")).toBe("2026-03-05");
  });
  it("rejects a date that does not exist", () => {
    expect(() => parseDayFirst("31/02/2025")).toThrow("Impossible date");
  });
  it("rejects a non-date", () => {
    expect(() => parseDayFirst("2025-05-01")).toThrow("Not a dd/mm/yyyy");
  });
});

describe("parseLegacyCsv", () => {
  it("parses rows, handles quoted commas, and keeps blank quantity as null", () => {
    const csv = [
      "Date,Quantity,Food_Item,Calories",
      "01/05/2025,,Heaping tsp cream cheese,31",
      '02/05/2025,2,"Soup, instant",120',
      "03/05/2025,,Protein bar,211",
    ].join("\n");
    const rows = parseLegacyCsv(csv, OWNER);
    expect(rows.map((r) => [r.day, r.calories, r.quantity, r.display_name])).toEqual([
      ["2025-05-01", 31, null, "Heaping tsp cream cheese"],
      ["2025-05-02", 120, 2, "Soup, instant"],
      ["2025-05-03", 211, null, "Protein bar"],
    ]);
    expect(rows.every((r) => r.source === "legacy" && r.owner === OWNER)).toBe(true);
  });

  it("refuses a file whose header is not the expected one", () => {
    expect(() => parseLegacyCsv("Day,Kcal\n01/05/2025,31", OWNER)).toThrow("Unexpected legacy header");
  });

  it("refuses a row with missing calories", () => {
    expect(() => parseLegacyCsv("Date,Quantity,Food_Item,Calories\n01/05/2025,,Thing,", OWNER)).toThrow("Bad calories");
  });
});

describe("splitCsvLine", () => {
  it("handles escaped double quotes inside a quoted field", () => {
    expect(splitCsvLine('a,"say ""hi"", ok",c')).toEqual(["a", 'say "hi", ok', "c"]);
  });
});

describe("Parquet round trip", () => {
  it("writes rows with an explicit schema and reads back the same values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pq-test-"));
    try {
      const out = join(dir, "t.parquet");
      const rows = [
        { day: "2025-05-01", calories: 31, superseded: false },
        { day: "2025-05-02", calories: 120.5, superseded: true },
      ];
      const count = await writeParquet(rows, { day: "VARCHAR", calories: "DOUBLE", superseded: "BOOLEAN" }, out);
      expect(count).toBe(2);
      const back = await readParquet(out);
      expect(back.map((r) => [r.day, r.calories, r.superseded])).toEqual([
        ["2025-05-01", 31, false],
        ["2025-05-02", 120.5, true],
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("named exclusions", () => {
  const base = { owner: OWNER, occurred_at: "2025-01-05T12:00:00+02:00", display_name: "Protein drink/shake", raw_text: "protein drink 200 calories", calories: 200, quantity: 1, unit: "portion", food_id: null, superseded: false };
  it("drops exactly the seven duplicate drink rows and keeps a different drink on the same day", () => {
    const duplicates = Array.from({ length: 7 }, () => ({ ...base, source: "stuntman" as const, day: "2025-01-05" }));
    const other = { ...base, source: "stuntman" as const, day: "2025-01-05", occurred_at: "2025-01-05T18:00:00+02:00", raw_text: "protein drink 200 calories" };
    const { kept, excluded } = applyExclusions([...duplicates, other]);
    expect(excluded).toEqual({ "dup-protein-drink-2025-01-05": 7 });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.occurred_at).toBe("2025-01-05T18:00:00+02:00");
  });
  it("keeps the same drink on other days and legacy rows", () => {
    const rows = [
      { ...base, source: "stuntman" as const, day: "2025-01-06" },
      { ...base, source: "legacy" as const, day: "2025-01-05" },
    ];
    expect(applyExclusions(rows).kept).toHaveLength(2);
  });
});


describe("buildDietDays (assumed burn)", () => {
  const e = (day: string, superseded = false) => ({ source: "legacy" as const, owner: OWNER, day, occurred_at: null, display_name: "x", raw_text: null, calories: 100, quantity: null, unit: null, food_id: null, superseded });
  it("assumes 2000 kcal for a tracked day with no recorded burn", async () => {
    const { buildDietDays } = await import("../src/ingest/diet.js");
    const days = buildDietDays([e("2026-01-10")], [], OWNER);
    expect(days).toEqual([{ owner: OWNER, day: "2026-01-10", burn_total: null, burn_effective: 2000, burn_basis: "assumed_default", completeness: "complete", completeness_basis: "owner_confirmed_legacy", net_reliable: true, eligibility: null, burn_source: null }]);
  });
  it("uses a recorded burn when the app wrote one (exercise above the default)", async () => {
    const { buildDietDays } = await import("../src/ingest/diet.js");
    const meta = [{ owner: OWNER, day: "2026-01-11", burn_total: 2650, burn_effective: 2650, burn_basis: "recorded" as const, completeness: "complete", eligibility: "tracked", burn_source: "recorded" }];
    const [row] = buildDietDays([e("2026-01-11")], meta, OWNER);
    expect(row).toMatchObject({ burn_total: 2650, burn_effective: 2650, burn_basis: "recorded" });
  });
  it("treats a stored burn equal to the default as assumed, since only burns above the default are written", async () => {
    const { buildDietDays } = await import("../src/ingest/diet.js");
    const meta = [{ owner: OWNER, day: "2026-01-14", burn_total: 2000, completeness: "complete", eligibility: "tracked", burn_source: "recorded" }];
    const [row] = buildDietDays([e("2026-01-14")], meta, OWNER);
    expect(row).toMatchObject({ burn_total: 2000, burn_effective: 2000, burn_basis: "assumed_default" });
  });
  it("does not treat a metadata row without a recorded source as recorded", async () => {
    const { buildDietDays } = await import("../src/ingest/diet.js");
    const meta = [{ owner: OWNER, day: "2026-01-12", burn_total: 2000, burn_effective: 2000, burn_basis: "recorded" as const, completeness: null, eligibility: null, burn_source: "default" }];
    const [row] = buildDietDays([e("2026-01-12")], meta, OWNER);
    expect(row).toMatchObject({ burn_effective: 2000, burn_basis: "assumed_default" });
  });
  it("includes no burn for a day with no entries (it was not tracked)", async () => {
    const { buildDietDays } = await import("../src/ingest/diet.js");
    expect(buildDietDays([e("2026-01-13", true)], [], OWNER)).toEqual([]);
  });
});

describe("completeness and net reliability", () => {
  const e = (day: string) => ({ source: "legacy" as const, owner: OWNER, day, occurred_at: null, display_name: "x", raw_text: null, calories: 100, quantity: null, unit: null, food_id: null, superseded: false });
  it("marks legacy master days complete and reliable, with their basis recorded", async () => {
    const { buildDietDays } = await import("../src/ingest/diet.js");
    const [row] = buildDietDays([e("2025-05-01")], [], OWNER);
    expect(row).toMatchObject({ completeness: "complete", completeness_basis: "owner_confirmed_legacy", net_reliable: true });
  });
  it("marks partial days not reliable, and complete days reliable", async () => {
    const { buildDietDays } = await import("../src/ingest/diet.js");
    const meta = [
      { owner: OWNER, day: "2026-02-01", burn_total: 2000, completeness: "partial", eligibility: "tracked", burn_source: "default" },
      { owner: OWNER, day: "2026-02-02", burn_total: 2000, completeness: "complete", eligibility: "tracked", burn_source: "recorded" },
    ];
    const rows = buildDietDays([e("2026-02-01"), e("2026-02-02")], meta, OWNER);
    expect(rows.find((r) => r.day === "2026-02-01")).toMatchObject({ completeness: "partial", completeness_basis: "stuntman", net_reliable: false });
    expect(rows.find((r) => r.day === "2026-02-02")).toMatchObject({ completeness: "complete", net_reliable: true });
  });
});

describe("dropped days", () => {
  it("removes a day whose entries were all excluded, even if it has metadata", async () => {
    const { buildDietDays } = await import("../src/ingest/diet.js");
    const meta = [{ owner: OWNER, day: "2025-01-05", burn_total: 2000, completeness: "complete", eligibility: "tracked", burn_source: "default" }];
    expect(buildDietDays([], meta, OWNER, new Set(["2025-01-05"]))).toEqual([]);
  });
});
