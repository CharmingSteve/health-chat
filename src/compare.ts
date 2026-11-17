import { ConverseCommand, BedrockRuntimeClient, type ContentBlock, type Message } from "@aws-sdk/client-bedrock-runtime";

// Compares the owner's progress photos, in date order. The model gives visual estimates, labelled as such, and
// describes injuries it can see. It never presents an estimate as a measurement.

export const COMPARE_INSTRUCTIONS = [
  "You are comparing progress photos of one person, all taken by that person, in date order (earliest first).",
  "Rules:",
  "1. Give visual estimates, and label every estimate 'visual estimate'. Give a range and a confidence (low, medium, or high), and name what affects it (lighting, pose, camera distance, clothing).",
  "2. Describe visible differences between photos, in date order: posture, muscle definition, visible fat distribution, or visible swelling. Say when the photos are not comparable (different pose, light, or distance).",
  "3. Never present an estimate as a measurement. If the owner gave measured weights, use them as the reference and say which figures are measured.",
  "4. Injuries: describe what is visible (swelling, redness, bruising, bleeding, a wound). If you see heavy bleeding, a deformity, a wound that is deep or will not stop bleeding, numbness, or signs of infection, start your answer with 'Please seek urgent medical care now.'",
  "5. This is not a diagnosis. Keep the answer short and factual.",
  "6. First describe what is actually visible in each numbered photo, using its date, then compare. Do not invent body parts, marks, injuries, or changes. If an image is unclear or unavailable, say so instead of guessing. Do not infer water retention or a medical condition from appearance alone.",
].join("\n");

export interface PhotoForModel {
  date_taken: string;
  bytes: Uint8Array;
  type: "jpeg" | "png";
}

export function compareMessage(photos: PhotoForModel[], question: string, measuredWeights: string): Message {
  const content: ContentBlock[] = photos.map((photo) => ({ image: { format: photo.type, source: { bytes: photo.bytes } } }));
  const dates = photos.map((photo, i) => `Photo ${i + 1} taken ${photo.date_taken}`).join("\n");
  content.push({ text: `${COMPARE_INSTRUCTIONS}\n\nImages above, in order:\n${dates}\n\nOwner's question: ${question || "Compare these photos and describe the progress."}${measuredWeights ? `\n\nMeasured weights (from the owner's records): ${measuredWeights}` : ""}` });
  return { role: "user", content };
}

export const MAX_COMPARE_PHOTOS = 8;

export async function comparePhotos(
  photos: PhotoForModel[],
  question: string,
  measuredWeights: string,
  modelId: string,
  client = new BedrockRuntimeClient({}),
): Promise<string> {
  if (photos.length < 2) throw new Error("Choose at least two photos to compare");
  if (photos.length > MAX_COMPARE_PHOTOS) throw new Error(`Choose at most ${MAX_COMPARE_PHOTOS} photos`);
  const sorted = [...photos].sort((a, b) => (a.date_taken < b.date_taken ? -1 : a.date_taken > b.date_taken ? 1 : 0));
  const response = await client.send(new ConverseCommand({
    modelId,
    messages: [compareMessage(sorted, question, measuredWeights)],
    inferenceConfig: { maxTokens: 800, temperature: 0 },
  }));
  const text = (response.output?.message?.content ?? []).map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("").trim();
  if (!text) throw new Error("The model returned no text");
  return text;
}
