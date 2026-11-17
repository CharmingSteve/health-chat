import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { errors } from "jose";
import { createApp } from "../src/app.js";

const APP_CLIENT = "app-client-123";
const publicDir = resolve(import.meta.dirname, "..", "public");
const bearer = { Authorization: "Bearer user-token" };
const verify = async (token: string) => {
  if (token !== "user-token") throw new errors.JWTInvalid("bad");
  return { sub: "owner", client_id: APP_CLIENT, token_use: "access" as const };
};

function makeApp(diet?: { readStatus: () => Promise<unknown>; startRefresh: () => Promise<void> }) {
  return createApp({
    verify,
    clientId: APP_CLIENT,
    converse: async () => "4",
    ...(diet ? { diet } : {}),
    browserConfig: { domain: "d", clientId: APP_CLIENT },
    publicDir,
  });
}

describe("diet status and refresh", () => {
  it("returns the status to the owner", async () => {
    const readStatus = vi.fn(async () => ({ last_success: { active_days: 176 }, last_attempt: null }));
    const app = makeApp({ readStatus, startRefresh: async () => {} });
    const res = await app.request("/api/diet/status", { headers: bearer });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ last_success: { active_days: 176 }, last_attempt: null });
  });

  it("starts a refresh and answers 202 without waiting for the import", async () => {
    const startRefresh = vi.fn(async () => {});
    const app = makeApp({ readStatus: async () => ({}), startRefresh });
    const res = await app.request("/api/diet/refresh", { method: "POST", headers: bearer });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ started: true });
    expect(startRefresh).toHaveBeenCalledTimes(1);
  });

  it("answers 503 without leaking detail when the refresh cannot start", async () => {
    const app = makeApp({ readStatus: async () => ({}), startRefresh: async () => { throw new Error("AccessDenied: role x"); } });
    const res = await app.request("/api/diet/refresh", { method: "POST", headers: bearer });
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("AccessDenied");
  });

  it("requires a token", async () => {
    const app = makeApp({ readStatus: async () => ({}), startRefresh: async () => {} });
    expect((await app.request("/api/diet/refresh", { method: "POST" })).status).toBe(401);
  });

  it("is not available where diet import is not enabled (staging)", async () => {
    const app = makeApp();
    expect((await app.request("/api/diet/status", { headers: bearer })).status).toBe(503);
    expect((await app.request("/api/diet/refresh", { method: "POST", headers: bearer })).status).toBe(503);
  });
});
