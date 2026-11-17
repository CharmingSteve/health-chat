import { describe, expect, it } from "vitest";
import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { analysisKeyFor } from "../src/photos.js";

// A thumbnail must cost key listings only. It must not read the photo records, or every thumbnail reads all of them.
function fakeS3(pages: Array<{ keys: string[]; truncated?: boolean }>) {
  const sent: unknown[] = [];
  let call = 0;
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      if (!(command instanceof ListObjectsV2Command)) throw new Error("only listings are allowed");
      const page = pages[call++]!;
      return { Contents: page.keys.map((Key) => ({ Key })), IsTruncated: page.truncated ?? false, NextContinuationToken: page.truncated ? "next" : undefined };
    },
  };
  return { client: client as unknown as S3Client, sent };
}

describe("analysisKeyFor", () => {
  it("finds the analysis key from the record name, across listing pages, without reading any record", async () => {
    const { client, sent } = fakeS3([
      { keys: ["meta/2025-05-01_aaaaaaaa.json"], truncated: true },
      { keys: ["meta/2026-11-10_bbbbbbbb.json"] },
    ]);
    expect(await analysisKeyFor(client, "bucket", "bbbbbbbb")).toBe("analysis/2026-11-10_bbbbbbbb.jpg");
    expect(sent).toHaveLength(2);
    expect(sent.every((c) => c instanceof ListObjectsV2Command)).toBe(true);
  });

  it("returns null for an unknown photo id", async () => {
    const { client } = fakeS3([{ keys: ["meta/2025-05-01_aaaaaaaa.json"] }]);
    expect(await analysisKeyFor(client, "bucket", "cccccccc")).toBeNull();
  });
});
