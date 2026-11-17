import { describe, expect, it, vi } from "vitest";
import { answerQuestion, MAX_ROUNDS, systemPrompt, type ModelTurn } from "../src/chat.js";
import type { QueryResult } from "../src/query.js";

const okResult = (sql: string): QueryResult => ({ ok: true, columns: ["n"], rows: [["3"]], row_count: 1, truncated: false, bytes_scanned: 4060, sql_run: sql });

function scripted(turns: ModelTurn[]) {
  let i = 0;
  return vi.fn(async (_messages: unknown[]) => {
    const turn = turns[i];
    i += 1;
    if (!turn) throw new Error("model called more times than scripted");
    return turn;
  });
}

describe("answerQuestion", () => {
  it("runs the SQL the model asks for and returns its final answer with the query recorded", async () => {
    const sql = "SELECT count(*) AS n FROM lab_results";
    const callModel = scripted([
      { kind: "tool_use", text: "", toolUses: [{ toolUseId: "t1", name: "query_data", input: { sql } }] },
      { kind: "text", text: "There are 3 lab rows." },
    ]);
    const runQuery = vi.fn(async (s: string) => okResult(s));
    const out = await answerQuestion("How many lab rows?", { callModel, runQuery });
    expect(runQuery).toHaveBeenCalledWith(sql);
    expect(out).toEqual({
      answer: "There are 3 lab rows.",
      queries: [{ sql, ok: true, row_count: 1, bytes_scanned: 4060, columns: ["n"], rows: [["3"]] }],
      rounds: 2,
    });
  });

  it("sends the tool result back to the model in the next round", async () => {
    const callModel = scripted([
      { kind: "tool_use", text: "", toolUses: [{ toolUseId: "t9", name: "query_data", input: { sql: "SELECT 1 FROM diet_days" } }] },
      { kind: "text", text: "done" },
    ]);
    await answerQuestion("q", { callModel, runQuery: async (s) => okResult(s) });
    const secondCall = callModel.mock.calls[1]?.[0] as { role: string; content: { toolResult?: { toolUseId: string; status: string } }[] }[];
    const last = secondCall[secondCall.length - 1];
    expect(last?.content[0]?.toolResult).toMatchObject({ toolUseId: "t9", status: "success" });
  });

  it("reports a refused query to the model as an error result, without throwing", async () => {
    const callModel = scripted([
      { kind: "tool_use", text: "", toolUses: [{ toolUseId: "t1", name: "query_data", input: { sql: "DROP TABLE diet_days" } }] },
      { kind: "text", text: "I could not run that." },
    ]);
    const runQuery = vi.fn(async (sql: string): Promise<QueryResult> => ({
      ok: false, columns: [], rows: [], row_count: 0, truncated: false, bytes_scanned: 0, sql_run: sql, error: "Only SELECT queries are allowed",
    }));
    const out = await answerQuestion("drop it", { callModel, runQuery });
    expect(out.queries[0]).toMatchObject({ ok: false, error: "Only SELECT queries are allowed" });
    const second = callModel.mock.calls[1]?.[0] as { content: { toolResult?: { status: string } }[] }[];
    expect(second[second.length - 1]?.content[0]?.toolResult?.status).toBe("error");
  });

  it("stops after the round limit when the model keeps asking for queries", async () => {
    const forever: ModelTurn = { kind: "tool_use", text: "", toolUses: [{ toolUseId: "t", name: "query_data", input: { sql: "SELECT 1 FROM diet_days" } }] };
    const callModel = vi.fn(async () => forever);
    const out = await answerQuestion("loop", { callModel, runQuery: async (s) => okResult(s) });
    expect(callModel).toHaveBeenCalledTimes(MAX_ROUNDS);
    expect(out.rounds).toBe(MAX_ROUNDS);
    expect(out.answer).toContain("query limit");
  });

  it("rejects a tool name it does not know, instead of running anything", async () => {
    const callModel = scripted([
      { kind: "tool_use", text: "", toolUses: [{ toolUseId: "x", name: "drop_everything", input: {} }] },
      { kind: "text", text: "ok" },
    ]);
    const runQuery = vi.fn(async (s: string) => okResult(s));
    const out = await answerQuestion("q", { callModel, runQuery });
    expect(runQuery).not.toHaveBeenCalled();
    expect(out.queries[0]).toMatchObject({ ok: false });
  });
});

describe("systemPrompt", () => {
  const prompt = systemPrompt();
  it("lists every table the model may query", () => {
    for (const name of ["diet_entries", "apple_workouts", "lab_results", "medical_documents"]) expect(prompt).toContain(name);
  });
  it("lists the lab names in the normalized form the table uses", () => {
    expect(prompt).toContain("hba1c");
    expect(prompt).toContain("owner column is 'owner'");
    expect(prompt).toContain("ldl_cholesterol");
  });
  it("carries the rules the owner asked for: blood sodium only, blank is unknown, correlation is not cause", () => {
    expect(prompt).toContain("Sodium: blood sodium only");
    expect(prompt).toContain("A day with no entry is unknown, not zero");
    expect(prompt).toContain("a correlation is not a cause");
    expect(prompt).toContain("Urgent symptoms");
  });
});

describe("medication and forecast rules", () => {
  const prompt = systemPrompt();
  it("tells the model to look up brand names in the medical documents, not guess them", () => {
    expect(prompt).toContain("search the medical documents");
    expect(prompt).toContain("a brand name is not a food or a supplement");
  });
  it("says combinations keep their ingredients, so stopping one brand does not stop an ingredient", () => {
    expect(prompt).toContain("stopping one brand does not stop an ingredient");
  });
  it("uses burn_effective and labels assumed burns", () => {
    expect(prompt).toContain("use burn_effective from diet_days");
    expect(prompt).toContain("assumed_default");
    expect(prompt).toContain("2000 kcal");
  });
  it("forbids predicting future lab values", () => {
    expect(prompt).toContain("never predict a future lab value");
  });
});
