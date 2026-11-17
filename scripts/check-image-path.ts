import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createChatModel } from "../src/bedrock.js";
import { answerQuestion } from "../src/chat.js";
import { comparePhotos } from "../src/compare.js";
import { templateDefault } from "./lib.mjs";

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
function image(reversed = false): Uint8Array {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y += 1) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x += 1) {
      const o = y * (W * 3 + 1) + 1 + x * 3;
      if ((x < W / 2) !== reversed) { raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0; } else { raw[o] = 0; raw[o + 1] = 0; raw[o + 2] = 255; }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return new Uint8Array(png);
}
const modelId = process.env.BEDROCK_MODEL ?? templateDefault(readFileSync(new URL("../infra/template.yaml", import.meta.url), "utf8"), "BedrockModel");

const answer = await answerQuestion(
  "Describe this image in one short sentence: name the colour of each half.",
  {
    callModel: createChatModel(modelId),
    runQuery: async (sql) => ({ ok: false, columns: [], rows: [], row_count: 0, truncated: false, bytes_scanned: 0, sql_run: sql, error: "Queries are disabled for the synthetic image check" }),
  },
  "Verified diet figures are unavailable for this synthetic image check.",
  [{ format: "png", bytes: image() }],
);
console.log(JSON.stringify({ rounds: answer.rounds, queries: answer.queries.map((q) => q.sql.slice(0, 80)), answer: answer.answer.slice(0, 300) }));
assert.match(answer.answer, /\bred\b/i);
assert.match(answer.answer, /\bblue\b/i);

const comparison = await comparePhotos(
  [
    { date_taken: "2026-02-01", type: "png", bytes: image(true) },
    { date_taken: "2026-01-01", type: "png", bytes: image() },
  ],
  'These are synthetic colour panels, not body photos. For each date, report the left and right colours using exactly this format: "YYYY-MM-DD: left red, right blue" (substitute the colours you see). Then state what changed.',
  "",
  modelId,
);
console.log(JSON.stringify({ comparison }));
const plainComparison = comparison.replaceAll("**", "");
assert.match(plainComparison, /2026-01-01:\s*left red,\s*right blue/i);
assert.match(plainComparison, /2026-02-01:\s*left blue,\s*right red/i);

const panels = [
  { id: "panel-aaaaaaaa", date_taken: "2026-01-01", image: { format: "png" as const, bytes: image() } },
  { id: "panel-bbbbbbbb", date_taken: "2026-02-01", image: { format: "png" as const, bytes: image(true) } },
];
const photos = {
  list: async () => panels.map(({ id, date_taken }) => ({ id, date_taken, setting: "Synthetic panel", place: null })),
  load: async (ids: string[]) => panels.filter((panel) => ids.includes(panel.id)),
};
const followupQuestion = 'These are synthetic colour panels, not body photos. Using the attached images, reply with "2026-01-01: left red, right blue" and "2026-02-01: left blue, right red", substituting the colours you actually see.';
const runQuery = async (sql: string) => ({ ok: false, columns: [], rows: [], row_count: 0, truncated: false, bytes_scanned: 0, sql_run: sql, error: "Queries are disabled for the synthetic image check" });
const followup = await answerQuestion(followupQuestion, {
  callModel: createChatModel(modelId), runQuery, photos,
}, comparison, [], panels.map((panel) => panel.id));
console.log(JSON.stringify({ followup: followup.answer, photos_shown: followup.photos_shown }));
assert.match(followup.answer.replaceAll("**", ""), /2026-01-01:\s*left red,\s*right blue/i);
assert.match(followup.answer.replaceAll("**", ""), /2026-02-01:\s*left blue,\s*right red/i);
assert.deepEqual(followup.photos_shown, panels.map((panel) => panel.id));

let firstCall = true;
const liveModel = createChatModel(modelId);
const toolFollowup = await answerQuestion(followupQuestion, {
  callModel: async (messages) => {
    if (firstCall) {
      firstCall = false;
      return { kind: "tool_use", text: "", toolUses: [{ toolUseId: "synthetic-photos", name: "show_photos", input: { ids: panels.map((panel) => panel.id) } }] };
    }
    return liveModel(messages);
  },
  runQuery, photos,
}, "Synthetic image test; use show_photos to view the panels.");
console.log(JSON.stringify({ toolFollowup: toolFollowup.answer, photos_shown: toolFollowup.photos_shown }));
assert.match(toolFollowup.answer.replaceAll("**", ""), /2026-01-01:\s*left red,\s*right blue/i);
assert.match(toolFollowup.answer.replaceAll("**", ""), /2026-02-01:\s*left blue,\s*right red/i);
