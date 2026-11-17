import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ObjectStore } from "./diet-pipeline.js";

/** ObjectStore over S3. Writes use AES-256 (AWS-managed). There is no delete method: the app never removes objects. */
export function s3ObjectStore(client = new S3Client({})): ObjectStore {
  return {
    async list(bucket, prefix) {
      const out: { Key: string; ETag: string }[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const item of page.Contents ?? []) out.push({ Key: item.Key!, ETag: item.ETag ?? "" });
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async get(bucket, key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await response.Body!.transformToByteArray());
    },
    async put(bucket, key, body) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ServerSideEncryption: "AES256" }));
    },
  };
}
