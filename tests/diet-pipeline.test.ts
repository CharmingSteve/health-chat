import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { readParquet } from "../src/ingest/parquet.js";
import { runDietImport, recordFailure, type DietBuckets, type ObjectStore } from "../src/ingest/diet-pipeline.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const B: DietBuckets = { stuntmanBucket: "puddle", stuntmanExportPrefix: "exports/", dietBucket: "diet", tablesBucket: "tables" };
const NOW = new Date("2026-11-22T04:00:00.000Z");

function memoryStore(initial: Record<string, Record<string, Buffer>>, failGetOf?: string) {
  const data: Record<string, Record<string, Buffer>> = structuredClone(initial);
  for (const b of Object.keys(data)) for (const k of Object.keys(data[b]!)) data[b]![k] = Buffer.from(data[b]![k]!);
  const store: ObjectStore = {
    async list(bucket, prefix) {
      return Object.keys(data[bucket] ?? {}).filter((k) => k.startsWith(prefix)).sort().map((Key) => ({ Key, ETag: `"etag-${Key.length}"` }));
    },
    async get(bucket, key) {
      if (failGetOf && key.includes(failGetOf)) throw new Error("boom");
      const v = data[bucket]?.[key];
      if (!v) throw new Error(`missing ${bucket}/${key}`);
      return v;
    },
    async put(bucket, key, body) {
      data[bucket] ??= {};
      data[bucket]![key] = Buffer.isBuffer(body) ? body : Buffer.from(body);
    },
  };
  return { store, data };
}

const entryLine = (day: string, calories: number, raw: string, occurred: string) => JSON.stringify({
  Item: {
    PK: { S: "USER#x" }, SK: { S: `DAY#${day}#ENTRY#${calories}-${occurred}` }, entity: { S: "entry" }, version: { N: "1" },
    data: { M: { day_key: { S: day }, calories: { N: String(calories) }, display_name: { S: raw }, raw_text: { S: raw }, occurred_at: { S: occurred }, quantity: { N: "1" }, unit: { S: "portion" }, food_id: { NULL: true }, superseded_by: { NULL: true } } },
  },
});

const snapshotLines = [
  // Seven identical drink entries on 2025-01-05: excluded by the named rule.
  ...Array.from({ length: 7 }, () => entryLine("2025-01-05", 200, "protein drink 200 calories", "2025-01-05T12:00:00+02:00")),
  entryLine("2026-11-20", 500, "lunch", "2026-11-20T13:00:00+02:00"),
].join("\n");

function fixture(): Record<string, Record<string, Buffer>> {
  return {
    puddle: {
      "exports/refresh-1/AWSDynamoDB/abc/manifest-summary.json": Buffer.from(JSON.stringify({ exportTime: "2026-11-22T01:00:00.000Z" })),
      "exports/refresh-1/AWSDynamoDB/abc/manifest-files.json": Buffer.from("[]"),
      "exports/refresh-1/AWSDynamoDB/abc/data/x.json.gz": gzipSync(snapshotLines),
      "exports/refresh-0/AWSDynamoDB/old/manifest-summary.json": Buffer.from(JSON.stringify({ exportTime: "2026-11-15T01:00:00.000Z" })),
    },
    diet: {
      "legacy-master/2025-2026/MASTER.csv": Buffer.from("Date,Quantity,Food_Item,Calories\n01/05/2025,,Heaping tsp cream cheese,31\n02/05/2025,,Protein bar,211\n"),
    },
  };
}

describe("runDietImport", () => {
  it("uses the newest snapshot, applies the named exclusion, writes tables and a ledger", async () => {
    const { store, data } = memoryStore(fixture());
    const result = await runDietImport(store, B, "schedule", NOW);
    expect(result.stuntman_snapshot_export_time).toBe("2026-11-22T01:00:00.000Z");
    expect(result.rows.excluded_by_rule).toEqual({ "dup-protein-drink-2025-01-05": 7 });
    expect(result.rows.diet_entries).toBe(1 + 2); // one stuntman lunch + two legacy rows; the seven duplicates are excluded
    expect(result.first_day).toBe("2025-05-01");
    expect(result.last_day).toBe("2026-11-20");
    expect(Object.keys(data.tables!)).toEqual(expect.arrayContaining(["warehouse/diet_entries/data.parquet", "warehouse/diet_days/data.parquet", "ledger/diet.json", "ledger/diet-status.json"]));
    expect(data.diet!["stuntman-production/exports/refresh-1/AWSDynamoDB/abc/data/x.json.gz"]).toBeDefined();
    expect(data.diet!["stuntman-production/exports/refresh-0/AWSDynamoDB/old/manifest-summary.json"]).toBeUndefined();
  });

  it("writes Parquet that reads back with the expected entries", async () => {
    const { store, data } = memoryStore(fixture());
    await runDietImport(store, B, "manual", NOW);
    const dir = mkdtempSync(join(tmpdir(), "pipe-test-"));
    const file = join(dir, "e.parquet");
    writeFileSync(file, data.tables!["warehouse/diet_entries/data.parquet"]!);
    const rows = await readParquet(file);
    expect(rows.map((r) => r.calories).sort((a, b) => Number(a) - Number(b))).toEqual([31, 211, 500]);
  });

  it("is repeatable: a second run gives the same counts", async () => {
    const { store } = memoryStore(fixture());
    const first = await runDietImport(store, B, "schedule", NOW);
    const second = await runDietImport(store, B, "schedule", NOW);
    expect(second.rows).toEqual(first.rows);
    expect(second.active_days).toBe(first.active_days);
  });

  it("writes nothing to the tables or the ledger when a read fails", async () => {
    const { store, data } = memoryStore(fixture(), "data/x.json.gz");
    await expect(runDietImport(store, B, "schedule", NOW)).rejects.toThrow("boom");
    expect(data.tables).toBeUndefined();
  });

  it("records a failed attempt without touching the last good ledger", async () => {
    const { store, data } = memoryStore(fixture());
    await runDietImport(store, B, "schedule", NOW);
    const goodLedger = data.tables!["ledger/diet.json"]!.toString();
    await recordFailure(store, B, "manual", new Date("2026-11-23T00:00:00.000Z"), "AccessDenied");
    expect(data.tables!["ledger/diet.json"]!.toString()).toBe(goodLedger);
    expect(JSON.parse(data.tables!["ledger/diet-status.json"]!.toString())).toMatchObject({ status: "failed", error: "AccessDenied", trigger: "manual" });
  });
});
