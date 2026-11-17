import { describe, expect, it } from "vitest";
import { MAX_ROWS, validateSql } from "../src/query.js";

describe("validateSql accepts", () => {
  it("a plain SELECT on an approved table, and adds the row limit", () => {
    const r = validateSql("SELECT day, calories FROM diet_entries WHERE source = 'legacy'");
    expect(r).toEqual({ ok: true, sql: `SELECT * FROM (SELECT day, calories FROM diet_entries WHERE source = 'legacy') AS q LIMIT ${MAX_ROWS}` });
  });
  it("a trailing semicolon", () => {
    expect(validateSql("SELECT count(*) FROM lab_results;").ok).toBe(true);
  });
  it("a WITH query that names its own intermediate result", () => {
    expect(validateSql("WITH d AS (SELECT day FROM diet_days) SELECT count(*) FROM d").ok).toBe(true);
  });
  it("a join between two approved tables", () => {
    expect(validateSql("SELECT w.activity_type FROM apple_workouts w JOIN apple_routes r ON r.file = w.route_file").ok).toBe(true);
  });
  it("the REPLACE function inside a SELECT (it is not a write)", () => {
    expect(validateSql("SELECT replace(display_name, 'x', 'y') FROM diet_entries").ok).toBe(true);
  });
});

describe("validateSql refuses", () => {
  const cases: [string, RegExp][] = [
    ["DROP TABLE diet_entries", /Only SELECT/],
    ["DELETE FROM diet_entries", /Only SELECT/],
    ["SELECT 1; DROP TABLE diet_entries", /Only one statement/],
    ["SELECT * FROM diet_entries; SELECT 1", /Only one statement/],
    ["SELECT 1 -- hidden", /Comments/],
    ["SELECT /* x */ 1 FROM diet_days", /Comments/],
    ["SELECT * FROM secret_table", /Unknown table "secret_table"/],
    ["SELECT * FROM other_db.diet_days", /Unknown table "other_db"/],
    ["SELECT * FROM \"diet_days\"", /plain table names/],
    ["WITH x AS (SELECT 1) INSERT INTO diet_days SELECT 1", /Only SELECT|INSERT/],
    ["SELECT 1 FROM diet_days WHERE 1=1 UNION SELECT 1 FROM diet_days; UPDATE diet_days SET day = 1", /Only one statement/],
    ["", /Empty/],
  ];
  for (const [sql, pattern] of cases) {
    it(`refuses: ${sql || "(empty)"}`, () => {
      const r = validateSql(sql);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(pattern);
    });
  }
});
