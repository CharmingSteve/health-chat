import { beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/app.js";

// Regression: /vendor/* was not routed, so the HEIC decoder (libheif.mjs and its libheif.wasm) returned 404 in the browser.
const root = resolve(import.meta.dirname, "..");
const publicDir = resolve(root, "public");
const APP_CLIENT = "app-client-123";

function makeApp() {
  return createApp({
    verify: vi.fn(async () => { throw new Error("not used"); }),
    clientId: APP_CLIENT, converse: async () => "4",
    browserConfig: { domain: "d", clientId: APP_CLIENT }, publicDir,
  });
}

describe("browser libraries under /vendor", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [resolve(root, "scripts/vendor-browser-libs.mjs")]);
  });

  it("serves the HEIC decoder module and its wasm, without a token", async () => {
    const mjs = await makeApp().request("/vendor/libheif.mjs");
    expect(mjs.status).toBe(200);
    expect(mjs.headers.get("content-type")).toContain("javascript");

    const wasm = await makeApp().request("/vendor/libheif.wasm");
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    const bytes = new Uint8Array(await wasm.arrayBuffer());
    expect(bytes.byteLength).toBe(readFileSync(resolve(publicDir, "vendor/libheif.wasm")).byteLength);
    // WebAssembly magic number: \0asm
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x00, 0x61, 0x73, 0x6d]);
  });

  it("serves exifr, and returns 404 for anything else under /vendor", async () => {
    expect((await makeApp().request("/vendor/exifr.mjs")).status).toBe(200);
    expect((await makeApp().request("/vendor/unknown.js")).status).toBe(404);
  });
});
