// Pure rules shared by tests and the page logic. The page does the same work in the browser.

export type DateSource = "metadata" | "file" | "today" | "manual";

/** Reads the camera's own date (EXIF DateTimeOriginal, raw form "2022:03:09 07:22:42"). Returns yyyy-mm-dd or null. */
export function parseRawExifDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4}):(\d{2}):(\d{2}) \d{2}:\d{2}:\d{2}$/.exec(raw.trim());
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const check = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** Date from the photo's own metadata first, then the file's date, then today. Each result says where it came from. */
export function chooseDate(input: { exifRaw?: unknown; fileDate?: Date | null; today: string }): { date: string; source: DateSource; warning: string | null } {
  const fromExif = parseRawExifDate(input.exifRaw);
  let result: { date: string; source: DateSource };
  if (fromExif) result = { date: fromExif, source: "metadata" };
  else if (input.fileDate && !Number.isNaN(input.fileDate.getTime())) result = { date: input.fileDate.toISOString().slice(0, 10), source: "file" };
  else result = { date: input.today, source: "today" };
  const year = Number(result.date.slice(0, 4));
  const warning = result.date > input.today ? "This date is in the future. Please check it." : year < 2000 ? "This date is before 2000. Please check it." : null;
  return { ...result, warning };
}

/** File types the app stores as originals. HEIC is what iPhones and Photos use by default. */
export const ORIGINAL_EXTENSIONS: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif" };

/** Some browsers send an empty type for HEIC, so the extension decides. */
export function inferImageType(name: string, mime: string): string | null {
  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/heic" || mime === "image/heif") return mime;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return ORIGINAL_EXTENSIONS[ext] ?? null;
}
