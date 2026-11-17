import { describe, expect, it } from "vitest";
import { S3Client } from "@aws-sdk/client-s3";
import { photoService } from "../src/photo-service.js";

// Regression: the browser reads forms.original.key and forms.analysis.key. A presigned POST has no top-level key,
// so every upload failed with "Missing object keys" before any record was saved.
describe("upload forms carry the object keys the browser saves", () => {
  const s3 = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "secret" } });
  const service = photoService({ s3, photosBucket: "bucket-x", modelId: "test", now: () => new Date("2026-11-17T09:00:00.000Z") });

  it("returns a top-level key for the original and the analysis copy, matching the form's own key field", async () => {
    const forms = await service.uploadForms({ date_taken: "2025-05-01", original_type: "image/jpeg" });
    const original = forms.original as { key: string; fields: Record<string, string> };
    const analysis = forms.analysis as { key: string; fields: Record<string, string> };
    expect(original.key).toMatch(/^originals\/2025-05-01_[^/]+\.jpg$/);
    expect(original.key).toBe(original.fields.key);
    expect(analysis.key).toMatch(/^analysis\/2025-05-01_[^/]+\.jpg$/);
    expect(analysis.key).toBe(analysis.fields.key);
  });

  it("keeps the presigned url and the content-type limit", async () => {
    const forms = await service.uploadForms({ date_taken: "2025-05-01", original_type: "image/png" });
    const original = forms.original as { url: string; fields: Record<string, string> };
    expect(original.url).toContain("bucket-x");
    expect(original.fields["Content-Type"]).toBe("image/png");
  });
});
