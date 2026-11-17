import { describe, expect, it, vi } from "vitest";
import { answerQuestion, MAX_IMAGES_PER_ANSWER, type ImageInput, type ModelTurn, type PhotoAccess } from "../src/chat.js";
import type { QueryResult } from "../src/query.js";

const noQuery = async (sql: string): Promise<QueryResult> => ({ ok: true, columns: [], rows: [], row_count: 0, truncated: false, bytes_scanned: 0, sql_run: sql });
const jpeg = (n: number): ImageInput => ({ format: "jpeg", bytes: new Uint8Array([n, n, n]) });

function scripted(turns: ModelTurn[]) {
  let i = 0;
  return vi.fn(async (_m: unknown[]) => {
    const t = turns[i];
    i += 1;
    if (!t) throw new Error("more calls than scripted");
    return t;
  });
}

const photos: PhotoAccess = {
  list: vi.fn(async () => [{ id: "p1-aaaaaaaa", date_taken: "2026-11-07", setting: "Example gym", place: "0.000, 0.000" }]),
  load: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, date_taken: "2026-11-07", image: jpeg(7) }))),
};

describe("images attached in the chat box", () => {
  it("are sent in order before the context and question in the same message", async () => {
    const callModel = scripted([{ kind: "text", text: "ok" }]);
    const images = [jpeg(1), jpeg(2)];
    await answerQuestion("what is this?", { callModel, runQuery: noQuery }, "context", images);
    const first = callModel.mock.calls[0]?.[0] as { content: unknown[] }[];
    const blocks = first[0]!.content as Record<string, unknown>[];
    expect(blocks).toEqual([
      { image: { format: "jpeg", source: { bytes: images[0]!.bytes } } },
      { image: { format: "jpeg", source: { bytes: images[1]!.bytes } } },
      { text: "context\n\nCurrent question: what is this?" },
    ]);
  });

  it("refuses more than four", async () => {
    const five = Array.from({ length: MAX_IMAGES_PER_ANSWER + 1 }, (_, i) => jpeg(i));
    await expect(answerQuestion("q", { callModel: scripted([]), runQuery: noQuery }, "", five)).rejects.toThrow("at most 4");
  });
});

describe("photo tools", () => {
  it("list_photos returns the owner's photos with date, setting, and place", async () => {
    const callModel = scripted([
      { kind: "tool_use", text: "", toolUses: [{ toolUseId: "t1", name: "list_photos", input: {} }] },
      { kind: "text", text: "You have one photo." },
    ]);
    const out = await answerQuestion("what photos?", { callModel, runQuery: noQuery, photos });
    expect(photos.list).toHaveBeenCalled();
    const second = callModel.mock.calls[1]?.[0] as { content: { toolResult?: { content: { json?: unknown }[] } }[] }[];
    expect(JSON.stringify(second[second.length - 1]?.content[0]?.toolResult?.content)).toContain("Example gym");
    expect(out.answer).toBe("You have one photo.");
  });

  it("show_photos puts images before the initial text, keeps tool results JSON-only for Nova, and records their ids", async () => {
    const callModel = scripted([
      { kind: "tool_use", text: "", toolUses: [{ toolUseId: "t2", name: "show_photos", input: { ids: ["p1-aaaaaaaa"] } }] },
      { kind: "text", text: "The photo is from 2026-11-07." },
    ]);
    const out = await answerQuestion("look at it", { callModel, runQuery: noQuery, photos });
    expect(photos.load).toHaveBeenCalledWith(["p1-aaaaaaaa"]);
    const second = callModel.mock.calls[1]?.[0] as { content: { image?: unknown; text?: string; toolResult?: { content: Record<string, unknown>[] } }[] }[];
    const content = second[second.length - 1]?.content[0]?.toolResult?.content ?? [];
    expect(content.some((c) => "image" in c)).toBe(false);
    expect(content[0]).toMatchObject({ json: { shown: [{ id: "p1-aaaaaaaa", date_taken: "2026-11-07" }] } });
    expect(second[0]?.content[0]?.image).toMatchObject({ format: "jpeg" });
    expect(second[0]?.content[1]?.text).toContain("photo id p1-aaaaaaaa, taken 2026-11-07");
    expect(out.photos_shown).toEqual(["p1-aaaaaaaa"]);
  });

  it("reloads comparison photos before the first model call, including all eight, without asking the model to find them", async () => {
    const ids = Array.from({ length: 8 }, (_, i) => `photoid${i}`);
    const callModel = scripted([{ kind: "text", text: "The same photos are available." }]);
    const out = await answerQuestion("what changed?", { callModel, runQuery: noQuery, photos }, "earlier comparison", [], ids);
    expect(photos.load).toHaveBeenCalledWith(ids);
    const messages = callModel.mock.calls[0]?.[0] as { content: Record<string, unknown>[] }[];
    expect(messages[0]?.content).toHaveLength(9);
    expect(messages[0]?.content.slice(0, 8).every((block) => "image" in block)).toBe(true);
    expect(messages[0]?.content[8]?.text).toContain("earlier comparison");
    expect(messages[0]?.content[8]?.text).toContain("photo id photoid7");
    expect(out.photos_shown).toEqual(ids);
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("show_photos refuses more than four ids without loading anything", async () => {
    const load = vi.fn(async () => []);
    const callModel = scripted([
      { kind: "tool_use", text: "", toolUses: [{ toolUseId: "t3", name: "show_photos", input: { ids: ["a", "b", "c", "d", "e"] } }] },
      { kind: "text", text: "ok" },
    ]);
    await answerQuestion("q", { callModel, runQuery: noQuery, photos: { list: photos.list, load } });
    expect(load).not.toHaveBeenCalled();
  });

  it("says photos are not available where they are not enabled", async () => {
    const callModel = scripted([
      { kind: "tool_use", text: "", toolUses: [{ toolUseId: "t4", name: "list_photos", input: {} }] },
      { kind: "text", text: "ok" },
    ]);
    await answerQuestion("q", { callModel, runQuery: noQuery });
    const second = callModel.mock.calls[1]?.[0] as { content: { toolResult?: { content: { json?: { error?: string } }[] } }[] }[];
    expect(second[second.length - 1]?.content[0]?.toolResult?.content[0]?.json?.error).toContain("not available");
  });
});
