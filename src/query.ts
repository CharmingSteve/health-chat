import { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand, StartQueryExecutionCommand } from "@aws-sdk/client-athena";
import { TABLES } from "./ingest/schemas.js";

// The only path from the model to the data. Every query is checked here before it reaches Athena:
// one SELECT (or WITH ... SELECT) statement, on the approved tables only, with a row limit.

export const MAX_ROWS = 500;
const ALLOWED = new Set(TABLES.map((t) => t.name));
const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|grant|revoke|merge|truncate|unload|msck|copy|call|execute|refresh|vacuum)\b/i;

export type Validation = { ok: true; sql: string } | { ok: false; reason: string };

/** Checks one statement. Returns the statement to run (with a row limit added when missing). */
export function validateSql(input: string): Validation {
  const trimmed = input.trim().replace(/;+\s*$/, "");
  if (trimmed.length === 0) return { ok: false, reason: "Empty query" };
  if (trimmed.length > 4000) return { ok: false, reason: "Query is too long" };
  if (trimmed.includes(";")) return { ok: false, reason: "Only one statement is allowed" };
  if (/--|\/\*/.test(trimmed)) return { ok: false, reason: "Comments are not allowed in queries" };
  if (!/^(select|with)\b/i.test(trimmed)) return { ok: false, reason: "Only SELECT queries are allowed" };
  const forbidden = FORBIDDEN.exec(trimmed);
  if (forbidden) return { ok: false, reason: `"${forbidden[0].toUpperCase()}" is not allowed` };

  // Names defined inside the query (WITH ... AS) are allowed; everything else after FROM/JOIN must be a table here.
  const ctes = new Set([...trimmed.matchAll(/(?:\bwith\b|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map((m) => (m[1] ?? "").toLowerCase()));
  for (const match of trimmed.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)) {
    const name = (match[1] ?? "").toLowerCase();
    if (!ALLOWED.has(name) && !ctes.has(name)) {
      return { ok: false, reason: `Unknown table "${name}". Allowed: ${[...ALLOWED].sort().join(", ")}` };
    }
  }
  // Quoted names and schema prefixes never match the pattern above, so they are refused here.
  if (/\b(?:from|join)\s+["`]/i.test(trimmed)) return { ok: false, reason: "Use plain table names" };

  const wrapped = `SELECT * FROM (${trimmed}) AS q LIMIT ${MAX_ROWS}`;
  return { ok: true, sql: wrapped };
}

export interface QueryResult {
  ok: boolean;
  columns: string[];
  rows: (string | null)[][];
  row_count: number;
  truncated: boolean;
  bytes_scanned: number;
  sql_run: string;
  error?: string;
}

export interface QueryRunner {
  (sql: string): Promise<QueryResult>;
}

export function athenaRunner(opts: { workgroup: string; database: string; client?: AthenaClient }): QueryRunner {
  const client = opts.client ?? new AthenaClient({});
  return async (sql: string): Promise<QueryResult> => {
    const checked = validateSql(sql);
    if (!checked.ok) return failed(sql, checked.reason);
    let start;
    try {
      start = await client.send(new StartQueryExecutionCommand({
        QueryString: checked.sql,
        WorkGroup: opts.workgroup,
        QueryExecutionContext: { Database: opts.database },
      }));
    } catch (error) {
      // Report the failure to the model as a query error, so it can correct the SQL, without exposing details.
      return failed(checked.sql, `Athena rejected the query (${error instanceof Error ? error.name : "error"})`);
    }
    const id = start.QueryExecutionId;
    if (!id) return failed(checked.sql, "Athena did not return a query id");
    const deadline = Date.now() + 60_000;
    let delay = 300;
    for (;;) {
      const status = await client.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
      const state = status.QueryExecution?.Status?.State;
      if (state === "SUCCEEDED") {
        const bytes = Number(status.QueryExecution?.Statistics?.DataScannedInBytes ?? 0);
        const results = await client.send(new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: MAX_ROWS + 1 }));
        const all = results.ResultSet?.Rows ?? [];
        const columns = (all[0]?.Data ?? []).map((d) => d.VarCharValue ?? "");
        const body = all.slice(1).map((r) => (r.Data ?? []).map((d) => d.VarCharValue ?? null));
        const truncated = body.length > MAX_ROWS;
        const rows = truncated ? body.slice(0, MAX_ROWS) : body;
        return { ok: true, columns, rows, row_count: rows.length, truncated, bytes_scanned: bytes, sql_run: checked.sql };
      }
      if (state === "FAILED" || state === "CANCELLED") {
        return failed(checked.sql, status.QueryExecution?.Status?.StateChangeReason ?? `Query ${state.toLowerCase()}`);
      }
      if (Date.now() > deadline) return failed(checked.sql, "Query timed out");
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 2000);
    }
  };
}

function failed(sql: string, error: string): QueryResult {
  return { ok: false, columns: [], rows: [], row_count: 0, truncated: false, bytes_scanned: 0, sql_run: sql, error };
}
