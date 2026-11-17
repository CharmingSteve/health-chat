import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyExclusions, parseLegacyCsv, parseSnapshotLines, type DietDay, type DietEntry } from "./diet.js";
import { writeParquet } from "./parquet.js";
import { tableLocation } from "./schemas.js";

// Local ingest for diet data. Reads the copies in the diet bucket, writes Parquet tables to the tables bucket.
// Usage: AWS_PROFILE=click AWS_REGION=us-east-1 npx tsx src/ingest/run-diet.ts
const DIET_BUCKET = "health-chat-diet-570989156105-us-east-1-an";
const TABLES_BUCKET = "health-chat-tables-570989156105-us-east-1-an";
const OWNER = "owner";

function aws(args: string[]): string {
  return execFileSync("aws", [...args, "--profile", "click", "--region", "us-east-1", "--output", "json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function listKeys(prefix: string): { Key: string; ETag: string }[] {
  const out = JSON.parse(aws(["s3api", "list-objects-v2", "--bucket", DIET_BUCKET, "--prefix", prefix])) as {
    Contents?: { Key: string; ETag: string }[];
  };
  return out.Contents ?? [];
}

function download(key: string, dest: string): void {
  execFileSync("aws", ["s3", "cp", `s3://${DIET_BUCKET}/${key}`, dest, "--profile", "click", "--region", "us-east-1", "--only-show-errors"]);
}

function upload(local: string, key: string): void {
  execFileSync("aws", ["s3", "cp", local, `s3://${TABLES_BUCKET}/${key}`, "--sse", "AES256", "--profile", "click", "--region", "us-east-1", "--only-show-errors"]);
}

const work = mkdtempSync(join(tmpdir(), "diet-ingest-"));
try {
  // 1. Newest stuntman snapshot: the manifest with the latest exportTime.
  const manifests = listKeys("stuntman-production/exports/").filter((o) => o.Key.endsWith("manifest-summary.json"));
  if (manifests.length === 0) throw new Error("No stuntman export manifests found");
  const snapshots = manifests.map((m) => {
    const local = join(work, `manifest-${manifests.indexOf(m)}.json`);
    download(m.Key, local);
    const exportTime = (JSON.parse(readFileSync(local, "utf8")) as { exportTime?: string }).exportTime ?? "";
    return { dir: m.Key.replace(/manifest-summary\.json$/, ""), exportTime };
  });
  snapshots.sort((a, b) => (a.exportTime < b.exportTime ? -1 : 1));
  const latest = snapshots[snapshots.length - 1];
  if (!latest) throw new Error("No snapshot");

  // 2. Data files of that snapshot only (never mix snapshots).
  const dataKeys = listKeys(`${latest.dir}data/`).filter((o) => o.Key.endsWith(".json.gz"));
  const lines: string[] = [];
  const sourceKeys: { key: string; etag: string }[] = [];
  for (const object of dataKeys) {
    const local = join(work, `data-${sourceKeys.length}.json.gz`);
    download(object.Key, local);
    lines.push(...execFileSync("gunzip", ["-c", local], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\n"));
    sourceKeys.push({ key: object.Key, etag: object.ETag });
  }
  const stuntman = parseSnapshotLines(lines, OWNER);

  // 3. Legacy master CSV (the one kept: top-level Weekdays_Only file).
  const legacyObjects = listKeys("legacy-master/");
  const legacyEntries: DietEntry[] = [];
  for (const object of legacyObjects) {
    const local = join(work, `legacy-${legacyEntries.length}.csv`);
    download(object.Key, local);
    legacyEntries.push(...parseLegacyCsv(readFileSync(local, "utf8"), OWNER));
    sourceKeys.push({ key: object.Key, etag: object.ETag });
  }

  const combined = [...stuntman.entries, ...legacyEntries];
  const { kept: entries, excluded } = applyExclusions(combined);
  const days: DietDay[] = stuntman.days;

  // 4. Parquet tables.
  const outDir = mkdtempSync(join(work, "out-"));
  mkdirSync(outDir, { recursive: true });
  const entriesPath = join(outDir, "diet_entries.parquet");
  const daysPath = join(outDir, "diet_days.parquet");
  const entryCount = await writeParquet(entries, {
    source: "VARCHAR", owner: "VARCHAR", day: "VARCHAR", occurred_at: "VARCHAR", display_name: "VARCHAR",
    raw_text: "VARCHAR", calories: "DOUBLE", quantity: "DOUBLE", unit: "VARCHAR", food_id: "VARCHAR", superseded: "BOOLEAN",
  }, entriesPath);
  const dayCount = await writeParquet(days, {
    owner: "VARCHAR", day: "VARCHAR", burn_total: "DOUBLE", completeness: "VARCHAR", eligibility: "VARCHAR", burn_source: "VARCHAR",
  }, daysPath);

  // 5. Upload and write a ledger of exactly what was read.
  upload(entriesPath, `${tableLocation("diet_entries")}data.parquet`);
  upload(daysPath, `${tableLocation("diet_days")}data.parquet`);
  const ledgerPath = join(outDir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify({
    table: "diet",
    run_at: new Date().toISOString(),
    stuntman_snapshot_export_time: latest.exportTime,
    stuntman_snapshot_prefix: latest.dir,
    sources: sourceKeys,
    rows: { diet_entries: entryCount, diet_days: dayCount, skipped_stuntman_items: stuntman.skipped, excluded_by_rule: excluded },
  }, null, 2));
  upload(ledgerPath, "ledger/diet.json");

  const active = entries.filter((e) => !e.superseded);
  const activeDays = [...new Set(active.map((e) => e.day))].sort();
  console.info(JSON.stringify({
    stuntman_snapshot: latest.exportTime,
    entries_total: entries.length,
    entries_active: active.length,
    entries_superseded: entries.length - active.length,
    legacy_entries: legacyEntries.length,
    days_with_entries: activeDays.length,
    first_day: activeDays[0],
    last_day: activeDays[activeDays.length - 1],
    days_metadata: days.length,
  }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
