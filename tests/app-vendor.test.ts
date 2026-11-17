import { beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "../src/app.js";

// Regression: /vendor/* was not routed, so the HEIC decoder returned 404 in the browser.
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

  it("serves the HEIC decoder module and exifr, without a token", async () => {
    const mjs = await makeApp().request("/vendor/libheif.mjs");
    expect(mjs.status).toBe(200);
    expect(mjs.headers.get("content-type")).toContain("javascript");
    expect((await makeApp().request("/vendor/exifr.mjs")).status).toBe(200);
  });

  it("returns 404 for anything else under /vendor", async () => {
    expect((await makeApp().request("/vendor/unknown.js")).status).toBe(404);
    expect((await makeApp().request("/vendor/libheif.wasm")).status).toBe(404);
  });

  it("the vendored decoder reads a HEIC with the same calls the browser makes", async () => {
    const mod = await import(pathToFileURL(resolve(publicDir, "vendor/libheif.mjs")).href);
    const lib = await mod.default();
    const decoder = new lib.HeifDecoder();
    const images = decoder.decode(new Uint8Array(readFileSync(resolve(root, "tests/fixtures/gradient-64x48.heic"))));
    const image = images[0];
    expect(image).toBeDefined();
    const width = image.get_width(), height = image.get_height();
    expect([width, height]).toEqual([64, 48]);
    const data = new Uint8ClampedArray(width * height * 4);
    await new Promise<void>((resolveDisplay, reject) =>
      image.display({ data, width, height }, (out: unknown) => (out ? resolveDisplay() : reject(new Error("display failed")))));
    // Pixel (63, 47) of the gradient is about (252, 235, 128). Compression moves it slightly.
    const last = (47 * 64 + 63) * 4;
    expect(Math.abs(data[last]! - 252)).toBeLessThan(12);
    expect(Math.abs(data[last + 1]! - 235)).toBeLessThan(12);
    expect(Math.abs(data[last + 2]! - 128)).toBeLessThan(12);
    if (image.free) image.free();
  });
});
