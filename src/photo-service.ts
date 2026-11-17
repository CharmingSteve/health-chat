import { S3Client } from "@aws-sdk/client-s3";
import { comparePhotos, MAX_COMPARE_PHOTOS, type PhotoForModel } from "./compare.js";
import type { PhotoAccess } from "./chat.js";
import { analysisKey, analysisKeyFor, isOriginalType, isValidPhotoId, listPhotos, newPhotoId, originalKey, PHOTO_MAX_BYTES, readBytes, savePhotoMeta, todayIn, uploadForm, validateDateTaken, validateMeta, OWNER_TIMEZONE, type PhotoMeta } from "./photos.js";

export const PHOTO_COMPARE_ENABLED = true;

export class PhotoComparePausedError extends Error {
  constructor() {
    super("Photo comparison is paused while its answers are being checked");
    this.name = "PhotoComparePausedError";
  }
}

export interface PhotoService {
  list(): Promise<PhotoMeta[]>;
  uploadForms(input: { date_taken?: unknown; original_type: unknown }): Promise<{ id: string; date_taken: string; original: unknown; analysis: unknown; max_bytes: number }>;
  save(input: unknown): Promise<PhotoMeta>;
  compare(input: { ids: unknown; question?: unknown }): Promise<string>;
  /** The small analysis copy for a thumbnail. It carries no location. */
  thumb(id: string): Promise<Uint8Array>;
}

/** Real service over S3 and Bedrock. Every date defaults to today, in the owner's timezone, unless a date is given. */
export function photoService(opts: { s3: S3Client; photosBucket: string; modelId: string; now?: () => Date }): PhotoService {
  const now = opts.now ?? (() => new Date());
  return {
    async list() {
      return listPhotos(opts.s3, opts.photosBucket);
    },
    async uploadForms(input) {
      const date = input.date_taken === undefined || input.date_taken === "" ? todayIn(OWNER_TIMEZONE, now()) : validateDateTaken(input.date_taken, now());
      if (typeof input.original_type !== "string" || !isOriginalType(input.original_type)) throw new Error("Only jpg, png, and HEIC originals are accepted");
      const id = newPhotoId();
      // The browser reads each object's key from the top level of its form. A presigned POST keeps the key only inside
      // its fields, so the key is returned explicitly here.
      const originalObjectKey = originalKey(date, id, input.original_type);
      const analysisObjectKey = analysisKey(date, id);
      const original = { ...(await uploadForm(opts.s3, opts.photosBucket, originalObjectKey, input.original_type)), key: originalObjectKey };
      const analysis = { ...(await uploadForm(opts.s3, opts.photosBucket, analysisObjectKey, "image/jpeg")), key: analysisObjectKey };
      return { id, date_taken: date, original, analysis, max_bytes: PHOTO_MAX_BYTES };
    },
    async save(input) {
      const meta = validateMeta({ ...(input as object), original_key: (input as Record<string, unknown>).original_key, analysis_key: (input as Record<string, unknown>).analysis_key }, "owner");
      await savePhotoMeta(opts.s3, opts.photosBucket, meta);
      return meta;
    },
    async thumb(id) {
      const key = await analysisKeyFor(opts.s3, opts.photosBucket, id);
      if (!key) throw new Error("Photo not found");
      return readBytes(opts.s3, opts.photosBucket, key);
    },
    async compare(input) {
      if (!PHOTO_COMPARE_ENABLED) throw new PhotoComparePausedError();
      const ids = input.ids;
      if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string" && isValidPhotoId(id))) throw new Error("ids must be a list of photo ids");
      if (ids.length < 2) throw new Error("Choose at least two photos to compare");
      if (ids.length > MAX_COMPARE_PHOTOS) throw new Error(`Choose at most ${MAX_COMPARE_PHOTOS} photos`);
      if (new Set(ids).size !== ids.length) throw new Error("Choose distinct photos to compare");
      const all = await listPhotos(opts.s3, opts.photosBucket);
      const chosen = all.filter((m) => ids.includes(m.id));
      if (chosen.length !== ids.length) throw new Error("Some photos were not found");
      const photos: PhotoForModel[] = [];
      for (const m of chosen) {
        // The analysis copy has no location data; the original is not sent to the model.
        photos.push({ date_taken: m.date_taken, bytes: await readBytes(opts.s3, opts.photosBucket, m.analysis_key), type: "jpeg" });
      }
      // Measured weights from stuntman-diet are added here once the readings are imported.
      return comparePhotos(photos, typeof input.question === "string" ? input.question : "", "", opts.modelId);
    },
  };
}

/** Photos for the chat: list them, and load chosen ones as small analysis copies (no location in the image). */
export function chatPhotoAccess(s3: S3Client, bucket: string): PhotoAccess {
  return {
    async list() {
      return (await listPhotos(s3, bucket)).map((m) => ({
        id: m.id,
        date_taken: m.date_taken,
        setting: m.setting,
        place: m.location ? `${m.location.lat.toFixed(3)}, ${m.location.lon.toFixed(3)}` : null,
      }));
    },
    async load(ids) {
      if (ids.length === 0 || ids.length > MAX_COMPARE_PHOTOS || ids.some((id) => !isValidPhotoId(id)) || new Set(ids).size !== ids.length) throw new Error(`Choose 1 to ${MAX_COMPARE_PHOTOS} distinct photo ids`);
      const all = await listPhotos(s3, bucket);
      const chosen = all.filter((m) => ids.includes(m.id));
      if (chosen.length !== ids.length) throw new Error("Some photos were not found");
      const loaded = [];
      for (const m of chosen) {
        loaded.push({ id: m.id, date_taken: m.date_taken, setting: m.setting, image: { format: "jpeg" as const, bytes: await readBytes(s3, bucket, m.analysis_key) } });
      }
      return loaded;
    },
  };
}
