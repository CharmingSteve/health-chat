import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { dedupeLabRows, parseClalitExport, type LabRow } from "./labs.js";
import { ALLOWED_FOLDERS, classify, type Kind } from "./medical-classify.js";
import { tableLocation } from "./schemas.js";
import { jsonlToParquet } from "./parquet.js";

// Local ingest for the medical bucket. Only the allowlisted folders and top-level PDFs are read.
// Everything else in the bucket is listed in the ledger as skipped, with the reason.
// Usage: npm run ingest:medical
const MEDICAL_BUCKET = "medical-stuff-570989156105-us-east-1-an";
const TABLES_BUCKET = "health-chat-tables-570989156105-us-east-1-an";
const OWNER = "owner";
const PROFILE = ["--profile", "click", "--region", "us-east-1"];

function aws(args: string[]): string {
  return execFileSync("aws", [...args, ...PROFILE, "--output", "json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

async function pdfText(path: string): Promise<{ pages: number; text: string }> {
  const data = new Uint8Array(readFileSync(path));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return { pages: doc.numPages, text: parts.join("\n").replace(/\s+/g, " ").trim() };
}

const work = mkdtempSync(join(tmpdir(), "medical-ingest-"));
try {
  const listing = JSON.parse(aws(["s3api", "list-objects-v2", "--bucket", MEDICAL_BUCKET])) as {
    Contents?: { Key: string; ETag: string; Size: number; LastModified: string }[];
  };
  const objects = listing.Contents ?? [];

  const skipped: Record<string, number> = {};
  const labLines: string[] = [];
  const documentLines: string[] = [];
  const fileLines: string[] = [];
  const labRows: LabRow[] = [];
  const unknownNames = new Set<string>();
  const counts: Record<string, number> = {};
  const sources: { key: string; etag: string; kind: Kind }[] = [];

  for (const object of objects) {
    const { kind, reason } = classify(object.Key);
    if (kind === "skipped") {
      skipped[reason ?? "skipped"] = (skipped[reason ?? "skipped"] ?? 0) + 1;
      continue;
    }
    counts[kind] = (counts[kind] ?? 0) + 1;
    sources.push({ key: object.Key, etag: object.ETag, kind });
    const folder = object.Key.includes("/") ? object.Key.split("/")[0] ?? "" : "(top level)";
    const local = join(work, "obj");
    if (kind === "lab_csv") {
      execFileSync("aws", ["s3", "cp", `s3://${MEDICAL_BUCKET}/${object.Key}`, local, ...PROFILE, "--only-show-errors"]);
      const parsed = parseClalitExport(OWNER, object.Key, readFileSync(local, "utf8"));
      labRows.push(...parsed.rows);
      parsed.unknownNames.forEach((n) => unknownNames.add(n));
    } else if (kind === "pdf") {
      execFileSync("aws", ["s3", "cp", `s3://${MEDICAL_BUCKET}/${object.Key}`, local, ...PROFILE, "--only-show-errors"]);
      const { pages, text } = await pdfText(local);
      documentLines.push(JSON.stringify({
        owner: OWNER, source_key: object.Key, folder, kind: "pdf", pages, has_text: text.length > 0,
        text_chars: text.length, text, bytes: object.Size, etag: object.ETag,
      }));
    } else {
      // Images and extension-less files are indexed by metadata only. Their content is not read here.
      fileLines.push(JSON.stringify({
        owner: OWNER, source_key: object.Key, folder, kind, bytes: object.Size, last_modified: object.LastModified, etag: object.ETag,
      }));
    }
  }

  // Tables.
  const out = join(work, "out");
  execFileSync("mkdir", ["-p", out]);
  const labJsonl = join(work, "labs.jsonl");
  writeFileSync(labJsonl, labRows.map((r) => JSON.stringify(r)).join("\n") + (labRows.length ? "\n" : ""));
  const docJsonl = join(work, "docs.jsonl");
  writeFileSync(docJsonl, documentLines.join("\n") + (documentLines.length ? "\n" : ""));
  const fileJsonl = join(work, "files.jsonl");
  writeFileSync(fileJsonl, fileLines.join("\n") + (fileLines.length ? "\n" : ""));

  const deduped = dedupeLabRows(labRows);
  labRows.splice(0, labRows.length, ...deduped.rows);
  writeFileSync(labJsonl, labRows.map((r) => JSON.stringify(r)).join("\n") + (labRows.length ? "\n" : ""));
  const rowCounts: Record<string, number> = {};
  rowCounts.lab_results = await jsonlToParquet(labJsonl, {
    owner: "VARCHAR", test_date: "VARCHAR", test_name_raw: "VARCHAR", test_name: "VARCHAR", known_name: "BOOLEAN",
    unit: "VARCHAR", value_text: "VARCHAR", value_num: "DOUBLE", ref_low: "DOUBLE", ref_high: "DOUBLE", flag: "VARCHAR",
    sample_flag: "VARCHAR", source_file: "VARCHAR",
  }, join(out, "lab_results.parquet"));
  rowCounts.medical_documents = await jsonlToParquet(docJsonl, {
    owner: "VARCHAR", source_key: "VARCHAR", folder: "VARCHAR", kind: "VARCHAR", pages: "DOUBLE", has_text: "BOOLEAN",
    text_chars: "DOUBLE", text: "VARCHAR", bytes: "DOUBLE", etag: "VARCHAR",
  }, join(out, "medical_documents.parquet"));
  rowCounts.medical_files = await jsonlToParquet(fileJsonl, {
    owner: "VARCHAR", source_key: "VARCHAR", folder: "VARCHAR", kind: "VARCHAR", bytes: "DOUBLE",
    last_modified: "VARCHAR", etag: "VARCHAR",
  }, join(out, "medical_files.parquet"));

  for (const name of ["lab_results", "medical_documents", "medical_files"]) {
    execFileSync("aws", ["s3", "cp", join(out, `${name}.parquet`), `s3://${TABLES_BUCKET}/${tableLocation(name)}data.parquet`, "--sse", "AES256", ...PROFILE, "--only-show-errors"]);
  }

  const ledger = join(out, "ledger.json");
  writeFileSync(ledger, JSON.stringify({
    table: "medical",
    run_at: new Date().toISOString(),
    bucket: MEDICAL_BUCKET,
    allowed_folders: ALLOWED_FOLDERS,
    objects_listed: objects.length,
    objects_read: sources.length,
    read_by_kind: counts,
    skipped_by_reason: skipped,
    unknown_lab_names: [...unknownNames].sort(),
    sources,
    rows: rowCounts,
    lab_duplicates_removed: deduped.removed,
    not_yet_extracted: "Images and DICOM files are indexed by metadata only; text and values are not extracted yet. Scanned PDFs without a text layer have has_text=false.",
  }, null, 2));
  execFileSync("aws", ["s3", "cp", ledger, `s3://${TABLES_BUCKET}/ledger/medical.json`, "--sse", "AES256", ...PROFILE, "--only-show-errors"]);

  console.info(JSON.stringify({
    objects_listed: objects.length, objects_read: sources.length, read_by_kind: counts,
    skipped_by_reason: skipped, rows: rowCounts, unknown_lab_names: [...unknownNames].sort(),
  }, null, 2));
} finally {
  rmSync(work, { recursive: true, force: true });
}
