// The one list of derived tables: name, Parquet columns, and where they sit in the tables bucket.
// The Glue tables in infra/data.yaml are generated from this list (scripts/gen-data-template.ts),
// and a test checks that the committed template matches it.

export type ColumnType = "VARCHAR" | "DOUBLE" | "BOOLEAN";

export interface TableSchema {
  name: string;
  description: string;
  columns: Record<string, ColumnType>;
}

export const TABLES: TableSchema[] = [
  {
    name: "diet_entries",
    description: "Food and burn entries from stuntman-diet (source=stuntman) and the legacy master CSV (source=legacy). Superseded entries are kept and marked. One row per entry.",
    columns: { source: "VARCHAR", owner: "VARCHAR", day: "VARCHAR", occurred_at: "VARCHAR", display_name: "VARCHAR", raw_text: "VARCHAR", calories: "DOUBLE", quantity: "DOUBLE", unit: "VARCHAR", food_id: "VARCHAR", superseded: "BOOLEAN" },
  },
  {
    name: "diet_days",
    description: "Day metadata from stuntman-diet: burn total, completeness, eligibility. Only days the app has tracked appear here.",
    columns: { owner: "VARCHAR", day: "VARCHAR", burn_total: "DOUBLE", completeness: "VARCHAR", eligibility: "VARCHAR", burn_source: "VARCHAR" },
  },
  {
    name: "apple_records",
    description: "Every Apple Health Record from export.xml, all types and all sources. Not de-duplicated: sums across sources can double count. value_num is set only for numeric values.",
    columns: { owner: "VARCHAR", type: "VARCHAR", source_name: "VARCHAR", unit: "VARCHAR", creation_date: "VARCHAR", start_date: "VARCHAR", end_date: "VARCHAR", value_text: "VARCHAR", value_num: "DOUBLE" },
  },
  {
    name: "apple_workouts",
    description: "Every Apple Health Workout, all activity types (walking, skating, CrossFit, and others). statistics is a JSON array. route_file links to apple_routes.file.",
    columns: { owner: "VARCHAR", activity_type: "VARCHAR", source_name: "VARCHAR", start_date: "VARCHAR", end_date: "VARCHAR", creation_date: "VARCHAR", duration: "DOUBLE", duration_unit: "VARCHAR", total_distance: "DOUBLE", total_distance_unit: "VARCHAR", total_energy: "DOUBLE", total_energy_unit: "VARCHAR", route_file: "VARCHAR", statistics: "VARCHAR" },
  },
  {
    name: "apple_routes",
    description: "GPX route tracks linked to workouts. distance_m is summed between points (approximate).",
    columns: { owner: "VARCHAR", file: "VARCHAR", name: "VARCHAR", start_time: "VARCHAR", end_time: "VARCHAR", points: "DOUBLE", distance_m: "DOUBLE" },
  },
  {
    name: "apple_ecg_recordings",
    description: "One row per ECG recording from Apple Health, with the watch classification. The patient name and date of birth are not stored.",
    columns: { owner: "VARCHAR", file: "VARCHAR", recorded_date: "VARCHAR", classification: "VARCHAR", device: "VARCHAR", sample_rate_hz: "DOUBLE", lead: "VARCHAR", unit: "VARCHAR", sample_count: "DOUBLE" },
  },
  {
    name: "apple_ecg_samples",
    description: "Microvolt samples of each ECG recording, in order (idx).",
    columns: { owner: "VARCHAR", file: "VARCHAR", idx: "DOUBLE", microvolts: "DOUBLE" },
  },
  {
    name: "lab_results",
    description: "Clalit lab results, one row per result. test_name is normalized (see NAME_MAP); known_name=false means the raw name is kept as-is. flag is low, high, or in_range against the lab's own reference range; null when either is missing. sample_flag rows mark LIPEMIC, ICTERIC, or HEMOLYTIC samples.",
    columns: { owner: "VARCHAR", test_date: "VARCHAR", test_name_raw: "VARCHAR", test_name: "VARCHAR", known_name: "BOOLEAN", unit: "VARCHAR", value_text: "VARCHAR", value_num: "DOUBLE", ref_low: "DOUBLE", ref_high: "DOUBLE", flag: "VARCHAR", sample_flag: "VARCHAR", source_file: "VARCHAR" },
  },
  {
    name: "medical_documents",
    description: "Text of each medical PDF (has_text=false means a scanned file with no text layer yet). Use search on text to find a document.",
    columns: { owner: "VARCHAR", source_key: "VARCHAR", folder: "VARCHAR", kind: "VARCHAR", pages: "DOUBLE", has_text: "BOOLEAN", text_chars: "DOUBLE", text: "VARCHAR", bytes: "DOUBLE", etag: "VARCHAR" },
  },
  {
    name: "medical_files",
    description: "Image and DICOM-candidate files in the medical bucket, indexed by name, size, and date only. Their contents are not read yet.",
    columns: { owner: "VARCHAR", source_key: "VARCHAR", folder: "VARCHAR", kind: "VARCHAR", bytes: "DOUBLE", last_modified: "VARCHAR", etag: "VARCHAR" },
  },
];

/** Location of a table's Parquet file in the tables bucket. One folder per table, so Glue sees one schema per folder. */
export function tableLocation(name: string): string {
  return `warehouse/${name}/`;
}
