import { describe, expect, it } from "vitest";
import { classify, isAllowedKey } from "../src/ingest/medical-classify.js";

describe("medical allowlist", () => {
  it("allows the listed folders and top-level files", () => {
    expect(isAllowedKey("blood-tests/2024/PersonList (1).csv")).toBe(true);
    expect(isAllowedKey("foot-x-ray/DICOM/IMG0001")).toBe(true);
    expect(isAllowedKey("Salt urinary Medical_Document.pdf")).toBe(true);
  });
  it("refuses any folder that is not on the list, including other people's folders", () => {
    expect(isAllowedKey("other-person-folder/image1.jpeg")).toBe(false);
    expect(isAllowedKey("other-person-folder/report.pdf")).toBe(false);
    expect(isAllowedKey("some-new-folder/file.pdf")).toBe(false);
  });
});

describe("classify", () => {
  it("reads Clalit PersonList CSVs in blood-tests only", () => {
    expect(classify("blood-tests/2024/PersonList (1).csv").kind).toBe("lab_csv");
    expect(classify("blood-tests/2024/Master_Blood_Tests.csv").kind).toBe("skipped");
  });
  it("reads PDFs and images", () => {
    expect(classify("hernia/hernia referals.pdf").kind).toBe("pdf");
    expect(classify("cardiology/jan-2-24/scan.JPG").kind).toBe("image");
  });
  it("treats extension-less files as DICOM candidates", () => {
    expect(classify("foot-x-ray/DICOM/IM0001").kind).toBe("dicom_candidate");
  });
  it("skips installers, viewer binaries, and system files", () => {
    expect(classify("broken-shoulder/Onis25FreeEdition.msi").kind).toBe("skipped");
    expect(classify("broken-shoulder/viewer/LaunchPad.exe").kind).toBe("skipped");
    expect(classify("blood-tests/.DS_Store").kind).toBe("skipped");
  });
});
