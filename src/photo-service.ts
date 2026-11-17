import { S3Client } from "@aws-sdk/client-s3";
import { comparePhotos, type PhotoForModel } from "./compare.js";
import { analysisKey, isOriginalType, listPhotos, newPhotoId, originalKey, PHOTO_MAX_BYTES, readBytes, savePhotoMeta, todayIn, uploadForm, validateDateTaken, validateMeta, OWNER_TIMEZONE, type PhotoMeta } from "./photos.js";

export interface PhotoService {
  list(): Promise<PhotoMeta[]>;
  uploadForms(input: { date_taken?: unknown; original_type: unknown }): Promise<{ id: string; date_taken: string; original: unknown; analysis: unknown; max_bytes: number }>;
  save(input: unknown): Promise<PhotoMeta>;
  compare(input: { ids: unknown; question?: unknown }): Promise<string>;
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
      const original = await uploadForm(opts.s3, opts.photosBucket, originalKey(date, id, input.original_type), input.original_type);
      const analysis = await uploadForm(opts.s3, opts.photosBucket, analysisKey(date, id), "image/jpeg");
      return { id, date_taken: date, original, analysis, max_bytes: PHOTO_MAX_BYTES };
    },
    async save(input) {
      const meta = validateMeta({ ...(input as object), original_key: (input as Record<string, unknown>).original_key, analysis_key: (input as Record<string, unknown>).analysis_key }, "owner");
      await savePhotoMeta(opts.s3, opts.photosBucket, meta);
      return meta;
    },
    async compare(input) {
      if (!Array.isArray(input.ids) || input.ids.some((i) => typeof i !== "string")) throw new Error("ids must be a list of photo ids");
      const all = await listPhotos(opts.s3, opts.photosBucket);
      const chosen = all.filter((m) => (input.ids as string[]).includes(m.id));
      if (chosen.length !== (input.ids as string[]).length) throw new Error("Some photos were not found");
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
