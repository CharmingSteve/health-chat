import { recordFailure, runDietImport, type DietBuckets } from "./ingest/diet-pipeline.js";
import { s3ObjectStore } from "./ingest/object-store.js";

// Lambda entry point for the weekly diet import (EventBridge Scheduler, Sunday 06:00 Asia/Jerusalem) and for the
// "Refresh diet now" button (invoked asynchronously by the app). The event says which: { "trigger": "schedule" | "manual" }.
const buckets: DietBuckets = {
  stuntmanBucket: process.env.STUNTMAN_BUCKET ?? "",
  stuntmanExportPrefix: "exports/",
  dietBucket: process.env.DIET_BUCKET ?? "",
  tablesBucket: process.env.TABLES_BUCKET ?? "",
};

export async function handler(event: { trigger?: string } = {}): Promise<{ status: string }> {
  const trigger = event.trigger === "manual" ? "manual" : "schedule";
  const store = s3ObjectStore();
  for (const [name, value] of Object.entries(buckets)) {
    if (!value) throw new Error(`${name} is not configured`);
  }
  try {
    const result = await runDietImport(store, buckets, trigger, new Date());
    console.info(JSON.stringify({ status: "ok", trigger, active_days: result.active_days, entries: result.rows.diet_entries }));
    return { status: "ok" };
  } catch (error) {
    const message = error instanceof Error ? error.name : "unknown";
    await recordFailure(store, buckets, trigger, new Date(), message).catch(() => undefined);
    console.error(JSON.stringify({ status: "failed", trigger, error: message }));
    throw error;
  }
}
