import { gunzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExclusions, buildDietDays, parseLegacyCsv, parseSnapshotLines, type DietDay, type DietEntry } from "./diet.js";
import { writeParquet } from "./parquet.js";
import { tableLocation } from "./schemas.js";

// The diet import, used by the weekly Lambda, the refresh button, and the local npm script.
// Storage is injected, so the same steps run against S3 in production and against memory in tests.

export const OWNER = "owner";
export const DIET_PREFIX_EXPORTS = "stuntman-production/exports/";
export const DIET_LEGACY_PREFIX = "legacy-master/";

export interface ObjectStore {
  list(bucket: string, prefix: string): Promise<{ Key: string; ETag: string }[]>;
  get(bucket: string, key: string): Promise<Buffer>;
  put(bucket: string, key: string, body: Buffer | string): Promise<void>;
}

export interface DietBuckets {
  /** Where stuntman-diet exports are read from when a copy is not yet in the diet bucket. */
  stuntmanBucket: string;
  stuntmanExportPrefix: string; // e.g. "exports/"
  dietBucket: string;
  tablesBucket: string;
}

export interface DietRunResult {
  status: "ok";
  trigger: string;
  run_at: string;
  stuntman_snapshot_export_time: string;
  stuntman_snapshot_prefix: string;
  sources: { key: string; etag: string }[];
  rows: { diet_entries: number; diet_days: number; skipped_stuntman_items: number; excluded_by_rule: Record<string, number> };
  active_days: number;
  first_day: string | null;
  last_day: string | null;
}

/** Newest stuntman snapshot by its manifest's exportTime. */
export async function newestSnapshot(store: ObjectStore, b: DietBuckets): Promise<{ dir: string; exportTime: string }> {
  const manifests = (await store.list(b.stuntmanBucket, b.stuntmanExportPrefix)).filter((o) => o.Key.endsWith("manifest-summary.json"));
  if (manifests.length === 0) throw new Error("No stuntman export manifests found");
  const snapshots = await Promise.all(manifests.map(async (m) => {
    const body = JSON.parse((await store.get(b.stuntmanBucket, m.Key)).toString("utf8")) as { exportTime?: string };
    return { dir: m.Key.replace(/manifest-summary\.json$/, ""), exportTime: body.exportTime ?? "" };
  }));
  snapshots.sort((a, b2) => (a.exportTime < b2.exportTime ? -1 : 1));
  const latest = snapshots[snapshots.length - 1];
  if (!latest) throw new Error("No snapshot");
  return latest;
}

/**
 * Runs the whole import. Copies the newest snapshot into the diet bucket (kept there; stuntman's own copies expire),
 * rebuilds the tables from the diet bucket, and returns the ledger entry. Nothing is written until every read succeeded.
 */
export async function runDietImport(store: ObjectStore, b: DietBuckets, trigger: string, now: Date): Promise<DietRunResult> {
  const snapshot = await newestSnapshot(store, b);
  const work = mkdtempSync(join(tmpdir(), "diet-pipeline-"));
  try {
    // 1. Copy the snapshot's files into the diet bucket.
    const sourceObjects = (await store.list(b.stuntmanBucket, snapshot.dir)).filter((o) => o.Key.endsWith(".json.gz") || o.Key.endsWith("manifest-summary.json") || o.Key.endsWith("manifest-files.json"));
    const sources: { key: string; etag: string }[] = [];
    const lines: string[] = [];
    for (const object of sourceObjects) {
      const bytes = await store.get(b.stuntmanBucket, object.Key);
      const copyKey = `stuntman-production/${object.Key}`;
      await store.put(b.dietBucket, copyKey, bytes);
      sources.push({ key: copyKey, etag: object.ETag });
      if (object.Key.endsWith(".json.gz")) lines.push(...gunzipSync(bytes).toString("utf8").split("\n"));
    }

    // 2. Legacy master CSV (the only one kept).
    const legacyObjects = await store.list(b.dietBucket, DIET_LEGACY_PREFIX);
    const legacyEntries: DietEntry[] = [];
    for (const object of legacyObjects) {
      legacyEntries.push(...parseLegacyCsv((await store.get(b.dietBucket, object.Key)).toString("utf8"), OWNER));
      sources.push({ key: object.Key, etag: object.ETag });
    }

    // 3. Parse, apply the named exclusions, and write the tables.
    const stuntman = parseSnapshotLines(lines, OWNER);
    const { kept: entries, excluded } = applyExclusions([...stuntman.entries, ...legacyEntries]);
    const days: DietDay[] = buildDietDays(entries, stuntman.days, OWNER);
    const entriesPath = join(work, "diet_entries.parquet");
    const daysPath = join(work, "diet_days.parquet");
    const entryCount = await writeParquet(entries, {
      source: "VARCHAR", owner: "VARCHAR", day: "VARCHAR", occurred_at: "VARCHAR", display_name: "VARCHAR",
      raw_text: "VARCHAR", calories: "DOUBLE", quantity: "DOUBLE", unit: "VARCHAR", food_id: "VARCHAR", superseded: "BOOLEAN",
    }, entriesPath);
    const dayCount = await writeParquet(days, {
      owner: "VARCHAR", day: "VARCHAR", burn_total: "DOUBLE", burn_effective: "DOUBLE", burn_basis: "VARCHAR", completeness: "VARCHAR", eligibility: "VARCHAR", burn_source: "VARCHAR",
    }, daysPath);
    await store.put(b.tablesBucket, `${tableLocation("diet_entries")}data.parquet`, readFileSync(entriesPath));
    await store.put(b.tablesBucket, `${tableLocation("diet_days")}data.parquet`, readFileSync(daysPath));

    const activeDays = [...new Set(entries.filter((e) => !e.superseded).map((e) => e.day))].sort();
    const result: DietRunResult = {
      status: "ok",
      trigger,
      run_at: now.toISOString(),
      stuntman_snapshot_export_time: snapshot.exportTime,
      stuntman_snapshot_prefix: snapshot.dir,
      sources,
      rows: { diet_entries: entryCount, diet_days: dayCount, skipped_stuntman_items: stuntman.skipped, excluded_by_rule: excluded },
      active_days: activeDays.length,
      first_day: activeDays[0] ?? null,
      last_day: activeDays[activeDays.length - 1] ?? null,
    };
    // 4. Ledger of the last successful run, then the attempt status the page reads.
    await store.put(b.tablesBucket, "ledger/diet.json", JSON.stringify(result, null, 2));
    await store.put(b.tablesBucket, "ledger/diet-status.json", JSON.stringify({ last_attempt_at: result.run_at, trigger, status: "ok" }, null, 2));
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Records a failed attempt, so the page can say the last run failed and when. The last good ledger stays as it was. */
export async function recordFailure(store: ObjectStore, b: DietBuckets, trigger: string, now: Date, error: string): Promise<void> {
  await store.put(b.tablesBucket, "ledger/diet-status.json", JSON.stringify({ last_attempt_at: now.toISOString(), trigger, status: "failed", error }, null, 2));
}
