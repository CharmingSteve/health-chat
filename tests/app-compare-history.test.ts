import { describe, expect, it, vi } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { resolve } from "node:path";
import { errors } from "jose";
import { createApp } from "../src/app.js";
import type { VerifiedUser } from "../src/auth.js";

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
      throw new Error("unexpected");
    },
  };
}

function makeApp(s3 = fakeS3()) {
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
    photos: photos as never,
    history: { s3: s3 as never, bucket: "logs-test", now: () => NOW, model: "test-model", retryDelays: [0, 0, 0] },
    browserConfig: { domain: "d", clientId: APP_CLIENT }, publicDir,
  });
  return { app, s3, photos };
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
  });

  it("returns the answer without saving when no chat is open", async () => {
    const { app, s3 } = makeApp();
    const body = await (await compare(app, { ids: ["aaaaaaaa", "bbbbbbbb"] })).json();
    expect(body).toMatchObject({ answer: expect.any(String), saved: false });
    expect(s3.store.size).toBe(0);
  });

  it("still shows the comparison when the save fails, and returns the turn so the page can resend it", async () => {
    const { app } = makeApp(fakeS3(true));
    const body = await (await compare(app, { ids: ["aaaaaaaa", "bbbbbbbb"], conversation_id: CONVERSATION })).json();
    expect(body).toMatchObject({ answer: expect.any(String), saved: false, save_error: expect.any(String), turn: expect.objectContaining({ conversation_id: CONVERSATION }) });
  });
});
