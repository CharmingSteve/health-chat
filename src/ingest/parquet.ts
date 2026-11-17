import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

export type ColumnType = "VARCHAR" | "DOUBLE" | "BOOLEAN";

/** Writes rows to one Parquet file with an explicit schema, so types never depend on the data. */
export async function writeParquet(
  rows: readonly object[],
  columns: Record<string, ColumnType>,
  outputPath: string,
): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "health-chat-"));
  try {
    const jsonl = join(dir, "rows.jsonl");
    writeFileSync(jsonl, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
    return await jsonlToParquet(jsonl, columns, outputPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Converts a newline-delimited JSON file to Parquet without loading it into memory (for millions of rows). */
export async function jsonlToParquet(
  jsonl: string,
  columns: Record<string, ColumnType>,
  outputPath: string,
): Promise<number> {
  {
    const names = Object.keys(columns);
    const schema = names.map((name) => `'${name}': '${columns[name]}'`).join(", ");
    const selectList = names.map((name) => `"${name}"`).join(", ");
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run(
        `COPY (SELECT ${selectList} FROM read_json('${jsonl}', format='newline_delimited', columns={${schema}})) ` +
          `TO '${outputPath}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
      );
      const count = await connection.runAndReadAll(`SELECT count(*) AS n FROM read_parquet('${outputPath}')`);
      return Number(count.getRows()[0]?.[0] ?? 0);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }
}

/** Reads a Parquet file back and returns its rows (used by tests and the eval checks). */
export async function readParquet(path: string): Promise<Record<string, unknown>[]> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const result = await connection.runAndReadAll(`SELECT * FROM read_parquet('${path}') ORDER BY 1`);
    return result.getRowObjectsJS() as Record<string, unknown>[];
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/**
 * Like jsonlToParquet, but keeps one row per key (the first seen). Returns how many rows were kept and removed.
 * Used where the same sample can arrive from more than one source (for example iPhone and Apple Watch).
 */
export async function dedupeJsonlToParquet(
  jsonl: string,
  columns: Record<string, ColumnType>,
  keys: string[],
  outputPath: string,
): Promise<{ kept: number; removed: number }> {
  const names = Object.keys(columns);
  const schema = names.map((name) => `'${name}': '${columns[name]}'`).join(", ");
  const selectList = names.map((name) => `"${name}"`).join(", ");
  const keyList = keys.map((k) => `"${k}"`).join(", ");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const source = `read_json('${jsonl}', format='newline_delimited', columns={${schema}})`;
    const total = Number((await connection.runAndReadAll(`SELECT count(*) FROM ${source}`)).getRows()[0]?.[0] ?? 0);
    await connection.run(
      `COPY (SELECT DISTINCT ON (${keyList}) ${selectList} FROM ${source} ORDER BY ${keyList}) ` +
        `TO '${outputPath}' (FORMAT PARQUET, COMPRESSION ZSTD)`,
    );
    const kept = Number((await connection.runAndReadAll(`SELECT count(*) FROM read_parquet('${outputPath}')`)).getRows()[0]?.[0] ?? 0);
    return { kept, removed: total - kept };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
