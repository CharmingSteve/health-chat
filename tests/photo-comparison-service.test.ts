import { afterEach, describe, expect, it, vi } from "vitest";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client } from "@aws-sdk/client-s3";
import { resolve } from "node:path";
import { createApp } from "../src/app.js";
import { photoService } from "../src/photo-service.js";
import { listPhotos, readBytes, validateMeta } from "../src/photos.js";

vi.mock("../src/photos.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/photos.js")>(),
  listPhotos: vi.fn(),
  readBytes: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

const record = (id: string, date: string) => validateMeta({
  id, date_taken: date, setting: "Example studio",
  original_key: `originals/${date}_${id}.jpg`,
  analysis_key: `analysis/${date}_${id}.jpg`,
}, "owner");

function setup() {
  const earlier = record("aaaaaaaa", "2025-01-01");
  const later = record("bbbbbbbb", "2026-01-01");
  const unselected = record("cccccccc", "2026-02-01");
  vi.mocked(listPhotos).mockReset().mockResolvedValue([later, unselected, earlier]);
  const bytes = new Map([
    [earlier.analysis_key, new Uint8Array([1, 2, 3])],
    [later.analysis_key, new Uint8Array([4, 5, 6])],
  ]);
  vi.mocked(readBytes).mockReset().mockImplementation(async (_client, _bucket, key) => {
    const image = bytes.get(key);
    if (!image) throw new Error("Only selected analysis copies may be read");
    return image;
  });
  const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockResolvedValue({
    output: { message: { role: "assistant", content: [{ text: "The photos show a change in posture." }] } },
  });
  const service = photoService({
    s3: new S3Client({ region: "us-east-1" }), photosBucket: "photos-test", modelId: "test-model",
  });
  return { service, send, earlier, later, bytes };
}

describe("selected uploaded photo comparison", () => {
  it("runs the real photo service through the route and sends only the selected analysis images, before text, in date order", async () => {
    const { service, send, earlier, later, bytes } = setup();
    const app = createApp({
      verify: async () => ({ sub: "owner", client_id: "test-client", token_use: "access" }),
      clientId: "test-client", converse: async () => "4", photos: service,
      browserConfig: { domain: "example", clientId: "test-client" },
      publicDir: resolve(import.meta.dirname, "..", "public"),
    });
    const response = await app.request("/api/photos/compare", {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [later.id, earlier.id] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ answer: "The photos show a change in posture." });
    expect(readBytes).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(ConverseCommand);
    if (!(command instanceof ConverseCommand)) throw new Error("Expected ConverseCommand");
    expect(command.input.modelId).toBe("test-model");
    const content = command.input.messages?.[0]?.content;
    expect(content?.slice(0, 2)).toEqual([
      { image: { format: "jpeg", source: { bytes: bytes.get(earlier.analysis_key) } } },
      { image: { format: "jpeg", source: { bytes: bytes.get(later.analysis_key) } } },
    ]);
    expect(content).toHaveLength(3);
    expect(content?.[2]?.text).toContain("Photo 1 taken 2025-01-01\nPhoto 2 taken 2026-01-01");
  });

  it.each([
    { ids: ["aaaaaaaa"], error: "at least two" },
    { ids: Array.from({ length: 9 }, (_, i) => `photoid${i}`), error: "at most 8" },
    { ids: ["aaaaaaaa", "aaaaaaaa"], error: "distinct" },
    { ids: ["aaaaaaaa", "../invalid"], error: "list of photo ids" },
  ])("rejects invalid selection $ids before reading S3 or calling Bedrock", async ({ ids, error }) => {
    const { service, send } = setup();
    await expect(service.compare({ ids })).rejects.toThrow(error);
    expect(listPhotos).not.toHaveBeenCalled();
    expect(readBytes).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("reports a missing photo without comparing a partial selection", async () => {
    const { service, send } = setup();
    await expect(service.compare({ ids: ["aaaaaaaa", "dddddddd"] })).rejects.toThrow("not found");
    expect(readBytes).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
