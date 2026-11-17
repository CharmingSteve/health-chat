import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEcgCsv, parseExport, parseGpx, type AppleRecord, type AppleWorkout } from "./apple.js";
import { dedupeJsonlToParquet, jsonlToParquet } from "./parquet.js";
import { tableLocation } from "./schemas.js";

// Local ingest for Apple Health. Reads the newest export folder in the apple-health bucket,
// writes Parquet tables to the tables bucket under apple/.
// Usage: npx tsx src/ingest/run-apple.ts
const APPLE_BUCKET = "apple-health-570989156105-us-east-1-an";
const TABLES_BUCKET = "health-chat-tables-570989156105-us-east-1-an";
const OWNER = "owner";
const PROFILE = ["--profile", "click", "--region", "us-east-1"];

function awsJson(args: string[]): unknown {
  return JSON.parse(execFileSync("aws", [...args, ...PROFILE, "--output", "json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
}

function aws(args: string[]): void {
  execFileSync("aws", [...args, ...PROFILE, "--only-show-errors"], { stdio: "inherit" });
}

/** Folder names look like "November-16-2026". The newest by date is the export we ingest. */
export function latestFolder(names: string[]): string {
  const dated = names
    .map((name) => {
      const [month = "", day = "", year = ""] = name.split("-");
      return { name, date: new Date(`${month} ${day}, ${year}`) };
    })
    .filter((x) => !Number.isNaN(x.date.getTime()));
  dated.sort((a, b) => a.date.getTime() - b.date.getTime());
  const last = dated[dated.length - 1];
  if (!last) throw new Error("No dated export folder found");
  return last.name;
}

const work = mkdtempSync(join(tmpdir(), "apple-ingest-"));
try {
  // 1. Newest export folder.
  const top = awsJson(["s3api", "list-objects-v2", "--bucket", APPLE_BUCKET, "--delimiter", "/"]) as {
    CommonPrefixes?: { Prefix: string }[];
  };
  const folders = (top.CommonPrefixes ?? []).map((p) => p.Prefix.replace(/\/$/, ""));
  const folder = latestFolder(folders);
  const prefix = `${folder}/`;
  const exportObject = (awsJson(["s3api", "list-objects-v2", "--bucket", APPLE_BUCKET, "--prefix", `${prefix}export.xml`]) as {
    Contents?: { Key: string; ETag: string; Size: number }[];
  }).Contents?.[0];
  if (!exportObject) throw new Error(`No export.xml in ${folder}`);

  // 2. Stream export.xml from S3 through the parser; batch rows to JSON-lines files.
  const recordsPath = join(work, "records.jsonl");
  const workoutsPath = join(work, "workouts.jsonl");
  writeFileSync(recordsPath, "");
  writeFileSync(workoutsPath, "");
  let recordBuffer: string[] = [];
  let workoutBuffer: string[] = [];
  const flush = () => {
    if (recordBuffer.length) appendFileSync(recordsPath, recordBuffer.join("\n") + "\n");
    if (workoutBuffer.length) appendFileSync(workoutsPath, workoutBuffer.join("\n") + "\n");
    recordBuffer = [];
    workoutBuffer = [];
  };
  const parser = parseExport(OWNER, {
    record: (row: AppleRecord) => {
      recordBuffer.push(JSON.stringify(row));
      if (recordBuffer.length >= 50000) flush();
    },
    workout: (row: AppleWorkout) => {
      workoutBuffer.push(JSON.stringify(row));
    },
  });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("aws", ["s3", "cp", `s3://${APPLE_BUCKET}/${exportObject.Key}`, "-", ...PROFILE], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => parser.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`aws s3 cp exited ${code}`))));
  });
  const counts = parser.end();
  flush();

  // 3. GPX routes (one file per route, referenced by workouts through route_file).
  const routeObjects = (awsJson(["s3api", "list-objects-v2", "--bucket", APPLE_BUCKET, "--prefix", `${prefix}workout-routes/`]) as {
    Contents?: { Key: string }[];
  }).Contents ?? [];
  const routesPath = join(work, "routes.jsonl");
  writeFileSync(routesPath, "");
  for (const object of routeObjects.filter((o) => o.Key.endsWith(".gpx"))) {
    const local = join(work, "route.gpx");
    aws(["s3", "cp", `s3://${APPLE_BUCKET}/${object.Key}`, local]);
    const summary = parseGpx(OWNER, object.Key.replace(prefix, "workout-routes/"), readFileSync(local, "utf8"));
    appendFileSync(routesPath, JSON.stringify(summary) + "\n");
  }

  // 4. ECG recordings and their samples.
  const ecgObjects = (awsJson(["s3api", "list-objects-v2", "--bucket", APPLE_BUCKET, "--prefix", `${prefix}electrocardiograms/`]) as {
    Contents?: { Key: string }[];
  }).Contents ?? [];
  const ecgPath = join(work, "ecg.jsonl");
  const ecgSamplesPath = join(work, "ecg_samples.jsonl");
  writeFileSync(ecgPath, "");
  writeFileSync(ecgSamplesPath, "");
  for (const object of ecgObjects.filter((o) => o.Key.endsWith(".csv"))) {
    const local = join(work, "ecg.csv");
    aws(["s3", "cp", `s3://${APPLE_BUCKET}/${object.Key}`, local]);
    const file = object.Key.replace(prefix, "electrocardiograms/");
    const { recording, samples } = parseEcgCsv(OWNER, file, readFileSync(local, "utf8"));
    appendFileSync(ecgPath, JSON.stringify(recording) + "\n");
    appendFileSync(ecgSamplesPath, samples.map((microvolts, idx) => JSON.stringify({ owner: OWNER, file, idx, microvolts })).join("\n") + "\n");
  }

  // 5. Parquet tables with explicit schemas.
  const out = join(work, "out");
  execFileSync("mkdir", ["-p", out]);
  const tables: { name: string; jsonl: string; columns: Record<string, "VARCHAR" | "DOUBLE" | "BOOLEAN"> }[] = [
    { name: "apple_records", jsonl: recordsPath, columns: { owner: "VARCHAR", type: "VARCHAR", source_name: "VARCHAR", unit: "VARCHAR", creation_date: "VARCHAR", start_date: "VARCHAR", end_date: "VARCHAR", value_text: "VARCHAR", value_num: "DOUBLE" } },
    { name: "apple_workouts", jsonl: workoutsPath, columns: { owner: "VARCHAR", activity_type: "VARCHAR", source_name: "VARCHAR", start_date: "VARCHAR", end_date: "VARCHAR", creation_date: "VARCHAR", duration: "DOUBLE", duration_unit: "VARCHAR", total_distance: "DOUBLE", total_distance_unit: "VARCHAR", total_energy: "DOUBLE", total_energy_unit: "VARCHAR", route_file: "VARCHAR", statistics: "VARCHAR" } },
    { name: "apple_routes", jsonl: routesPath, columns: { owner: "VARCHAR", file: "VARCHAR", name: "VARCHAR", start_time: "VARCHAR", end_time: "VARCHAR", points: "DOUBLE", distance_m: "DOUBLE" } },
    { name: "apple_ecg_recordings", jsonl: ecgPath, columns: { owner: "VARCHAR", file: "VARCHAR", recorded_date: "VARCHAR", classification: "VARCHAR", device: "VARCHAR", sample_rate_hz: "DOUBLE", lead: "VARCHAR", unit: "VARCHAR", sample_count: "DOUBLE" } },
    { name: "apple_ecg_samples", jsonl: ecgSamplesPath, columns: { owner: "VARCHAR", file: "VARCHAR", idx: "DOUBLE", microvolts: "DOUBLE" } },
  ];
  const rowCounts: Record<string, number> = {};
  const duplicatesRemoved: Record<string, number> = {};
  for (const table of tables) {
    const local = join(out, `${table.name}.parquet`);
    if (table.name === "apple_records") {
      // Same sample from two sources (iPhone and Watch) has the same type, times, value, and unit: keep one.
      const result = await dedupeJsonlToParquet(table.jsonl, table.columns, ["type", "start_date", "end_date", "value_text", "unit"], local);
      rowCounts[table.name] = result.kept;
      duplicatesRemoved[table.name] = result.removed;
    } else {
      rowCounts[table.name] = await jsonlToParquet(table.jsonl, table.columns, local);
    }
    aws(["s3", "cp", local, `s3://${TABLES_BUCKET}/${tableLocation(table.name)}data.parquet`, "--sse", "AES256"]);
  }

  // 6. Ledger: exactly what was read, and what was written.
  const ledger = join(out, "ledger.json");
  writeFileSync(ledger, JSON.stringify({
    table: "apple",
    run_at: new Date().toISOString(),
    source: { bucket: APPLE_BUCKET, export_folder: folder, export_key: exportObject.Key, export_etag: exportObject.ETag, export_bytes: exportObject.Size },
    xml_counts: counts,
    routes_read: routeObjects.filter((o) => o.Key.endsWith(".gpx")).length,
    ecg_files_read: ecgObjects.filter((o) => o.Key.endsWith(".csv")).length,
    rows: rowCounts,
    duplicates_removed: duplicatesRemoved,
    dedupe_rule: "apple_records: rows with the same type, start_date, end_date, value_text, and unit are kept once. Overlapping samples with different times are not merged.",
  }, null, 2));
  aws(["s3", "cp", ledger, `s3://${TABLES_BUCKET}/ledger/apple.json`, "--sse", "AES256"]);

  // 7. Summary by activity type, so every workout type is visible.
  const byActivity = new Map<string, number>();
  for (const line of readFileSync(workoutsPath, "utf8").split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as AppleWorkout;
    byActivity.set(row.activity_type, (byActivity.get(row.activity_type) ?? 0) + 1);
  }
  console.info(JSON.stringify({ export_folder: folder, rows: rowCounts, duplicates_removed: duplicatesRemoved, workouts_by_type: Object.fromEntries([...byActivity.entries()].sort((a, b) => b[1] - a[1])) }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
