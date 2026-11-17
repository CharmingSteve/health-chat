import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { errors } from "jose";
import { createApp, type AppDeps } from "../src/app.js";
import { SMOKE_PROMPT } from "../src/bedrock.js";
import type { VerifiedUser } from "../src/auth.js";

const APP_CLIENT = "app-client-123";
const SMOKE_CLIENT = "smoke-client-456";
const publicDir = resolve(import.meta.dirname, "..", "public");

// Tokens are plain strings here; the signature check itself is covered in auth.test.ts.
const users: Record<string, VerifiedUser> = {
  "user-token": { sub: "owner", client_id: APP_CLIENT, token_use: "access" },
  "smoke-token": { sub: "smoke", client_id: SMOKE_CLIENT, token_use: "access", scope: "health-smoke/query" },
};

function makeApp(overrides: Partial<AppDeps> = {}) {
  const converse = vi.fn(async (_prompt: string) => "4");
  const verify = vi.fn(async (token: string) => {
    const user = users[token];
    if (!user) throw new errors.JWTInvalid("bad token");
    return user;
  });
  const app = createApp({
    verify,
    clientId: APP_CLIENT,
    smokeClientId: SMOKE_CLIENT,
    converse,
    browserConfig: { domain: "auth.example.test", clientId: APP_CLIENT },
    publicDir,
    ...overrides,
  });
  return { app, converse, verify };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("public routes", () => {
  it("GET /health returns status ok", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET / serves the page with the product name and the guide dropdowns", async () => {
    const { app } = makeApp();
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>health-chat</title>");
    // Thirteen guide sections are <details> dropdowns in the page. Count them exactly.
    expect(html.match(/<details>/g)?.length).toBe(13);
  });

  it("GET /config.json returns the hosted-UI domain and the app client id only", async () => {
    const { app } = makeApp();
    const res = await app.request("/config.json");
    expect(await res.json()).toEqual({ domain: "auth.example.test", clientId: APP_CLIENT });
  });

  it("serves security headers on every response", async () => {
    const { app } = makeApp();
    const res = await app.request("/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("protected /api routes", () => {
  it("returns 401 with no token and never verifies or calls the model", async () => {
    const { app, converse, verify } = makeApp();
    const res = await app.request("/api/smoke", { method: "POST" });
    expect(res.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
    expect(converse).not.toHaveBeenCalled();
  });

  it("returns 401 for a malformed Authorization header", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/me", { headers: { Authorization: "Basic abc" } });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a token that fails verification", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/me", { headers: bearer("forged") });
    expect(res.status).toBe(401);
  });

  it("returns 503 when verification fails for a non-token reason", async () => {
    const { app } = makeApp({
      verify: async () => {
        throw new TypeError("network down");
      },
    });
    const res = await app.request("/api/me", { headers: bearer("user-token") });
    expect(res.status).toBe(503);
  });

  it("returns 200 for the owner's token on /api/me", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/me", { headers: bearer("user-token") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: true, smoke: false });
  });

  it("returns 404 for an unknown route when the owner calls it", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/does-not-exist", { headers: bearer("user-token") });
    expect(res.status).toBe(404);
  });
});

describe("smoke token", () => {
  it("can call POST /api/smoke, which sends the fixed prompt once and reports ok when the reply is 4", async () => {
    const { app, converse } = makeApp();
    const res = await app.request("/api/smoke", { method: "POST", headers: bearer("smoke-token") });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, model: "configured" });
    expect(converse).toHaveBeenCalledTimes(1);
    expect(converse).toHaveBeenCalledWith(SMOKE_PROMPT);
  });

  it("is rejected with 403 on GET /api/me", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/me", { headers: bearer("smoke-token") });
    expect(res.status).toBe(403);
  });

  it("is rejected with 403 on any other /api route, even one that does not exist", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/anything", { method: "POST", headers: bearer("smoke-token") });
    expect(res.status).toBe(403);
  });

  it("is rejected with 403 on GET /api/smoke (the method must be POST)", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/smoke", { headers: bearer("smoke-token") });
    expect(res.status).toBe(403);
  });
});

describe("model check results", () => {
  it("reports 502 and ok=false when the model replies with the wrong digit", async () => {
    const { app } = makeApp({ converse: async () => "5" });
    const res = await app.request("/api/smoke", { method: "POST", headers: bearer("user-token") });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, model: "configured" });
  });

  it("accepts a reply of 4 with surrounding whitespace only", async () => {
    const { app } = makeApp({ converse: async () => " 4\n" });
    const res = await app.request("/api/smoke", { method: "POST", headers: bearer("user-token") });
    expect(res.status).toBe(200);
  });

  it("rejects 44 and four, which the model could say but the check must not accept", async () => {
    for (const reply of ["44", "four", "4 is the answer"]) {
      const { app } = makeApp({ converse: async () => reply });
      const res = await app.request("/api/smoke", { method: "POST", headers: bearer("user-token") });
      expect(res.status).toBe(502);
    }
  });

  it("reports 502 without leaking the error text when the model call throws", async () => {
    const { app } = makeApp({
      converse: async () => {
        throw new Error("AccessDeniedException: secret details");
      },
    });
    const res = await app.request("/api/smoke", { method: "POST", headers: bearer("user-token") });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toContain("AccessDenied");
    expect(body).not.toContain("secret details");
  });
});

describe("POST /api/ask", () => {
  const ask = vi.fn(async (question: string) => ({ answer: `echo: ${question}`, queries: [], rounds: 1 }));
  const post = (app: ReturnType<typeof makeApp>["app"], body: unknown, token = "user-token") =>
    app.request("/api/ask", { method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("answers the owner's question with the chat result", async () => {
    const { app } = makeApp({ ask });
    const res = await post(app, { question: "  how many labs?  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ answer: "echo: how many labs?", queries: [], rounds: 1, history_enabled: false });
    expect(ask).toHaveBeenLastCalledWith("how many labs?", "", [], []);
  });

  it("refuses with 401 and never calls the assistant when there is no token", async () => {
    const local = vi.fn(async () => ({ answer: "x", queries: [], rounds: 1 }));
    const { app } = makeApp({ ask: local });
    const res = await app.request("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "q" }) });
    expect(res.status).toBe(401);
    expect(local).not.toHaveBeenCalled();
  });

  it("refuses the smoke token (it may only use /api/smoke)", async () => {
    const { app } = makeApp({ ask });
    expect((await post(app, { question: "q" }, "smoke-token")).status).toBe(403);
  });

  it("returns 400 for a missing, empty, or overlong question, and for bad JSON", async () => {
    const { app } = makeApp({ ask });
    expect((await post(app, {})).status).toBe(400);
    expect((await post(app, { question: "   " })).status).toBe(400);
    expect((await post(app, { question: "x".repeat(1001) })).status).toBe(400);
    expect((await post(app, "{not json")).status).toBe(400);
  });

  it("returns 503 in an environment where data is not enabled", async () => {
    const { app } = makeApp();
    expect((await post(app, { question: "q" })).status).toBe(503);
  });

  it("returns 502 and no internal detail when the assistant fails", async () => {
    const { app } = makeApp({ ask: async () => { throw new Error("AccessDenied: role details"); } });
    const res = await post(app, { question: "q" });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("AccessDenied");
  });
});
