import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

// Chat history in S3. Nothing here is ever deleted: every turn is kept, and the bucket keeps old versions.
//
//   chats/<conversation_id>/<asked_at>_<turn_id>.json   one object per question and answer (the record)
//   activity/<conversation_id>.json                     latest activity: subject and time, overwritten per turn
//
// The list of chats is built from activity/ and shows chats whose last question is within RETENTION_DAYS.

export const RETENTION_DAYS = 120;
export const SUBJECT_MAX = 80;
/** Server-side attempts: 4 tries, waiting 1, 3, and 8 seconds between them (about 12 seconds of waiting). */
export const SERVER_RETRY_DELAYS_MS = [1000, 3000, 8000];

export interface QueryRecord {
  sql: string;
  ok: boolean;
  row_count: number;
  bytes_scanned: number;
  error?: string;
  columns: string[];
  rows: (string | null)[][];
}

export interface TurnRecord {
  schema: 1;
  owner: string;
  conversation_id: string;
  turn_id: string;
  asked_at: string; // ISO time
  subject: string;
  question: string;
  answer: string;
  model: string;
  rounds: number;
  queries: QueryRecord[];
}

export interface ConversationSummary {
  conversation_id: string;
  subject: string;
  last_asked_at: string;
}

export interface S3Like {
  send(command: PutObjectCommand | GetObjectCommand | ListObjectsV2Command): Promise<any>;
}

export function turnKey(conversationId: string, askedAt: string, turnId: string): string {
  return `chats/${conversationId}/${askedAt.replace(/:/g, "-")}_${turnId}.json`;
}

export function activityKey(conversationId: string): string {
  return `activity/${conversationId}.json`;
}

export function subjectFrom(question: string): string {
  const oneLine = question.replace(/\s+/g, " ").trim();
  return oneLine.length <= SUBJECT_MAX ? oneLine : `${oneLine.slice(0, SUBJECT_MAX - 1)}…`;
}

export function isValidId(value: string): boolean {
  return /^[A-Za-z0-9-]{8,64}$/.test(value);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Writes one turn and its activity marker. Retries with the given delays.
 * Returns saved=false with the last error when every attempt fails; the caller shows that to the owner.
 */
export async function saveTurn(
  s3: S3Like,
  bucket: string,
  turn: TurnRecord,
  delays: number[] = SERVER_RETRY_DELAYS_MS,
): Promise<{ saved: boolean; attempts: number; error?: string }> {
  const body = JSON.stringify(turn);
  const marker = JSON.stringify({ conversation_id: turn.conversation_id, subject: turn.subject, last_asked_at: turn.asked_at });
  let lastError = "";
  for (let attempt = 1; attempt <= delays.length + 1; attempt += 1) {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: turnKey(turn.conversation_id, turn.asked_at, turn.turn_id),
        Body: body,
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
      }));
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: activityKey(turn.conversation_id),
        Body: marker,
        ContentType: "application/json",
        ServerSideEncryption: "AES256",
      }));
      return { saved: true, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error.name : "unknown error";
      const wait = delays[attempt - 1];
      if (wait === undefined) break;
      await sleep(wait);
    }
  }
  return { saved: false, attempts: delays.length + 1, error: lastError };
}

async function listAll(s3: S3Like, bucket: string, prefix: string): Promise<{ Key: string; LastModified?: Date }[]> {
  const out: { Key: string; LastModified?: Date }[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const item of page.Contents ?? []) out.push({ Key: item.Key, LastModified: item.LastModified });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function readJson<T>(s3: S3Like, bucket: string, key: string): Promise<T> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return JSON.parse(await response.Body.transformToString("utf8")) as T;
}

/** Chats whose last question is within RETENTION_DAYS of now, newest first. */
export async function listConversations(s3: S3Like, bucket: string, now: Date): Promise<ConversationSummary[]> {
  const cutoff = now.getTime() - RETENTION_DAYS * 24 * 3600 * 1000;
  const keys = (await listAll(s3, bucket, "activity/")).map((o) => o.Key);
  const markers = await Promise.all(keys.map((k) => readJson<ConversationSummary>(s3, bucket, k)));
  return markers
    .filter((m) => Date.parse(m.last_asked_at) >= cutoff)
    .sort((a, b) => (a.last_asked_at < b.last_asked_at ? 1 : -1));
}

/** All turns of one chat, oldest first. Every turn is kept, so the full thread is always available. */
export async function readConversation(s3: S3Like, bucket: string, conversationId: string): Promise<TurnRecord[]> {
  const keys = (await listAll(s3, bucket, `chats/${conversationId}/`)).map((o) => o.Key).sort();
  const turns = await Promise.all(keys.map((k) => readJson<TurnRecord>(s3, bucket, k)));
  return turns.sort((a, b) => (a.asked_at < b.asked_at ? -1 : 1));
}

// ---- Context for the next question ----------------------------------------------------------------

export const CONTEXT_RECENT_TURNS = 6;
export const CONTEXT_MAX_CHARS = 6000;
const ANSWER_EXCERPT = 800;
const EARLIER_LIST_MAX = 1000;

/**
 * Builds the context sent with a new question. The last few turns keep an excerpt of their answers. Older turns
 * are reduced to their questions. Previous answers are labelled as possibly stale, so the model re-runs SQL for facts.
 * The result never exceeds CONTEXT_MAX_CHARS.
 */
export function buildContext(turns: TurnRecord[]): string {
  if (turns.length === 0) return "";
  const recent = turns.slice(-CONTEXT_RECENT_TURNS);
  const older = turns.slice(0, Math.max(0, turns.length - CONTEXT_RECENT_TURNS));
  const parts: string[] = ["Earlier in this conversation. Previous answers may be out of date: re-run SQL for any current figure."];
  if (older.length) {
    let list = older.map((t) => t.question.replace(/\s+/g, " ").trim()).join("; ");
    if (list.length > EARLIER_LIST_MAX) list = `${list.slice(0, EARLIER_LIST_MAX - 1)}…`;
    parts.push(`Earlier questions: ${list}`);
  }
  for (const t of recent) {
    const excerpt = t.answer.length > ANSWER_EXCERPT ? `${t.answer.slice(0, ANSWER_EXCERPT - 1)}…` : t.answer;
    parts.push(`Question: ${t.question}\nPrevious answer (excerpt): ${excerpt}`);
  }
  let text = parts.join("\n\n");
  if (text.length > CONTEXT_MAX_CHARS) text = `${text.slice(0, CONTEXT_MAX_CHARS - 1)}…`;
  return text;
}
