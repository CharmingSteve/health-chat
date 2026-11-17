import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono, type Context, type Next } from "hono";
import { errors, type JWTPayload } from "jose";
import type { VerifiedUser } from "./auth.js";
import { SMOKE_PROMPT, smokeReplyIsCorrect, type Converse } from "./bedrock.js";
import type { ChatAnswer } from "./chat.js";
import { isValidPhotoId } from "./photos.js";
import { buildContext, isValidId, listConversations, readConversation, saveTurn, subjectFrom, type S3Like, type TurnRecord } from "./history.js";
import { randomUUID } from "node:crypto";

export interface AppDeps {
  /** Verifies a bearer token. Throws a jose error for bad tokens, anything else for service failures. */
  verify: (token: string) => Promise<VerifiedUser>;
  /** The app's own Cognito client id, and the smoke client id (if any). Used to route smoke tokens. */
  clientId: string;
  smokeClientId?: string;
  converse: Converse;
  /** Answers a data question. Absent in environments where the data is not enabled. */
  ask?: (question: string, context: string) => Promise<ChatAnswer>;
  /** Chat history in S3 (production only). Absent where history is not enabled. */
  history?: { s3: S3Like; bucket: string; now: () => Date; model: string; retryDelays?: number[] };
  /** Progress photos. Production only. */
  photos?: import("./photo-service.js").PhotoService;
  /** Diet import status (the last successful run and the last attempt), and the refresh trigger. Production only. */
  diet?: { readStatus: () => Promise<unknown>; startRefresh: () => Promise<void> };
  /** Public browser config. Client ids and the hosted-UI domain are not secrets. */
  browserConfig: { domain: string; clientId: string };
  publicDir: string;
}

type Env = { Variables: { user: VerifiedUser; smoke: boolean } };

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};
// Browser libraries copied by scripts/vendor-browser-libs.mjs. libheif.mjs embeds its wasm, so no .wasm file is needed.
const VENDOR: Record<string, { file: string; type: string }> = {
  "/vendor/exifr.mjs": { file: "vendor/exifr.mjs", type: "text/javascript; charset=utf-8" },
  "/vendor/libheif.mjs": { file: "vendor/libheif.mjs", type: "text/javascript; charset=utf-8" },
};

export function createApp(deps: AppDeps): Hono<Env> {
  const app = new Hono<Env>();
  const assets = new Map<string, { body: string; type: string }>();
  for (const [route, { file, type }] of Object.entries(STATIC)) {
    assets.set(route, { body: readFileSync(resolve(deps.publicDir, file), "utf8"), type });
  }

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/config.json", (c) => c.json(deps.browserConfig));

  for (const route of Object.keys(STATIC)) {
    app.get(route, (c) => {
      const asset = assets.get(route);
      if (!asset) return c.notFound();
      return c.body(asset.body, 200, { "Content-Type": asset.type });
    });
  }

  // Vendor files are optional locally: a missing one returns 404 and does not stop the app from starting.
  const vendor = new Map<string, { body: ArrayBuffer; type: string }>();
  for (const [route, { file, type }] of Object.entries(VENDOR)) {
    const path = resolve(deps.publicDir, file);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    vendor.set(route, { body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, type });
  }
  for (const route of Object.keys(VENDOR)) {
    app.get(route, (c) => {
      const asset = vendor.get(route);
      if (!asset) return c.notFound();
      return c.body(asset.body, 200, { "Content-Type": asset.type });
    });
  }

  // Everything under /api needs a valid token. The smoke token can reach only POST /api/smoke.
  const requireAuth = async (c: Context<Env>, next: Next): Promise<Response | void> => {
    const header = c.req.header("Authorization");
    const match = header && /^Bearer ([^\s]+)$/.exec(header);
    if (!match?.[1]) return c.json({ error: "Authentication required" }, 401);
    let user: VerifiedUser;
    try {
      user = await deps.verify(match[1]);
    } catch (error) {
      if (error instanceof errors.JOSEError) return c.json({ error: "Invalid or expired token" }, 401);
      console.error("Authentication service failure", error instanceof Error ? error.name : "unknown");
      return c.json({ error: "Authentication service unavailable" }, 503);
    }
    const isSmoke = Boolean(deps.smokeClientId) && (user as JWTPayload).client_id === deps.smokeClientId;
    if (isSmoke && !(c.req.method === "POST" && c.req.path === "/api/smoke")) {
      return c.json({ error: "Forbidden" }, 403);
    }
    c.set("user", user);
    c.set("smoke", isSmoke);
    await next();
  };
  app.use("/api/*", requireAuth);

  app.get("/api/me", (c) => c.json({ signedIn: true, smoke: c.get("smoke") }));

  app.post("/api/smoke", async (c) => {
    try {
      const reply = await deps.converse(SMOKE_PROMPT);
      const ok = smokeReplyIsCorrect(reply);
      return c.json({ ok, model: "configured" }, ok ? 200 : 502);
    } catch (error) {
      console.error("Smoke model call failed", error instanceof Error ? error.name : "unknown");
      return c.json({ ok: false, error: "Model call failed" }, 502);
    }
  });

  app.post("/api/ask", async (c) => {
    if (!deps.ask) return c.json({ error: "Data questions are not enabled in this environment" }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Send JSON with a question" }, 400);
    }
    const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    const question = typeof fields.question === "string" ? fields.question : undefined;
    if (question === undefined || question.trim().length === 0) return c.json({ error: "Question is required" }, 400);
    if (question.length > 1000) return c.json({ error: "Question is too long (1000 characters at most)" }, 400);
    const requestedId = typeof fields.conversation_id === "string" ? fields.conversation_id : undefined;
    if (requestedId !== undefined && !isValidId(requestedId)) return c.json({ error: "Bad conversation id" }, 400);
    const conversationId = requestedId ?? randomUUID();

    // Earlier turns of the same chat give the model its context. If they cannot be read, the question is still answered.
    let context = "";
    let contextLoaded = true;
    if (requestedId && deps.history) {
      try {
        context = buildContext(await readConversation(deps.history.s3, deps.history.bucket, conversationId));
      } catch {
        contextLoaded = false;
      }
    }
    try {
      const result = await deps.ask(question.trim(), context);
      const subject = typeof fields.subject === "string" && fields.subject.trim() ? fields.subject.trim().slice(0, 80) : subjectFrom(question);
      const turn: TurnRecord = {
        schema: 1,
        owner: "owner",
        conversation_id: conversationId,
        turn_id: randomUUID(),
        asked_at: (deps.history?.now() ?? new Date()).toISOString(),
        subject,
        question: question.trim(),
        answer: result.answer,
        model: deps.history?.model ?? "",
        rounds: result.rounds,
        queries: result.queries.map((q) => ({ sql: q.sql, ok: q.ok, row_count: q.row_count, bytes_scanned: q.bytes_scanned, ...(q.error ? { error: q.error } : {}), columns: q.columns ?? [], rows: q.rows ?? [] })),
      };
      if (!deps.history) {
        return c.json({ answer: result.answer, queries: result.queries.map(({ rows: _rows, columns: _columns, ...q }) => q), rounds: result.rounds, conversation_id: conversationId, history_enabled: false, context_loaded: contextLoaded });
      }
      // Answer first; the save is reported next to it. The page resends an unsaved turn with /api/history/save.
      const save = await saveTurn(deps.history.s3, deps.history.bucket, turn, deps.history.retryDelays);
      return c.json({
        answer: result.answer,
        // Rows stay in the saved turn; the page gets the SQL and counts only.
        queries: result.queries.map(({ rows: _rows, columns: _columns, ...q }) => q),
        rounds: result.rounds,
        conversation_id: conversationId,
        turn_id: turn.turn_id,
        subject: turn.subject,
        history_enabled: true,
        context_loaded: contextLoaded,
        saved: save.saved,
        ...(save.saved ? {} : { save_error: save.error ?? "unknown", turn }),
      });
    } catch (error) {
      console.error("Chat failed", error instanceof Error ? error.name : "unknown");
      return c.json({ error: "The assistant could not answer. Try again." }, 502);
    }
  });

  // Resend a turn that could not be saved. The turn is checked before it is written.
  app.post("/api/history/save", async (c) => {
    if (!deps.history) return c.json({ error: "History is not enabled in this environment" }, 503);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Send the turn as JSON" }, 400);
    }
    const turn = checkTurn(body);
    if (!turn) return c.json({ error: "Not a valid turn record" }, 400);
    const save = await saveTurn(deps.history.s3, deps.history.bucket, turn, deps.history.retryDelays);
    return c.json(save, save.saved ? 200 : 503);
  });

  app.get("/api/diet/status", async (c) => {
    if (!deps.diet) return c.json({ error: "Diet import is not enabled in this environment" }, 503);
    try {
      return c.json(await deps.diet.readStatus());
    } catch {
      return c.json({ error: "Status could not be read. Try again." }, 503);
    }
  });

  app.post("/api/diet/refresh", async (c) => {
    if (!deps.diet) return c.json({ error: "Diet import is not enabled in this environment" }, 503);
    try {
      await deps.diet.startRefresh();
      return c.json({ started: true }, 202);
    } catch {
      return c.json({ error: "The refresh could not be started. Try again." }, 503);
    }
  });

  app.get("/api/photos", async (c) => {
    if (!deps.photos) return c.json({ error: "Photos are not enabled in this environment" }, 503);
    try {
      return c.json({ photos: await deps.photos.list() });
    } catch {
      return c.json({ error: "Photos could not be read. Try again." }, 503);
    }
  });

  app.get("/api/photos/:id/thumb", async (c) => {
    if (!deps.photos) return c.json({ error: "Photos are not enabled in this environment" }, 503);
    const id = c.req.param("id");
    if (!isValidPhotoId(id)) return c.json({ error: "Bad photo id" }, 400);
    try {
      const bytes = await deps.photos.thumb(id);
      return c.body(bytes as never, 200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" });
    } catch {
      return c.json({ error: "Photo not found" }, 404);
    }
  });

  app.post("/api/photos/upload-form", async (c) => {
    if (!deps.photos) return c.json({ error: "Photos are not enabled in this environment" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      return c.json(await deps.photos.uploadForms({ date_taken: body.date_taken, original_type: body.original_type }));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Bad request" }, 400);
    }
  });

  app.post("/api/photos", async (c) => {
    if (!deps.photos) return c.json({ error: "Photos are not enabled in this environment" }, 503);
    const body = await c.req.json().catch(() => null);
    try {
      return c.json(await deps.photos.save(body), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Bad request" }, 400);
    }
  });

  app.post("/api/photos/compare", async (c) => {
    if (!deps.photos) return c.json({ error: "Photos are not enabled in this environment" }, 503);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    let answer: string;
    try {
      answer = await deps.photos.compare({ ids: body.ids, question: body.question });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/choose|must be|not found/i.test(message)) return c.json({ error: message }, 400);
      console.error("Photo comparison failed", error instanceof Error ? error.name : "unknown");
      return c.json({ error: "The comparison could not be made. Try again." }, 502);
    }
    // A comparison is a turn in a chat, so it is saved like any answer. With no chat open (or an unknown one),
    // a new chat is started, the same way /api/ask does.
    if (!deps.history) return c.json({ answer, history_enabled: false, saved: false });
    const requestedId = typeof body.conversation_id === "string" ? body.conversation_id : undefined;
    if (requestedId !== undefined && !isValidId(requestedId)) return c.json({ error: "Bad conversation id" }, 400);
    const conversationId = requestedId ?? randomUUID();
    const ids = Array.isArray(body.ids) ? body.ids.length : 0;
    const asked = typeof body.question === "string" && body.question.trim() ? body.question.trim() : "";
    const subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim().slice(0, 80) : "Photo comparison";
    const turn: TurnRecord = {
      schema: 1,
      owner: "owner",
      conversation_id: conversationId,
      turn_id: randomUUID(),
      asked_at: deps.history.now().toISOString(),
      subject,
      question: `Compare ${ids} photos${asked ? `: ${asked}` : ""}`,
      answer,
      model: deps.history.model,
      rounds: 1,
      queries: [],
    };
    const save = await saveTurn(deps.history.s3, deps.history.bucket, turn, deps.history.retryDelays);
    return c.json({
      answer, conversation_id: conversationId, turn_id: turn.turn_id, subject: turn.subject,
      history_enabled: true, saved: save.saved,
      ...(save.saved ? {} : { save_error: save.error ?? "unknown", turn }),
    });
  });

  app.get("/api/history", async (c) => {
    if (!deps.history) return c.json({ error: "History is not enabled in this environment" }, 503);
    try {
      return c.json({ conversations: await listConversations(deps.history.s3, deps.history.bucket, deps.history.now()) });
    } catch {
      return c.json({ error: "History could not be read. Try again." }, 503);
    }
  });

  app.get("/api/history/:id", async (c) => {
    if (!deps.history) return c.json({ error: "History is not enabled in this environment" }, 503);
    const id = c.req.param("id");
    if (!isValidId(id)) return c.json({ error: "Bad conversation id" }, 400);
    try {
      return c.json({ conversation_id: id, turns: await readConversation(deps.history.s3, deps.history.bucket, id) });
    } catch {
      return c.json({ error: "History could not be read. Try again." }, 503);
    }
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    console.error("Unhandled error", error instanceof Error ? error.name : "unknown");
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}

/** Checks the shape of a turn sent back by the page. Only the fields the app writes are kept. */
function checkTurn(body: unknown): TurnRecord | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const t = body as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
  if (!isValidId(String(t.conversation_id ?? "")) || !isValidId(String(t.turn_id ?? ""))) return undefined;
  if (!str(t.question, 1000) || !str(t.answer, 20000) || !str(t.subject, 80) || !str(t.asked_at, 40)) return undefined;
  if (!Array.isArray(t.queries) || t.queries.length > 20) return undefined;
  return {
    schema: 1,
    owner: "owner",
    conversation_id: String(t.conversation_id),
    turn_id: String(t.turn_id),
    asked_at: String(t.asked_at),
    subject: String(t.subject),
    question: String(t.question),
    answer: String(t.answer),
    model: str(t.model, 200) ? String(t.model) : "",
    rounds: typeof t.rounds === "number" ? t.rounds : 0,
    queries: t.queries as TurnRecord["queries"],
  };
}
