import { runDietImport, type DietBuckets } from "./diet-pipeline.js";
import { s3ObjectStore } from "./object-store.js";

// Local run of the same diet import the weekly Lambda runs. Uses the default AWS credentials (AWS_PROFILE=click).
// Usage: npm run ingest:diet
const buckets: DietBuckets = {
  stuntmanBucket: "stuntman-diet-production-puddlebucket-xaioorfosdus",
  stuntmanExportPrefix: "exports/",
  dietBucket: "health-chat-diet-570989156105-us-east-1-an",
  tablesBucket: "health-chat-tables-570989156105-us-east-1-an",
};
const result = await runDietImport(s3ObjectStore(), buckets, "local", new Date());
console.info(JSON.stringify({ snapshot: result.stuntman_snapshot_export_time, rows: result.rows, active_days: result.active_days, first_day: result.first_day, last_day: result.last_day }, null, 2));
