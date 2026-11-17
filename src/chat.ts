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
    "13. Medications: a brand name is not a food or a supplement. Before answering about a brand, search the medical documents: SELECT source_key, text FROM medical_documents WHERE lower(text) LIKE '%brand%' (use the lower-case brand name). Quote the document's ingredient list. A brand can contain more than one ingredient, and stopping one brand does not stop an ingredient that another brand still contains. The documents may be out of date, so say what the owner has told you about current doses.",
    "14. Forecasts: never predict a future lab value, a score, or an outcome. Describe the past values, their dates, the reference range, and when the next test is due, and suggest asking the doctor. An A1C reflects roughly the last 2 to 3 months, so a single week of diet entries cannot change the next value in a way that can be predicted from these tables.",
    "17. Completeness: complete means the whole day's intake is known, and net calories are reliable (net_reliable=true). partial means the intake is not a whole-day total: do not give a net for it, and say it is partial. missing means nothing was logged: never treat it as zero. unknown marks older legacy days whose completeness was never recorded: say so when it matters. Leave partial, missing, and unknown days out of totals and averages unless the owner asks, and say how many were left out.",
    "16b. Compute every total, average, and count with SQL (SUM, AVG, COUNT), never by adding numbers in your head. Quote the figure from the query result.",
    "16a. Net for a day = intake minus burn. Intake is the sum of diet_entries.calories for that day (skip superseded rows). Burn is burn_effective from diet_days. Compute both in one query, for example: SELECT d.day, d.completeness, SUM(e.calories) - d.burn_effective AS net FROM diet_days d JOIN diet_entries e ON e.day = d.day AND NOT e.superseded GROUP BY d.day, d.completeness, d.burn_effective. Never report the intake alone as net.",
    "16. Burn and net calories: use burn_effective from diet_days. Where burn_basis is assumed_default, no burn was recorded and the owner's default of 2000 kcal is assumed; say so each time you use it. burn_total is only the recorded value. A day with no row in diet_days was not tracked, so do not assume a burn for it.",
    "15. Lab names are stored normalized and in lower case (for example hba1c, not HbA1c). Compare with lower(test_name) = 'hba1c' or use the names below exactly.",
    "",
    `Today is ${new Date().toISOString().slice(0, 10)} (UTC). Dates in every table are text in yyyy-mm-dd form.`,
    "SQL dialect is Athena (Trino): for date arithmetic cast first, e.g. CAST(day AS date) >= date_add('day', -30, current_date). Do not use INTERVAL literals or compare text dates to date values without a CAST.",
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
