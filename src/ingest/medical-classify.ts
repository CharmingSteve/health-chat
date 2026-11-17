// Allowlist and file classification for the medical bucket. No side effects, so tests can import it.

/** The allowlist. A folder or file not listed here is never downloaded. */
export const ALLOWED_FOLDERS = ["blood-tests/", "broken-shoulder/", "cardiology/", "foot-x-ray/", "hernia/", "tests/", "פיזיאואקטיב-נובמבר-24/"];

export function isAllowedKey(key: string): boolean {
  if (!key.includes("/")) return true; // top-level file: the medical PDFs live here
  return ALLOWED_FOLDERS.some((folder) => key.startsWith(folder));
}

export type Kind = "pdf" | "image" | "dicom_candidate" | "lab_csv" | "skipped";

/** Classifies one key. Only the kind decides what is read; the name alone is never sent anywhere. */
export function classify(key: string): { kind: Kind; reason?: string } {
  if (!isAllowedKey(key)) return { kind: "skipped", reason: "not on the allowlist" };
  const name = key.split("/").pop() ?? key;
  if (name === ".DS_Store") return { kind: "skipped", reason: "system file" };
  const lower = name.toLowerCase();
  if (/^personlist( \(\d+\))?\.csv$/i.test(name) && key.startsWith("blood-tests/")) return { kind: "lab_csv" };
  if (lower.endsWith(".pdf")) return { kind: "pdf" };
  if (/\.(jpe?g|png)$/.test(lower)) return { kind: "image" };
  if (!name.includes(".")) return { kind: "dicom_candidate", reason: "no extension; checked as DICOM later" };
  return { kind: "skipped", reason: `not a data type (${lower.slice(lower.lastIndexOf("."))})` };
}
