import type { QueryResult } from "./query.js";

// Headline diet figures, computed by the database for every question. The model is told to quote these,
// not to recompute them, so counts and averages cannot drift from what is stored.
export const FACTS_SQL = `SELECT count(*) AS tracked_days, min(day) AS first_day, max(day) AS last_day,
  count_if(completeness = 'complete') AS complete_days, count_if(completeness = 'partial') AS partial_days,
  count_if(completeness = 'missing') AS missing_days,
  round(avg(intake), 1) AS avg_intake_all_days, round(avg(burn_effective), 1) AS avg_burn_all_days,
  round(avg(intake - burn_effective), 1) AS avg_net_all_days,
  round(avg(CASE WHEN net_reliable THEN intake - burn_effective END), 1) AS avg_net_complete_days,
  count_if(net_reliable) AS days_in_complete_average
FROM (SELECT d.day, d.completeness, d.net_reliable, d.burn_effective, COALESCE(SUM(e.calories), 0) AS intake
  FROM diet_days d LEFT JOIN diet_entries e ON e.day = d.day AND NOT e.superseded
  GROUP BY d.day, d.completeness, d.net_reliable, d.burn_effective)`;

/** Turns the one result row into text for the model. Returns an explanation instead of guessing when the query failed. */
export function formatFacts(result: QueryResult): string {
  const header = "Verified diet figures (computed by the database just now; quote these exactly for totals and averages):";
  if (!result.ok || result.rows.length === 0) return `${header}\n(unavailable: ${result.error ?? "no rows"})`;
  const row = Object.fromEntries(result.columns.map((c, i) => [c, result.rows[0]?.[i] ?? null]));
  return [
    header,
    `- Tracked days: ${row.tracked_days} (from ${row.first_day} to ${row.last_day})`,
    `- Complete: ${row.complete_days}; partial: ${row.partial_days}; missing: ${row.missing_days}`,
    `- Average intake, all tracked days: ${row.avg_intake_all_days} kcal; average burn: ${row.avg_burn_all_days} kcal`,
    `- Average net, all tracked days: ${row.avg_net_all_days} kcal`,
    `- Average net, complete days only (${row.days_in_complete_average} days): ${row.avg_net_complete_days} kcal`,
  ].join("\n");
}
