import { describe, expect, it, vi } from "vitest";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { resolve } from "node:path";
import { errors } from "jose";
import { createApp } from "../src/app.js";
import type { VerifiedUser } from "../src/auth.js";
import { answerQuestion, type ImageInput, type ModelTurn } from "../src/chat.js";

// A photo comparison is a turn in its chat, so it must be saved like an answer.
const APP_CLIENT = "app-client-123";
const publicDir = resolve(import.meta.dirname, "..", "public");
const users: Record<string, VerifiedUser> = { "user-token": { sub: "owner", client_id: APP_CLIENT, token_use: "access" } };
const bearer = { Authorization: "Bearer user-token", "Content-Type": "application/json" };
const NOW = new Date("2026-11-17T12:00:00.000Z");
const CONVERSATION = "11111111-2222-4333-8444-555555555555";

function fakeS3(failPuts = false) {
  const store = new Map<string, string>();
  return {
    store,
    async send(command: unknown): Promise<unknown> {
      if (command instanceof PutObjectCommand) {
        if (failPuts) throw Object.assign(new Error("down"), { name: "ServiceUnavailable" });
        store.set(command.input.Key!, String(command.input.Body));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const body = store.get(command.input.Key!);
        if (body === undefined) throw new Error("NoSuchKey");
        return { Body: { transformToString: async () => body } };
      }
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [...store.keys()].filter((key) => key.startsWith(command.input.Prefix ?? "")).map((Key) => ({ Key })) };
      }
      throw new Error("unexpected");
    },
  };
}

function makeApp(s3 = fakeS3()) {
  const load = vi.fn(async (ids: string[]) => ids.map((id) => ({
    id, date_taken: id === "aaaaaaaa" ? "2025-01-01" : "2026-01-01",
    image: { format: "jpeg" as const, bytes: new Uint8Array([1, 2, 3]) },
  })));
  const callModel = vi.fn(async (_messages: unknown[]): Promise<ModelTurn> => ({ kind: "text", text: "The original photos are visible in this follow-up." }));
  const ask = vi.fn(async (question: string, context: string, images?: ImageInput[], ids?: string[]) =>
    answerQuestion(question, {
      callModel,
      runQuery: async (sql) => ({ ok: false, columns: [], rows: [], row_count: 0, truncated: false, bytes_scanned: 0, sql_run: sql, error: "No queries expected" }),
      photos: { list: vi.fn(), load },
    }, context, images, ids));
  const photos = {
    list: vi.fn(), uploadForms: vi.fn(), save: vi.fn(), thumb: vi.fn(),
    compare: vi.fn(async () => "Visual estimate: the second photo shows less waist."),
  };
  const app = createApp({
    verify: async (token) => {
      const user = users[token];
      if (!user) throw new errors.JWTInvalid("bad");
      return user;
    },
    clientId: APP_CLIENT, converse: async () => "4",
    ask,
    photos: photos as never,
    history: { s3: s3 as never, bucket: "logs-test", now: () => NOW, model: "test-model", retryDelays: [0, 0, 0] },
    browserConfig: { domain: "d", clientId: APP_CLIENT }, publicDir,
  });
  return { app, s3, photos, ask, load, callModel };
}

const compare = (app: ReturnType<typeof makeApp>["app"], body: object) =>
  app.request("/api/photos/compare", { method: "POST", headers: bearer, body: JSON.stringify(body) });

describe("photo comparison in chat history", () => {
  it("saves the comparison in the open chat and reports saved=true", async () => {
    const { app, s3 } = makeApp();
    const res = await compare(app, { ids: ["aaaaaaaa", "bbbbbbbb"], conversation_id: CONVERSATION, subject: "Waist", question: "Which is leaner?" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ answer: expect.stringContaining("waist"), conversation_id: CONVERSATION, saved: true, subject: "Waist" });
    const saved = [...s3.store.values()].join("\n");
    expect(saved).toContain("Compare 2 photos: Which is leaner?");
    expect(saved).toContain("Visual estimate");
    const turn = JSON.parse([...s3.store.entries()].find(([key]) => key.startsWith("chats/"))![1]);
    expect(turn.photo_ids).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });

  it("starts a new chat when none is open, saves the comparison there, and returns its id", async () => {
    const { app, s3 } = makeApp();
    const body = await (await compare(app, { ids: ["aaaaaaaa", "bbbbbbbb"] })).json();
    expect(body).toMatchObject({ answer: expect.any(String), saved: true, conversation_id: expect.stringMatching(/^[0-9a-f-]{36}$/), subject: "Photo comparison" });
    expect(s3.store.size).toBeGreaterThan(0);
    expect([...s3.store.values()].join("\n")).toContain(body.conversation_id);
  });

  it("still shows the comparison when the save fails, and returns the turn so the page can resend it", async () => {
    const { app } = makeApp(fakeS3(true));
    const body = await (await compare(app, { ids: ["aaaaaaaa", "bbbbbbbb"], conversation_id: CONVERSATION })).json();
    expect(body).toMatchObject({ answer: expect.any(String), saved: false, save_error: expect.any(String), turn: expect.objectContaining({ conversation_id: CONVERSATION }) });
    expect(body.turn.photo_ids).toEqual(["aaaaaaaa", "bbbbbbbb"]);
  });

  it("continues a comparison with the same images, after reopening and after another follow-up", async () => {
    const { app, s3, ask, load, callModel } = makeApp();
    const body = await (await compare(app, { ids: ["aaaaaaaa", "bbbbbbbb"] })).json();
    const thread = await app.request(`/api/history/${body.conversation_id}`, { headers: bearer });
    expect((await thread.json()).turns[0].photo_ids).toEqual(["aaaaaaaa", "bbbbbbbb"]);
    for (const question of ["What changed?", "And the lighting?"]) {
      const response = await app.request("/api/ask", {
        method: "POST", headers: bearer, body: JSON.stringify({ question, conversation_id: body.conversation_id }),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).answer).toContain("original photos are visible");
    }
    expect(ask.mock.calls[0]?.[1]).toContain("Visual estimate");
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith(["aaaaaaaa", "bbbbbbbb"]);
    const messages = callModel.mock.calls[1]?.[0] as { content: Record<string, unknown>[] }[];
    expect(messages[0]?.content.slice(0, 2).every((block) => "image" in block)).toBe(true);
    const turns = [...s3.store.entries()].filter(([key]) => key.startsWith("chats/")).map(([, value]) => JSON.parse(value));
    expect(turns.every((turn) => turn.photo_ids.length === 2)).toBe(true);
  });

  it("recovers an older comparison's images only when its saved dated headings identify unique photos", async () => {
    const { app, s3, photos, load } = makeApp();
    const body = await (await compare(app, { ids: ["aaaaaaaa", "bbbbbbbb"] })).json();
    const [key, json] = [...s3.store.entries()].find(([key]) => key.startsWith("chats/"))!;
    const turn = JSON.parse(json);
    delete turn.photo_ids;
    turn.answer = "### Photo 1 (2025-01-01)\nFirst view.\n### Photo 2 (2026-01-01)\nSecond view.";
    s3.store.set(key, JSON.stringify(turn));
    photos.list.mockResolvedValue([
      { id: "aaaaaaaa", date_taken: "2025-01-01" },
      { id: "bbbbbbbb", date_taken: "2026-01-01" },
    ]);
    const response = await app.request("/api/ask", {
      method: "POST", headers: bearer, body: JSON.stringify({ question: "Compare the lighting", conversation_id: body.conversation_id }),
    });
    expect(response.status).toBe(200);
    expect(load).toHaveBeenCalledWith(["aaaaaaaa", "bbbbbbbb"]);
    photos.list.mockResolvedValue([
      { id: "aaaaaaaa", date_taken: "2025-01-01" },
      { id: "bbbbbbbb", date_taken: "2026-01-01" },
      { id: "cccccccc", date_taken: "2026-01-01" },
    ]);
    for (const [savedKey] of s3.store) if (savedKey.startsWith("chats/") && savedKey !== key) s3.store.delete(savedKey);
    load.mockClear();
    const ambiguous = await app.request("/api/ask", {
      method: "POST", headers: bearer, body: JSON.stringify({ question: "Compare the lighting", conversation_id: body.conversation_id }),
    });
    expect(ambiguous.status).toBe(409);
    expect((await ambiguous.json()).error).toContain("do not uniquely identify");
    expect(load).not.toHaveBeenCalled();
  });
});
