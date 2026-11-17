import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { errors } from "jose";
import { createApp } from "../src/app.js";

const APP_CLIENT = "app-client-123";
const publicDir = resolve(import.meta.dirname, "..", "public");
const bearer = { Authorization: "Bearer user-token", "Content-Type": "application/json" };
const verify = async (token: string) => {
  if (token !== "user-token") throw new errors.JWTInvalid("bad");
  return { sub: "owner", client_id: APP_CLIENT, token_use: "access" as const };
};
const service = () => ({
  list: vi.fn(async () => [{ id: "abcdefgh-1234", date_taken: "2026-11-10" }]),
  uploadForms: vi.fn(async () => ({ id: "abcdefgh-1234", date_taken: "2026-11-17", original: {}, analysis: {}, max_bytes: 10485760 })),
  save: vi.fn(async (b: unknown) => b),
  compare: vi.fn(async () => "Visual estimate: small change in posture."),
});

function makeApp(photos?: ReturnType<typeof service>) {
  return createApp({
    verify, clientId: APP_CLIENT, converse: async () => "4",
    ...(photos ? { photos } : {}),
    browserConfig: { domain: "d", clientId: APP_CLIENT }, publicDir,
  });
}

describe("photo routes", () => {
  it("lists photos for the owner", async () => {
    const svc = service();
    const res = await makeApp(svc).request("/api/photos", { headers: bearer });
    expect(res.status).toBe(200);
    expect((await res.json()).photos[0].date_taken).toBe("2026-11-10");
  });
  it("refuses a future or malformed date when asking for an upload form", async () => {
    const svc = service();
    svc.uploadForms = vi.fn(async () => { throw new Error("The date is in the future"); });
    const res = await makeApp(svc).request("/api/photos/upload-form", { method: "POST", headers: bearer, body: JSON.stringify({ date_taken: "2030-01-01", original_type: "image/jpeg" }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("future");
  });
  it("compares the chosen photos and returns the answer", async () => {
    const svc = service();
    const res = await makeApp(svc).request("/api/photos/compare", { method: "POST", headers: bearer, body: JSON.stringify({ ids: ["a", "b"] }) });
    expect(res.status).toBe(200);
    expect((await res.json()).answer).toContain("Visual estimate");
  });
  it("refuses a comparison of fewer than two photos with a clear message", async () => {
    const svc = service();
    svc.compare = vi.fn(async () => { throw new Error("Choose at least two photos to compare"); });
    const res = await makeApp(svc).request("/api/photos/compare", { method: "POST", headers: bearer, body: JSON.stringify({ ids: ["a"] }) });
    expect(res.status).toBe(400);
  });
  it("needs a token, and is not available where photos are not enabled (staging)", async () => {
    expect((await makeApp(service()).request("/api/photos")).status).toBe(401);
    expect((await makeApp().request("/api/photos", { headers: bearer })).status).toBe(503);
  });
});
