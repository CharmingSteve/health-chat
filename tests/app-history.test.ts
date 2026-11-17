import { describe, expect, it, vi } from "vitest";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { resolve } from "node:path";
import { errors } from "jose";
import { createApp, type AppDeps } from "../src/app.js";
import type { VerifiedUser } from "../src/auth.js";
import type { ChatAnswer } from "../src/chat.js";

const APP_CLIENT = "app-client-123";
const publicDir = resolve(import.meta.dirname, "..", "public");
const users: Record<string, VerifiedUser> = { "user-token": { sub: "owner", client_id: APP_CLIENT, token_use: "access" } };
const bearer = { Authorization: "Bearer user-token", "Content-Type": "application/json" };
const NOW = new Date("2026-11-17T12:00:00.000Z");

function fakeS3(failAll = false) {
  const store = new Map<string, string>();
  return {
    store,
    async send(command: unknown): Promise<any> {
      if (failAll && command instanceof PutObjectCommand) throw Object.assign(new Error("down"), { name: "ServiceUnavailable" });
      if (command instanceof PutObjectCommand) {
        store.set(command.input.Key!, String(command.input.Body));
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const body = store.get(command.input.Key!);
        if (body === undefined) throw new Error("NoSuchKey");
        return { Body: { transformToString: async () => body } };
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix ?? "";
        return { Contents: [...store.keys()].filter((k) => k.startsWith(prefix)).map((Key) => ({ Key, LastModified: NOW })), IsTruncated: false };
      }
      throw new Error("unexpected");
    },
  };
}

const answer: ChatAnswer = { answer: "There are 3 labs.", queries: [{ sql: "SELECT 3", ok: true, row_count: 1, bytes_scanned: 10, columns: ["n"], rows: [["3"]] }], rounds: 2 };

function makeApp(opts: { s3?: ReturnType<typeof fakeS3>; ask?: AppDeps["ask"] } = {}) {
  const s3 = opts.s3 ?? fakeS3();
  const ask = opts.ask ?? vi.fn(async () => answer);
  const app = createApp({
    verify: async (token) => {
      const user = users[token];
      if (!user) throw new errors.JWTInvalid("bad");
      return user;
    },
    clientId: APP_CLIENT,
    converse: async () => "4",
    ask,
    history: { s3: s3 as never, bucket: "logs-test", now: () => NOW, model: "test-model", retryDelays: [0, 0, 0] },
    browserConfig: { domain: "d", clientId: APP_CLIENT },
    publicDir,
  });
  return { app, s3, ask };
}

const ask = (app: ReturnType<typeof makeApp>["app"], body: object) =>
  app.request("/api/ask", { method: "POST", headers: bearer, body: JSON.stringify(body) });

describe("asking with history", () => {
  it("answers, saves the turn, and reports saved=true", async () => {
    const { app, s3 } = makeApp();
    const res = await ask(app, { question: "How many labs?" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ answer: "There are 3 labs.", saved: true, history_enabled: true, subject: "How many labs?" });
    expect(body.conversation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect([...s3.store.keys()].filter((k) => k.startsWith("chats/")).length).toBe(1);
    expect(body.queries[0]).not.toHaveProperty("rows");
  });

  it("still shows the answer when the save fails, and returns the turn so the page can resend it", async () => {
    const { app } = makeApp({ s3: fakeS3(true) });
    const body = await (await ask(app, { question: "q" })).json();
    expect(body.answer).toBe("There are 3 labs.");
    expect(body).toMatchObject({ saved: false, save_error: "ServiceUnavailable" });
    expect(body.turn.question).toBe("q");
    expect(body.turn.queries[0].rows).toEqual([["3"]]);
  });

  it("gives the model the earlier turns of the same chat as context", async () => {
    const { app, s3, ask: askFn } = makeApp();
    const first = await (await ask(app, { question: "first question" })).json();
    await ask(app, { question: "follow-up", conversation_id: first.conversation_id });
    const context = (askFn.mock.calls[1] as unknown as [string, string])[1];
    expect(context).toContain("Question: first question");
    expect(context).toContain("may be out of date");
    expect(s3.store.size).toBeGreaterThan(0);
  });

  it("answers without context when the earlier turns cannot be read", async () => {
    const s3 = fakeS3();
    const { app, ask: askFn } = makeApp({ s3 });
    s3.send = async () => { throw new Error("down"); };
    const res = await ask(app, { question: "q", conversation_id: "conv-aaaaaaaa" });
    const body = await res.json();
    expect(body.context_loaded).toBe(false);
    expect((askFn.mock.calls[0] as unknown as [string, string])[1]).toBe("");
  });

  it("rejects a conversation id that is not a plain id", async () => {
    const { app } = makeApp();
    expect((await ask(app, { question: "q", conversation_id: "../x" })).status).toBe(400);
  });
});

describe("history endpoints", () => {
  it("lists saved chats and reopens one with all its turns", async () => {
    const { app } = makeApp();
    const first = await (await ask(app, { question: "chat one" })).json();
    const list = await (await app.request("/api/history", { headers: bearer })).json();
    expect(list.conversations.map((c: { subject: string }) => c.subject)).toEqual(["chat one"]);
    const thread = await (await app.request(`/api/history/${first.conversation_id}`, { headers: bearer })).json();
    expect(thread.turns.map((t: { question: string }) => t.question)).toEqual(["chat one"]);
  });

  it("rejects a bad conversation id in the path", async () => {
    const { app } = makeApp();
    expect((await app.request("/api/history/bad%20id", { headers: bearer })).status).toBe(400);
  });

  it("resends a turn that failed to save, and refuses a turn with the wrong shape", async () => {
    const { app, s3 } = makeApp({ s3: fakeS3(true) });
    const failed = await (await ask(app, { question: "resend me" })).json();
    s3.send = fakeS3().send.bind(fakeS3());
    const back = fakeS3();
    const { app: app2 } = makeApp({ s3: back });
    const withPhotos = { ...failed.turn, photo_ids: ["aaaaaaaa", "bbbbbbbb"] };
    const ok = await app2.request("/api/history/save", { method: "POST", headers: bearer, body: JSON.stringify(withPhotos) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ saved: true });
    const saved = [...back.store.entries()].find(([key]) => key.startsWith("chats/"));
    expect(JSON.parse(saved![1]).photo_ids).toEqual(withPhotos.photo_ids);
    const bad = await app2.request("/api/history/save", { method: "POST", headers: bearer, body: JSON.stringify({ ...failed.turn, turn_id: "../../x" }) });
    expect(bad.status).toBe(400);
    const badPhotos = await app2.request("/api/history/save", { method: "POST", headers: bearer, body: JSON.stringify({ ...withPhotos, photo_ids: ["../invalid"] }) });
    expect(badPhotos.status).toBe(400);
  });

  it("is not available in an environment without history (staging)", async () => {
    const app = createApp({
      verify: async () => users["user-token"]!,
      clientId: APP_CLIENT,
      converse: async () => "4",
      browserConfig: { domain: "d", clientId: APP_CLIENT },
      publicDir,
    });
    expect((await app.request("/api/history", { headers: bearer })).status).toBe(503);
  });
});
