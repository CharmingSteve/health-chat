import { TABLES } from "./ingest/schemas.js";
import { NAME_MAP } from "./ingest/labs.js";
import type { QueryResult } from "./query.js";

// The chat loop: the model may call query_data (SQL, checked in query.ts) up to MAX_ROUNDS times,
// then answers from the results. The model never sees the database directly.

export const MAX_ROUNDS = 6;

export function systemPrompt(): string {
  const schema = TABLES.map((t) => `- ${t.name}: ${t.description}\n  columns: ${Object.keys(t.columns).join(", ")}`).join("\n");
  return [
    "You answer questions about the owner's own health and diet data, using the query_data tool.",
    "Rules:",
    "1. Every number in your answer must come from a query result. If you have no query for it, say so.",
    "2. List the SQL you used at the end of the answer, one line per query.",
    "3. A day with no entry is unknown, not zero. Say how many days were logged out of the period.",
    "4. Correlations: state the sample size and that a correlation is not a cause.",
    "5. Sodium: blood sodium only. Salt intake is not recorded anywhere, so never estimate it.",
    "6. Apple Health totals are raw sums across sources and can double count. Say so when totalling.",
    "7. Lab reference ranges belong to the lab that issued them. Say when a value is outside its range, and do not diagnose.",
    "8. Urgent symptoms (severe or sudden headache, confusion, vomiting, fainting, chest pain): tell the owner to seek urgent care. Do not analyse them as trends.",
    "9. This is not medical advice. Suggest questions for a doctor rather than treatments or doses.",
    "10. If a question needs data that is not in the tables, say it is not there. Before saying that, run SELECT DISTINCT on the relevant column to check the stored spelling.",
    "11. Every row's owner column is 'owner' (the only person in these tables). Do not filter on owner.",
    "12. Before adding up a duration or a distance, check its unit column (for example duration_unit) and convert if units differ.",
    "13. Lab names are stored normalized and in lower case (for example hba1c, not HbA1c). Compare with lower(test_name) = 'hba1c' or use the names below exactly.",
    "",
    "Tables (query only these, with plain names):",
    schema,
    "",
    "Lab test_name values (use these exact strings): " + [...new Set(Object.values(NAME_MAP))].sort().join(", "),
  ].join("\n");
}

export interface ModelToolUse { toolUseId: string; name: string; input: { sql?: unknown } }
export type ModelTurn =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; text: string; toolUses: ModelToolUse[] };

/** One model call. messages and the reply use the Converse message shape. */
export type CallModel = (messages: unknown[]) => Promise<ModelTurn>;

export interface ChatDeps {
  callModel: CallModel;
  runQuery: (sql: string) => Promise<QueryResult>;
}

export interface ChatAnswer {
  answer: string;
  queries: { sql: string; ok: boolean; row_count: number; error?: string; bytes_scanned: number; columns: string[]; rows: (string | null)[][] }[];
  rounds: number;
}

export async function answerQuestion(question: string, deps: ChatDeps, context = ""): Promise<ChatAnswer> {
  const text = context ? `${context}\n\nCurrent question: ${question}` : question;
  const messages: unknown[] = [{ role: "user", content: [{ text }] }];
  const queries: ChatAnswer["queries"] = [];
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const turn = await deps.callModel(messages);
    if (turn.kind === "text") return { answer: turn.text, queries, rounds: round };
    messages.push({
      role: "assistant",
      content: [
        ...(turn.text ? [{ text: turn.text }] : []),
        ...turn.toolUses.map((t) => ({ toolUse: { toolUseId: t.toolUseId, name: t.name, input: t.input } })),
      ],
    });
    const results = [];
    for (const use of turn.toolUses) {
      const sql = typeof use.input.sql === "string" ? use.input.sql : "";
      const result = use.name === "query_data" && sql ? await deps.runQuery(sql) : failedResult("Unknown tool or missing sql");
      queries.push({ sql: result.sql_run || sql, ok: result.ok, row_count: result.row_count, bytes_scanned: result.bytes_scanned, columns: result.columns, rows: result.rows, ...(result.error ? { error: result.error } : {}) });
      results.push({
        toolResult: {
          toolUseId: use.toolUseId,
          content: [{ json: result.ok ? { columns: result.columns, rows: result.rows, row_count: result.row_count, truncated: result.truncated } : { error: result.error } }],
          status: result.ok ? "success" : "error",
        },
      });
    }
    messages.push({ role: "user", content: results });
  }
  return {
    answer: "I could not finish answering within the query limit. Try a narrower question.",
    queries,
    rounds: MAX_ROUNDS,
  };
}

function failedResult(error: string): QueryResult {
  return { ok: false, columns: [], rows: [], row_count: 0, truncated: false, bytes_scanned: 0, sql_run: "", error };
}

export const QUERY_TOOL = {
  tools: [
    {
      toolSpec: {
        name: "query_data",
        description: "Run one read-only SELECT over the health tables. Returns columns, rows (at most 500), and a truncated flag.",
        inputSchema: {
          json: {
            type: "object",
            properties: { sql: { type: "string", description: "One SELECT statement. Plain table names. No comments." } },
            required: ["sql"],
          },
        },
      },
    },
  ],
};
