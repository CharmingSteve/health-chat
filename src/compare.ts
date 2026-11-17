import { ConverseCommand, BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

// Compares the owner's progress photos, in date order. The model gives visual estimates, labelled as such, and
// describes injuries it can see. It never presents an estimate as a measurement.

export const COMPARE_INSTRUCTIONS = [
  "You are comparing progress photos of one person, all taken by that person, in date order (earliest first).",
  "Rules:",
  "1. Give visual estimates, and label every estimate 'visual estimate'. Give a range and a confidence (low, medium, or high), and name what affects it (lighting, pose, camera distance, clothing).",
  "2. Describe what changed between photos, in date order: posture, muscle definition, visible fat distribution, water or swelling in the body. Say when the photos are not comparable (different pose, light, or distance).",
  "3. Never present an estimate as a measurement. If the owner gave measured weights, use them as the reference and say which figures are measured.",
  "4. Injuries: describe what is visible (swelling, redness, bruising, bleeding, a wound). If you see heavy bleeding, a deformity, a wound that is deep or will not stop bleeding, numbness, or signs of infection, start your answer with 'Please seek urgent medical care now.'",
  "5. This is not a diagnosis. Keep the answer short and factual.",
].join("\n");

export interface PhotoForModel {
  date_taken: string;
  bytes: Uint8Array;
  type: "jpeg" | "png";
}

export function compareMessage(photos: PhotoForModel[], question: string, measuredWeights: string): { role: "user"; content: unknown[] } {
  const content: unknown[] = [{ text: `${COMPARE_INSTRUCTIONS}\n\nOwner's question: ${question || "Compare these photos and describe the progress."}${measuredWeights ? `\n\nMeasured weights (from the owner's records): ${measuredWeights}` : ""}` }];
  for (const photo of photos) {
    content.push({ text: `Photo taken ${photo.date_taken}:` });
    content.push({ image: { format: photo.type, source: { bytes: photo.bytes } } });
  }
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
    messages: [compareMessage(sorted, question, measuredWeights) as never],
    inferenceConfig: { maxTokens: 800, temperature: 0 },
  }));
  const text = (response.output?.message?.content ?? []).map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("").trim();
  if (!text) throw new Error("The model returned no text");
  return text;
}
