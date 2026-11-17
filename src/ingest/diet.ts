// Diet sources: stuntman-diet DynamoDB exports (DynamoDB JSON) and the legacy master CSV.
// Output rows are plain objects; Parquet writing is in parquet.ts.

export interface DietEntry {
  source: "stuntman" | "legacy";
  owner: string;
  day: string; // yyyy-mm-dd
  occurred_at: string | null;
  display_name: string | null;
  raw_text: string | null;
  calories: number;
  quantity: number | null;
  unit: string | null;
  food_id: string | null;
  superseded: boolean;
}

export interface DietDay {
  owner: string;
  day: string;
  /** The burn the app recorded for the day, or null when none was recorded. */
  burn_total: number | null;
  /** The burn used for net calories: the recorded burn, or DEFAULT_BURN when none was recorded. */
  burn_effective: number;
  /** "recorded" when the owner's burn was written; "assumed_default" when DEFAULT_BURN is assumed. */
  burn_basis: "recorded" | "assumed_default";
  completeness: string | null;
  eligibility: string | null;
  burn_source: string | null;
}

/** Day metadata as the app wrote it; buildDietDays adds the effective burn. */
export type DietMeta = Omit<DietDay, "burn_effective" | "burn_basis">;

/**
 * The owner's rule: a day burns DEFAULT_BURN kilocalories unless a burn is recorded. Recorded burns are written only
 * when they are above the default (exercise), so a day without one is an assumed default, not a missing value.
 */
export const DEFAULT_BURN = 2000;

/**
 * One row for every day that has a food or burn entry, and for every day the app has metadata for.
 * Days with no entries at all are not included: they were not tracked, so no burn is assumed for them.
 */
export function buildDietDays(entries: DietEntry[], metaDays: DietMeta[], owner: string): DietDay[] {
  const meta = new Map(metaDays.map((d) => [d.day, d]));
  const tracked = new Set(entries.filter((e) => !e.superseded).map((e) => e.day));
  for (const day of meta.keys()) tracked.add(day);
  return [...tracked].sort().map((day) => {
    const m = meta.get(day);
    // A burn is written only when it is above the default (exercise). A stored burn equal to the default is the default.
    const recorded = m !== undefined && m.burn_source === "recorded" && m.burn_total !== null && m.burn_total > DEFAULT_BURN;
    return {
      owner,
      day,
      burn_total: m?.burn_total ?? null,
      burn_effective: recorded ? (m!.burn_total as number) : DEFAULT_BURN,
      burn_basis: recorded ? "recorded" : "assumed_default",
      completeness: m?.completeness ?? null,
      eligibility: m?.eligibility ?? null,
      burn_source: m?.burn_source ?? null,
    };
  });
}

/** Converts one DynamoDB attribute value ({S:..}, {N:..}, {M:..}, ...) into a plain JS value. */
export function unmarshal(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const av = value as Record<string, unknown>;
  if ("S" in av) return av.S;
  if ("N" in av) return Number(av.N);
  if ("BOOL" in av) return av.BOOL;
  if ("NULL" in av) return null;
  if ("L" in av) return (av.L as unknown[]).map(unmarshal);
  if ("M" in av) {
    return Object.fromEntries(Object.entries(av.M as Record<string, unknown>).map(([k, v]) => [k, unmarshal(v)]));
  }
  throw new Error(`Unsupported DynamoDB attribute: ${Object.keys(av).join(",")}`);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function asDay(value: unknown, context: string): string {
  if (typeof value !== "string" || !DAY.test(value)) throw new Error(`Bad day in ${context}`);
  return value;
}

function optString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Parses the JSON lines of one or more DynamoDB export data files.
 * Only "entry" (food and burn logs) and "day" (day metadata) items are kept; others are counted, not stored.
 */
export function parseSnapshotLines(lines: Iterable<string>, owner: string): { entries: DietEntry[]; days: DietMeta[]; skipped: number } {
  const entries: DietEntry[] = [];
  const days: DietMeta[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const raw = (JSON.parse(line) as { Item: Record<string, unknown> }).Item;
    // The export's Item is a map of attributes, so each top-level value is unmarshalled separately.
    const item = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, unmarshal(value)])) as Record<string, unknown>;
    const entity = item.entity;
    const data = (item.data ?? {}) as Record<string, unknown>;
    if (entity === "entry") {
      const day = asDay(data.day_key, "entry");
      const calories = optNumber(data.calories);
      if (calories === null) throw new Error(`Entry without calories on ${day}`);
      entries.push({
        source: "stuntman",
        owner,
        day,
        occurred_at: optString(data.occurred_at),
        display_name: optString(data.display_name),
        raw_text: optString(data.raw_text),
        calories,
        quantity: optNumber(data.quantity),
        unit: optString(data.unit),
        food_id: optString(data.food_id),
        superseded: data.superseded_by !== null && data.superseded_by !== undefined,
      });
    } else if (entity === "day") {
      days.push({
        owner,
        day: asDay(data.day_key, "day"),
        burn_total: optNumber(data.burn_total),
        completeness: optString(data.completeness),
        eligibility: optString(data.eligibility),
        burn_source: optString(data.burn_source),
      });
    } else {
      skipped += 1;
    }
  }
  return { entries, days, skipped };
}

/** Splits one CSV line, honouring double-quoted fields (with "" as an escaped quote). */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * The legacy master files write dates day-first (dd/mm/yyyy). Checked against the other master
 * (ISO dates): 01/05/2025 is 2025-05-01. Impossible dates throw instead of being guessed.
 */
export function parseDayFirst(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) throw new Error(`Not a dd/mm/yyyy date: ${value}`);
  const [, dd, mm, yyyy] = match;
  const iso = `${yyyy}-${mm}-${dd}`;
  const check = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Impossible date: ${value}`);
  }
  return iso;
}

/** Parses the legacy master CSV (Date,Quantity,Food_Item,Calories). */
export function parseLegacyCsv(text: string, owner: string): DietEntry[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = splitCsvLine(lines[0] ?? "").map((h) => h.trim());
  const expected = ["Date", "Quantity", "Food_Item", "Calories"];
  if (header.join("|") !== expected.join("|")) throw new Error(`Unexpected legacy header: ${header.join(",")}`);
  return lines.slice(1).map((line, index) => {
    const [date = "", quantity = "", food = "", calories = ""] = splitCsvLine(line);
    const kcal = Number(calories);
    if (calories.trim() === "" || !Number.isFinite(kcal) || kcal < 0) {
      throw new Error(`Bad calories on legacy row ${index + 2}`);
    }
    const qty = quantity.trim() === "" ? null : Number(quantity);
    return {
      source: "legacy" as const,
      owner,
      day: parseDayFirst(date),
      occurred_at: null,
      display_name: food.trim() || null,
      raw_text: null,
      calories: kcal,
      quantity: qty !== null && Number.isFinite(qty) ? qty : null,
      unit: null,
      food_id: null,
      superseded: false,
    };
  });
}

export interface ExclusionRule {
  id: string;
  reason: string;
  matches: (entry: DietEntry) => boolean;
}

/**
 * Named exclusions. Each rule is listed with its reason and counted in the ledger, so nothing is dropped silently.
 * The 2025-01-05 rule: seven identical "protein drink 200 calories" stuntman entries at the same timestamp,
 * confirmed by the owner as not real intake.
 */
export const DIET_EXCLUSIONS: ExclusionRule[] = [
  {
    id: "dup-protein-drink-2025-01-05",
    reason: "Seven identical stuntman entries 'protein drink 200 calories' at 2025-01-05T12:00 +02:00; owner confirmed not real intake",
    matches: (e) =>
      e.source === "stuntman" && e.day === "2025-01-05" && e.raw_text === "protein drink 200 calories" &&
      e.occurred_at === "2025-01-05T12:00:00+02:00",
  },
];

export function applyExclusions(entries: DietEntry[], rules: ExclusionRule[] = DIET_EXCLUSIONS): {
  kept: DietEntry[];
  excluded: Record<string, number>;
} {
  const excluded: Record<string, number> = {};
  const kept = entries.filter((entry) => {
    const rule = rules.find((r) => r.matches(entry));
    if (!rule) return true;
    excluded[rule.id] = (excluded[rule.id] ?? 0) + 1;
    return false;
  });
  return { kept, excluded };
}
