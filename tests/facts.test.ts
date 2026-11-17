import { describe, expect, it } from "vitest";
import { FACTS_SQL, formatFacts } from "../src/facts.js";
import { validateSql } from "../src/query.js";

describe("verified diet figures", () => {
  it("the fixed summary query passes the same checks as any model query", () => {
    expect(validateSql(FACTS_SQL).ok).toBe(true);
  });
  it("formats the single row as exact figures", () => {
    const text = formatFacts({
      ok: true, sql_run: "", row_count: 1, truncated: false, bytes_scanned: 0, error: undefined,
      columns: ["tracked_days", "first_day", "last_day", "complete_days", "partial_days", "missing_days", "avg_intake_all_days", "avg_burn_all_days", "avg_net_all_days", "avg_net_complete_days", "days_in_complete_average"],
      rows: [["176", "2025-05-01", "2026-11-16", "161", "14", "1", "2192.7", "2039.1", "153.7", "178.8", "161"]],
    });
    expect(text).toContain("Tracked days: 176 (from 2025-05-01 to 2026-11-16)");
    expect(text).toContain("Complete: 161; partial: 14; missing: 1");
    expect(text).toContain("Average net, complete days only (161 days): 178.8 kcal");
  });
  it("says it is unavailable instead of guessing when the query fails", () => {
    const text = formatFacts({ ok: false, columns: [], rows: [], row_count: 0, truncated: false, bytes_scanned: 0, sql_run: "", error: "Athena rejected" });
    expect(text).toContain("(unavailable: Athena rejected)");
  });
});
