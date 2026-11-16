import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono, type Context, type Next } from "hono";
import { errors, type JWTPayload } from "jose";
import type { VerifiedUser } from "./auth.js";
import { SMOKE_PROMPT, smokeReplyIsCorrect, type Converse } from "./bedrock.js";

export interface AppDeps {
  /** Verifies a bearer token. Throws a jose error for bad tokens, anything else for service failures. */
  verify: (token: string) => Promise<VerifiedUser>;
  /** The app's own Cognito client id, and the smoke client id (if any). Used to route smoke tokens. */
  clientId: string;
  smokeClientId?: string;
  converse: Converse;
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

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((error, c) => {
    console.error("Unhandled error", error instanceof Error ? error.name : "unknown");
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}
