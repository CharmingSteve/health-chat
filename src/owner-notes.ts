import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

// The owner's stated typical pattern (for example weekend intake and burn). Stored in the tables bucket under notes/,
// written by the owner only. It is shown to the model as the owner's statement, never as measured data.

export const OWNER_NOTES_KEY = "notes/owner_patterns.json";

export interface OwnerPattern {
  weekday: string; // e.g. "Friday"
  typical_intake_kcal: number;
  typical_burn_kcal: number;
  note?: string;
}

export interface OwnerNotes {
  statement_date: string; // yyyy-mm-dd, when the owner wrote it
  stated_by: "owner";
  patterns: OwnerPattern[];
}

export function validateOwnerNotes(input: unknown): OwnerNotes {
  if (typeof input !== "object" || input === null) throw new Error("Owner notes must be an object");
  const n = input as Record<string, unknown>;
  if (typeof n.statement_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(n.statement_date)) throw new Error("statement_date must be yyyy-mm-dd");
  if (n.stated_by !== "owner") throw new Error("stated_by must be 'owner'");
  if (!Array.isArray(n.patterns) || n.patterns.length > 14) throw new Error("patterns must be a short list");
  const patterns = n.patterns.map((p: unknown) => {
    const x = p as Record<string, unknown>;
    if (typeof x.weekday !== "string" || typeof x.typical_intake_kcal !== "number" || typeof x.typical_burn_kcal !== "number") throw new Error("Bad pattern entry");
    return { weekday: x.weekday, typical_intake_kcal: x.typical_intake_kcal, typical_burn_kcal: x.typical_burn_kcal, ...(typeof x.note === "string" ? { note: x.note.slice(0, 300) } : {}) };
  });
  return { statement_date: n.statement_date, stated_by: "owner", patterns };
}

/** The block added to each question. Empty when there is no file, so the app still works without it. */
export function ownerNotesBlock(notes: OwnerNotes | null): string {
  if (!notes) return "";
  const lines = notes.patterns.map((p) => `- ${p.weekday}: typical intake about ${p.typical_intake_kcal} kcal, typical burn about ${p.typical_burn_kcal} kcal${p.note ? ` (${p.note})` : ""}`);
  return [
    `Owner-stated typical pattern (the owner's statement written ${notes.statement_date}; NOT measured, and never part of logged totals or averages):`,
    ...lines,
  ].join("\n");
}

export async function readOwnerNotes(client: S3Client, bucket: string): Promise<OwnerNotes | null> {
  try {
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: OWNER_NOTES_KEY }));
    return validateOwnerNotes(JSON.parse(await r.Body!.transformToString("utf8")));
  } catch (error) {
    if (error instanceof Error && error.name === "NoSuchKey") return null;
    throw error;
  }
}
