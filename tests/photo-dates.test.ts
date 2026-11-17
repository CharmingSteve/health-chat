import { describe, expect, it } from "vitest";
import exifr from "exifr";
import { existsSync } from "node:fs";
import { chooseDate, inferImageType, parseRawExifDate } from "../src/photo-dates.js";

const TODAY = "2026-11-17";

describe("reading the camera's date", () => {
  it("parses the raw camera string as the local date, with no time-zone shift", () => {
    expect(parseRawExifDate("2022:03:09 07:22:42")).toBe("2022-03-09");
    expect(parseRawExifDate("2022:03:09 23:59:59")).toBe("2022-03-09");
  });
  it("refuses impossible or malformed dates", () => {
    expect(parseRawExifDate("2022:02:30 10:00:00")).toBeNull();
    expect(parseRawExifDate("2022-03-09")).toBeNull();
    expect(parseRawExifDate(undefined)).toBeNull();
  });
  // Runs only when EXIF_SAMPLE points at a real photo on your Mac (no personal photo is stored in the repo).
  const sample = process.env.EXIF_SAMPLE;
  it.skipIf(!sample || !existsSync(sample))("the library reads the capture date from a real photo (set EXIF_SAMPLE to run)", async () => {
    const raw = await exifr.parse(sample!, { pick: ["DateTimeOriginal"], reviveValues: false });
    expect(parseRawExifDate(raw?.DateTimeOriginal)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("choosing the date", () => {
  it("uses the photo's own date first, and says so", () => {
    expect(chooseDate({ exifRaw: "2022:03:09 07:22:42", fileDate: new Date("2026-01-01T00:00:00Z"), today: TODAY })).toEqual({ date: "2022-03-09", source: "metadata", warning: null });
  });
  it("falls back to the file's date, then to today", () => {
    expect(chooseDate({ fileDate: new Date("2024-06-01T12:00:00Z"), today: TODAY })).toMatchObject({ date: "2024-06-01", source: "file" });
    expect(chooseDate({ today: TODAY })).toEqual({ date: TODAY, source: "today", warning: null });
  });
  it("flags a future date and a date before 2000, without blocking them", () => {
    expect(chooseDate({ exifRaw: "2030:01:01 10:00:00", today: TODAY }).warning).toContain("future");
    expect(chooseDate({ exifRaw: "1990:01:01 10:00:00", today: TODAY }).warning).toContain("before 2000");
  });
});

describe("file types", () => {
  it("accepts HEIC when the browser sends no type but the extension says HEIC", () => {
    expect(inferImageType("IMG_0001.HEIC", "")).toBe("image/heic");
    expect(inferImageType("photo.jpg", "")).toBe("image/jpeg");
  });
  it("refuses other types", () => {
    expect(inferImageType("animation.gif", "image/gif")).toBeNull();
    expect(inferImageType("notes.pdf", "")).toBeNull();
  });
});
