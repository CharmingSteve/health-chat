import { describe, expect, it } from "vitest";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  activityKey, buildContext, CONTEXT_MAX_CHARS, isValidId, listConversations, readConversation, RETENTION_DAYS,
  saveTurn, subjectFrom, turnKey, type TurnRecord,
} from "../src/history.js";

const BUCKET = "logs-test";
const CONV = "conv-aaaaaaaa";

/** In-memory stand-in for the S3 client. failPuts makes the next N PutObject calls throw. */
function fakeS3(failPuts = 0) {
  const store = new Map<string, string>();
  const state = { puts: 0, failsLeft: failPuts };
  return {
    store,
    state,
    async send(command: unknown): Promise<any> {
      if (command instanceof PutObjectCommand) {
        state.puts += 1;
        if (state.failsLeft > 0) {
          state.failsLeft -= 1;
          throw Object.assign(new Error("throttled"), { name: "SlowDown" });
        }
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
        const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        return { Contents: keys.map((Key) => ({ Key, LastModified: new Date() })), IsTruncated: false };
      }
      throw new Error("unexpected command");
    },
  };
}

function turn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    schema: 1, owner: "owner", conversation_id: CONV, turn_id: "turn-00000001", asked_at: "2026-11-17T10:00:00.000Z",
    subject: "How many labs?", question: "How many labs?", answer: "There are 3.", model: "m", rounds: 1, queries: [], ...overrides,
  };
}

const NO_DELAY = [0, 0, 0];

describe("saveTurn", () => {
  it("writes the turn and the activity marker, and reports one attempt when nothing fails", async () => {
    const s3 = fakeS3();
    const t = turn();
    const result = await saveTurn(s3 as never, BUCKET, t, NO_DELAY);
    expect(result).toEqual({ saved: true, attempts: 1 });
    expect(s3.store.has(turnKey(CONV, t.asked_at, t.turn_id))).toBe(true);
    expect(JSON.parse(s3.store.get(activityKey(CONV))!)).toEqual({ conversation_id: CONV, subject: "How many labs?", last_asked_at: t.asked_at });
  });

  it("retries after transient failures and succeeds on a later attempt", async () => {
    const s3 = fakeS3(2);
    const result = await saveTurn(s3 as never, BUCKET, turn(), NO_DELAY);
    expect(result).toEqual({ saved: true, attempts: 3 });
    expect(s3.store.size).toBe(2);
  });

  it("reports not saved, with the error name, after every attempt fails", async () => {
    const s3 = fakeS3(100);
    const result = await saveTurn(s3 as never, BUCKET, turn(), NO_DELAY);
    expect(result).toEqual({ saved: false, attempts: 4, error: "SlowDown" });
    expect(s3.store.size).toBe(0);
  });
});

describe("listConversations", () => {
  const now = new Date("2026-11-17T12:00:00.000Z");
  it("lists chats touched within the retention window, newest first, and leaves out older ones", async () => {
    const s3 = fakeS3();
    const recent = new Date(now.getTime() - 10 * 24 * 3600 * 1000).toISOString();
    const older = new Date(now.getTime() - (RETENTION_DAYS + 5) * 24 * 3600 * 1000).toISOString();
    const newest = new Date(now.getTime() - 1 * 24 * 3600 * 1000).toISOString();
    s3.store.set(activityKey("conv-old-aaaa"), JSON.stringify({ conversation_id: "conv-old-aaaa", subject: "old", last_asked_at: older }));
    s3.store.set(activityKey("conv-rec-aaaa"), JSON.stringify({ conversation_id: "conv-rec-aaaa", subject: "recent", last_asked_at: recent }));
    s3.store.set(activityKey("conv-new-aaaa"), JSON.stringify({ conversation_id: "conv-new-aaaa", subject: "newest", last_asked_at: newest }));
    const list = await listConversations(s3 as never, BUCKET, now);
    expect(list.map((c) => c.subject)).toEqual(["newest", "recent"]);
  });

  it("keeps a chat whose first question is old but which was touched recently", async () => {
    const s3 = fakeS3();
    const touched = new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString();
    s3.store.set(activityKey(CONV), JSON.stringify({ conversation_id: CONV, subject: "started long ago", last_asked_at: touched }));
    expect((await listConversations(s3 as never, BUCKET, now)).length).toBe(1);
  });
});

describe("readConversation", () => {
  it("returns every turn of a chat, oldest first, across all dates", async () => {
    const s3 = fakeS3();
    await saveTurn(s3 as never, BUCKET, turn({ turn_id: "turn-00000002", asked_at: "2026-11-17T11:00:00.000Z", question: "second" }), NO_DELAY);
    await saveTurn(s3 as never, BUCKET, turn({ turn_id: "turn-00000001", asked_at: "2026-01-02T09:00:00.000Z", question: "first" }), NO_DELAY);
    const turns = await readConversation(s3 as never, BUCKET, CONV);
    expect(turns.map((t) => t.question)).toEqual(["first", "second"]);
  });
});

describe("buildContext", () => {
  it("is empty for a new chat", () => {
    expect(buildContext([])).toBe("");
  });

  it("keeps the last six answers as excerpts and labels them as possibly out of date", () => {
    const turns = Array.from({ length: 8 }, (_, i) => turn({ turn_id: `turn-0000000${i}`, question: `q${i}`, answer: `a${i}` }));
    const text = buildContext(turns);
    expect(text).toContain("Question: q7");
    expect(text).toContain("Question: q2");
    expect(text).not.toContain("Question: q1\n");
    expect(text).toContain("Earlier questions: q0; q1");
    expect(text).toContain("may be out of date");
  });

  it("never exceeds the size cap, even with very long answers", () => {
    const long = "x".repeat(50000);
    const turns = Array.from({ length: 20 }, (_, i) => turn({ turn_id: `turn-0000000${i % 10}`, question: `q${i} ${"y".repeat(500)}`, answer: long }));
    expect(buildContext(turns).length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
  });
});

describe("helpers", () => {
  it("shortens a long first question to a subject of at most 80 characters", () => {
    expect(subjectFrom("short question")).toBe("short question");
    expect(subjectFrom("a".repeat(200)).length).toBe(80);
  });
  it("accepts only plain ids", () => {
    expect(isValidId("abcdef12-3456")).toBe(true);
    expect(isValidId("../../etc/passwd")).toBe(false);
    expect(isValidId("short")).toBe(false);
  });
});
