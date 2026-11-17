import { deflateSync } from "node:zlib";
import { createChatModel } from "../src/bedrock.js";
import { answerQuestion } from "../src/chat.js";

// Checks that the model really receives images in the chat: a generated test image (red left half, blue right half)
// whose answer can be checked. No personal photo is used.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const W = 200, H = 200;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  for (let x = 0; x < W; x += 1) {
    const o = y * (W * 3 + 1) + 1 + x * 3;
    if (x < W / 2) { raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0; } else { raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 255; }
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);

const answer = await answerQuestion(
  "Describe this image in one short sentence: name the colour of each half.",
  {
    callModel: createChatModel(process.env.BEDROCK_MODEL ?? "us.amazon.nova-2-lite-v1:0"),
    runQuery: async (sql) => ({ ok: false, columns: [], rows: [], row_count: 0, truncated: false, bytes_scanned: 0, sql_run: sql, error: "Queries are disabled for the synthetic image check" }),
  },
  "Verified diet figures are unavailable for this synthetic image check.",
  [{ format: "png", bytes: new Uint8Array(png) }],
);
console.log(JSON.stringify({ rounds: answer.rounds, queries: answer.queries.map((q) => q.sql.slice(0, 80)), answer: answer.answer.slice(0, 300) }));
