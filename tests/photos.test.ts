import { describe, expect, it } from "vitest";
import { analysisKey, isValidPhotoId, originalKey, todayIn, validateDateTaken, validateMeta, uploadForm, PHOTO_MAX_BYTES } from "../src/photos.js";
import { compareMessage, comparePhotos, COMPARE_INSTRUCTIONS } from "../src/compare.js";
import { ownerNotesBlock, validateOwnerNotes } from "../src/owner-notes.js";
import { S3Client } from "@aws-sdk/client-s3";

const NOW = new Date("2026-11-17T09:00:00.000Z"); // 11:00 in Asia/Jerusalem

describe("dates", () => {
  it("today is the owner's local date, not the UTC date", () => {
    expect(todayIn("Asia/Jerusalem", new Date("2026-11-17T22:30:00.000Z"))).toBe("2026-11-18");
    expect(todayIn("Asia/Jerusalem", NOW)).toBe("2026-11-17");
  });
  it("accepts a past date, and refuses a future date, a non-date, and bad text", () => {
    expect(validateDateTaken("2025-05-01", NOW)).toBe("2025-05-01");
    expect(() => validateDateTaken("2026-11-18", NOW)).toThrow("in the future");
    expect(() => validateDateTaken("2026-02-30", NOW)).toThrow("Not a real date");
    expect(() => validateDateTaken("17/11/2026", NOW)).toThrow("yyyy-mm-dd");
  });
});

describe("storage keys and ids", () => {
  it("keeps originals and analysis copies apart, and accepts jpg, png, and HEIC originals only", () => {
    expect(originalKey("2026-11-17", "abcdefgh", "image/jpeg")).toBe("originals/2026-11-17_abcdefgh.jpg");
    expect(analysisKey("2026-11-17", "abcdefgh")).toBe("analysis/2026-11-17_abcdefgh.jpg");
    expect(originalKey("2026-11-17", "abcdefgh", "image/heic")).toBe("originals/2026-11-17_abcdefgh.heic");
    expect(() => originalKey("2026-11-17", "abcdefgh", "image/gif")).toThrow("Only jpg, png, and HEIC");
  });
  it("accepts only plain photo ids", () => {
    expect(isValidPhotoId("abcdefgh-1234")).toBe(true);
    expect(isValidPhotoId("../../x")).toBe(false);
  });
});

describe("photo records", () => {
  const good = { id: "abcdefgh-1234", date_taken: "2026-11-10", setting: "gym", pose: "standing", note: null, original_key: "originals/2026-11-10_abcdefgh-1234.jpg", analysis_key: "analysis/2026-11-10_abcdefgh-1234.jpg" };
  it("keeps the owner's date, setting, and note", () => {
    expect(validateMeta(good, "owner")).toMatchObject({ date_taken: "2026-11-10", setting: "gym", note: null, owner: "owner" });
  });
  it("keeps the location of the original, and rejects a location out of range", () => {
    expect(validateMeta({ ...good, location: { lat: 31.7461234, lon: 35.2199999 } }, "owner").location).toEqual({ lat: 31.746123, lon: 35.22 });
    expect(validateMeta({ ...good }, "owner").location).toBeNull();
    expect(() => validateMeta({ ...good, location: { lat: 95, lon: 0 } }, "owner")).toThrow("out of range");
  });
  it("refuses a record with a bad id, missing keys, or a long note", () => {
    expect(() => validateMeta({ ...good, id: "x" }, "owner")).toThrow("Bad photo id");
    expect(() => validateMeta({ ...good, analysis_key: undefined }, "owner")).toThrow("Missing object keys");
    expect(() => validateMeta({ ...good, note: "x".repeat(501) }, "owner")).toThrow("too long");
  });
  it("creates an upload form that S3 limits to the size cap and the declared type", async () => {
    const client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "secret" } });
    const form = await uploadForm(client, "bucket-x", "originals/2026-11-10_abcdefgh.jpg", "image/jpeg");
    expect(form.fields["Content-Type"]).toBe("image/jpeg");
    expect(JSON.stringify(form.fields)).not.toContain("secret");
    expect(form.url).toContain("bucket-x");
    expect(PHOTO_MAX_BYTES).toBe(10485760);
  });
});

describe("comparison", () => {
  const photo = (date: string) => ({ date_taken: date, bytes: new Uint8Array([1, 2, 3]), type: "jpeg" as const });
  it("puts every image before the text, maps their dates, and keeps the rules", () => {
    const msg = compareMessage([photo("2026-11-10"), photo("2026-09-01")], "compare", "");
    expect(msg.content).toHaveLength(3);
    expect(msg.content?.slice(0, 2).every((block) => block.image !== undefined)).toBe(true);
    const texts = msg.content?.[2]?.text ?? "";
    expect(texts).toContain("Photo 1 taken 2026-11-10\nPhoto 2 taken 2026-09-01");
    expect(texts).toContain("label every estimate 'visual estimate'");
    expect(texts).toContain("Please seek urgent medical care now.");
    expect(texts).toContain("Do not invent");
    expect(COMPARE_INSTRUCTIONS).toContain("Never present an estimate as a measurement");
  });
  it("refuses fewer than two or more than eight photos before calling the model", async () => {
    await expect(comparePhotos([photo("2026-11-10")], "", "", "m")).rejects.toThrow("at least two");
    const nine = Array.from({ length: 9 }, (_, i) => photo(`2026-01-0${(i % 9) + 1}`));
    await expect(comparePhotos(nine, "", "", "m")).rejects.toThrow("at most 8");
  });
});

describe("owner pattern note", () => {
  const notes = validateOwnerNotes({
    statement_date: "2026-11-17", stated_by: "owner",
    patterns: [{ weekday: "Friday", typical_intake_kcal: 4000, typical_burn_kcal: 3200 }],
  });
  it("is shown as the owner's statement, not as measured data", () => {
    const block = ownerNotesBlock(notes);
    expect(block).toContain("NOT measured");
    expect(block).toContain("never part of logged totals");
    expect(block).toContain("Friday: typical intake about 4000 kcal");
  });
  it("is empty when there is no file, so the app works without it", () => {
    expect(ownerNotesBlock(null)).toBe("");
  });
  it("refuses a file that is not written by the owner", () => {
    expect(() => validateOwnerNotes({ statement_date: "2026-11-17", stated_by: "app", patterns: [] })).toThrow("stated_by");
  });
});

describe("today in the page", () => {
  it("the page default uses the browser's local date format", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("../public/app.js", import.meta.url), "utf8")).toContain('toLocaleDateString("en-CA")');
  });
});
