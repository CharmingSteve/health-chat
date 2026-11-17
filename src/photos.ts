import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

// Progress photos. Originals keep their location and device data (the owner's choice). The copy sent to the model is
// made in the browser at a smaller size, which re-encodes the image and drops that data.
// Storage: originals/<date>_<id>.<ext>, analysis/<date>_<id>.jpg, meta/<date>_<id>.json. Nothing is deleted.

export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const OWNER_TIMEZONE = "Asia/Jerusalem";
const ORIGINAL_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png" };

export interface PhotoMeta {
  schema: 1;
  owner: string;
  id: string;
  date_taken: string; // yyyy-mm-dd, set by the owner (defaults to today)
  uploaded_at: string;
  setting: string | null;
  pose: string | null;
  note: string | null;
  original_key: string;
  analysis_key: string;
}

/** Today's date in the owner's timezone, as yyyy-mm-dd. */
export function todayIn(timezone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Accepts a real calendar date that is not in the future (in the owner's timezone). */
export function validateDateTaken(value: unknown, now: Date): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Date must be yyyy-mm-dd");
  const check = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== value) throw new Error("Not a real date");
  if (value > todayIn(OWNER_TIMEZONE, now)) throw new Error("The date is in the future");
  return value;
}

export function isValidPhotoId(value: string): boolean {
  return /^[A-Za-z0-9-]{8,64}$/.test(value);
}

export function newPhotoId(): string {
  return randomUUID();
}

export function originalKey(date: string, id: string, contentType: string): string {
  const ext = ORIGINAL_TYPES[contentType];
  if (!ext) throw new Error("Only jpg and png originals are accepted");
  return `originals/${date}_${id}.${ext}`;
}

export function analysisKey(date: string, id: string): string {
  return `analysis/${date}_${id}.jpg`;
}

export function metaKey(date: string, id: string): string {
  return `meta/${date}_${id}.json`;
}

/**
 * Presigned POST for one object. The size limit and content type are enforced by S3 itself, not by the browser.
 */
export async function uploadForm(client: S3Client, bucket: string, key: string, contentType: string) {
  return createPresignedPost(client, {
    Bucket: bucket,
    Key: key,
    Fields: { "Content-Type": contentType },
    Conditions: [["content-length-range", 1, PHOTO_MAX_BYTES], ["eq", "$Content-Type", contentType]],
    Expires: 300,
  });
}

export function validateMeta(input: unknown, owner: string): PhotoMeta {
  if (typeof input !== "object" || input === null) throw new Error("Not a photo record");
  const m = input as Record<string, unknown>;
  const text = (v: unknown, max: number) => (v === undefined || v === null || v === "" ? null : typeof v === "string" && v.length <= max ? v : (() => { throw new Error("Field too long or not text"); })());
  if (typeof m.id !== "string" || !isValidPhotoId(m.id)) throw new Error("Bad photo id");
  if (typeof m.original_key !== "string" || typeof m.analysis_key !== "string") throw new Error("Missing object keys");
  return {
    schema: 1,
    owner,
    id: m.id,
    date_taken: validateDateTaken(m.date_taken, new Date()),
    uploaded_at: new Date().toISOString(),
    setting: text(m.setting, 120),
    pose: text(m.pose, 120),
    note: text(m.note, 500),
    original_key: m.original_key,
    analysis_key: m.analysis_key,
  };
}

export async function savePhotoMeta(client: S3Client, bucket: string, meta: PhotoMeta): Promise<void> {
  // Both objects must already exist, so a record never points at a missing photo.
  for (const key of [meta.original_key, meta.analysis_key]) {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  }
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: metaKey(meta.date_taken, meta.id), Body: JSON.stringify(meta, null, 2), ContentType: "application/json", ServerSideEncryption: "AES256" }));
}

export async function listPhotos(client: S3Client, bucket: string): Promise<PhotoMeta[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "meta/", ContinuationToken: token }));
    for (const item of page.Contents ?? []) if (item.Key) keys.push(item.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const metas = await Promise.all(keys.map(async (key) => {
    const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await r.Body!.transformToString("utf8")) as PhotoMeta;
  }));
  return metas.sort((a, b) => (a.date_taken < b.date_taken ? -1 : a.date_taken > b.date_taken ? 1 : 0));
}

export async function readBytes(client: S3Client, bucket: string, key: string): Promise<Uint8Array> {
  const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return r.Body!.transformToByteArray();
}
