import type { ContentBlock, Message, ToolConfiguration, ToolUseBlock } from "@aws-sdk/client-bedrock-runtime";
import { TABLES } from "./ingest/schemas.js";
import { NAME_MAP } from "./ingest/labs.js";
import type { QueryResult } from "./query.js";
import { MAX_COMPARE_PHOTOS } from "./compare.js";

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
    "17. Completeness: complete means the whole day's intake is known, and net calories are reliable (net_reliable=true). partial means the intake is not a whole-day total: do not give a net for it, and say it is partial. missing means nothing was logged: never treat it as zero.  Leave partial and missing days out of totals and averages unless the owner asks, and say how many were left out.",
    "22. Photos: use list_photos to find them and show_photos to see them (up to 4 at a time). Describe only what is visible, photo by photo, with the date and setting given in the record. Do not guess what a photo shows; if you cannot see it clearly, say so. Body estimates are visual estimates with a range and a confidence, never measurements. For injuries, describe what is visible; for severe signs, say to seek urgent care now.",
    "23. Photos attached to the message are available to inspect now, including photos from an earlier comparison. Answer follow-up questions about them directly; do not ask the owner to upload them again. Use the photo tools only if you need other photos. Photo dates and labelled visual estimates come from the images and their metadata, not SQL; quantitative health records still require query results.",
    "21. The verified diet figures block in the message is computed by the database for this question. Quote its totals, counts, and averages exactly. Do not recompute them; if you need a figure it does not contain, query it.",
    "16b. Compute every total, average, and count with SQL (SUM, AVG, COUNT), never by adding numbers in your head. Quote the figure from the query result.",
    "16a. Net for a day = intake minus burn. Intake is the sum of diet_entries.calories for that day (skip superseded rows). Burn is burn_effective from diet_days. Compute both in one query, for example: SELECT d.day, d.completeness, SUM(e.calories) - d.burn_effective AS net FROM diet_days d JOIN diet_entries e ON e.day = d.day AND NOT e.superseded GROUP BY d.day, d.completeness, d.burn_effective. Never report the intake alone as net.",
    "18. Scope: use all the data the tables hold, from the first to the last day, unless the question names a period. Never narrow the period on your own (no 30-day or 17-day window unless asked). Start a trend, total, or average question with SELECT MIN(day), MAX(day), COUNT(*) and a count by month, then use the whole range. Say the period you used in the answer.",
    "19. Show every day in the period. Give the figure for complete days (net_reliable=true) and also the totals for all days, with the count of partial, missing, and unknown days, rather than leaving them out without saying so. Legacy master days are complete days (completeness_basis=owner_confirmed_legacy), confirmed by the owner, so they count as complete.",
    "20. Brand names of medications: identify them only from the medical documents (rule 13). Never name an ingredient from general knowledge.",
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

export interface ModelToolUse { toolUseId: string; name: string; input: { [key: string]: NonNullable<ToolUseBlock["input"]> | null } }
export type ModelTurn =
  | { kind: "text"; text: string }
  | { kind: "tool_use"; text: string; toolUses: ModelToolUse[] };

/** One model call. messages and the reply use the Converse message shape. */
export type CallModel = (messages: Message[]) => Promise<ModelTurn>;

export interface ImageInput {
  format: "jpeg" | "png";
  bytes: Uint8Array;
  label?: string;
}

/** Photos the chat can list and view. Viewing loads the small analysis copy (no location). */
export interface PhotoAccess {
  list: () => Promise<{ id: string; date_taken: string; setting: string | null; place: string | null }[]>;
  load: (ids: string[]) => Promise<{ id: string; date_taken: string; setting?: string | null; image: ImageInput }[]>;
}

export const MAX_IMAGES_PER_ANSWER = 4;

export interface ChatDeps {
  callModel: CallModel;
  runQuery: (sql: string) => Promise<QueryResult>;
  photos?: PhotoAccess;
}

export interface ChatAnswer {
  answer: string;
  photos_shown?: string[];
  queries: { sql: string; ok: boolean; row_count: number; error?: string; bytes_scanned: number; columns: string[]; rows: (string | null)[][] }[];
  rounds: number;
}

export async function answerQuestion(question: string, deps: ChatDeps, context = "", attached: ImageInput[] = [], photoIds: string[] = []): Promise<ChatAnswer> {
  if (attached.length > MAX_IMAGES_PER_ANSWER) throw new Error(`Attach at most ${MAX_IMAGES_PER_ANSWER} images`);
  const attachedBlocks = attached.map((img) => ({ image: { format: img.format, source: { bytes: img.bytes } } }));
  const shown = new Map<string, LoadedPhoto>();
  if (photoIds.length) {
    if (photoIds.length > MAX_COMPARE_PHOTOS) throw new Error(`Choose at most ${MAX_COMPARE_PHOTOS} photos`);
    if (!deps.photos) throw new Error("Photos are not available here");
    for (const photo of await deps.photos.load(photoIds)) shown.set(photo.id, photo);
  }
  const firstMessage: Message = { role: "user", content: [] };
  const updateImages = () => {
    const photos = [...shown.values()];
    const labels = photos.length ? `Photos attached above (after any newly attached images), in order:\n${photos.map((photo, i) => `Image ${attached.length + i + 1}: photo id ${photo.id}, taken ${photo.date_taken}${photo.setting ? `, setting: ${photo.setting}` : ""}`).join("\n")}` : "";
    const text = [context, labels, context || labels ? `Current question: ${question}` : question].filter(Boolean).join("\n\n");
    firstMessage.content = [...attachedBlocks, ...photos.map((photo) => ({ image: { format: photo.image.format, source: { bytes: photo.image.bytes } } })), { text }];
  };
  updateImages();
  const messages: Message[] = [firstMessage];
  const queries: ChatAnswer["queries"] = [];
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const turn = await deps.callModel(messages);
    if (turn.kind === "text") return { answer: turn.text, queries, rounds: round, ...(shown.size ? { photos_shown: [...shown.keys()] } : {}) };
    messages.push({
      role: "assistant",
      content: [
        ...(turn.text ? [{ text: turn.text }] : []),
        ...turn.toolUses.map((t) => ({ toolUse: { toolUseId: t.toolUseId, name: t.name, input: t.input } })),
      ],
    });
    const results: ContentBlock[] = [];
    for (const use of turn.toolUses) {
      const sql = typeof use.input.sql === "string" ? use.input.sql : "";
      if (use.name === "list_photos" || use.name === "show_photos") {
        const output = await photoToolResult(use, deps, [...shown.keys()]);
        results.push(output.result);
        for (const photo of output.photos) shown.set(photo.id, photo);
        updateImages();
        continue;
      }
      const result = use.name === "query_data" && sql ? await deps.runQuery(sql) : failedResult("Unknown tool or missing sql");
      queries.push({ sql: result.sql_run || sql, ok: result.ok, row_count: result.row_count, bytes_scanned: result.bytes_scanned, columns: result.columns, rows: result.rows, ...(result.error ? { error: result.error } : {}) });
      results.push({
        toolResult: {
          toolUseId: use.toolUseId,
          content: [{ json: result.ok ? { columns: result.columns, rows: result.rows, row_count: result.row_count, truncated: result.truncated } : { error: result.error ?? "Query failed" } }],
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
    ...(shown.size ? { photos_shown: [...shown.keys()] } : {}),
  };
}

function failedResult(error: string): QueryResult {
  return { ok: false, columns: [], rows: [], row_count: 0, truncated: false, bytes_scanned: 0, sql_run: "", error };
}

type LoadedPhoto = Awaited<ReturnType<PhotoAccess["load"]>>[number];
type PhotoToolOutput = { result: ContentBlock; photos: LoadedPhoto[] };

async function photoToolResult(use: ModelToolUse, deps: ChatDeps, shownIds: string[]): Promise<PhotoToolOutput> {
  const fail = (error: string): PhotoToolOutput => ({ result: { toolResult: { toolUseId: use.toolUseId, content: [{ json: { error } }], status: "error" } }, photos: [] });
  if (!deps.photos) return fail("Photos are not available here");
  if (use.name === "list_photos") {
    return { result: { toolResult: { toolUseId: use.toolUseId, content: [{ json: { photos: await deps.photos.list() } }], status: "success" } }, photos: [] };
  }
  const ids = Array.isArray(use.input.ids) ? use.input.ids.filter((i): i is string => typeof i === "string") : [];
  if (ids.length === 0 || ids.length > MAX_IMAGES_PER_ANSWER) return fail(`Choose 1 to ${MAX_IMAGES_PER_ANSWER} photo ids`);
  if (new Set([...shownIds, ...ids]).size > MAX_COMPARE_PHOTOS) return fail(`Choose at most ${MAX_COMPARE_PHOTOS} photos per answer`);
  const loaded = await deps.photos.load(ids);
  const meta = loaded.map((p) => ({ id: p.id, date_taken: p.date_taken, setting: p.setting ?? null }));
  // Nova accepts images in user messages, not nested inside tool results.
  return {
    result: {
      toolResult: {
        toolUseId: use.toolUseId,
        content: [{ json: { shown: meta, image_location: "The images are attached before the text in the first user message, in the labelled order." } }],
        status: "success",
      },
    },
    photos: loaded,
  };
}

export const QUERY_TOOL: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "list_photos",
        description: "List the owner's progress photos: id, date taken, setting, and place. Use before show_photos.",
        inputSchema: { json: { type: "object", properties: {} } },
      },
    },
    {
      toolSpec: {
        name: "show_photos",
        description: "Show up to 4 progress photos (by id) to you as images, with their dates. Describe only what is visible.",
        inputSchema: { json: { type: "object", properties: { ids: { type: "array", items: { type: "string" }, maxItems: 4 } }, required: ["ids"] } },
      },
    },
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
