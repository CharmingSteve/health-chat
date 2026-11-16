import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

// One Bedrock call path for the whole app. The model comes only from BEDROCK_MODEL,
// which CloudFormation sets from the BedrockModel parameter (one place to change it).

export type Converse = (prompt: string) => Promise<string>;

export function createConverse(modelId: string, client = new BedrockRuntimeClient({})): Converse {
  return async (prompt: string): Promise<string> => {
    const response = await client.send(
      new ConverseCommand({
        modelId,
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 200, temperature: 0 },
      }),
    );
    const text = response.output?.message?.content?.find((block) => "text" in block)?.text;
    if (typeof text !== "string") throw new Error("Bedrock returned no text");
    return text;
  };
}

/** The smoke prompt has one correct answer, so the check is exact rather than "looks plausible". */
export const SMOKE_PROMPT = "Reply with only the digit 4 and nothing else.";

export function smokeReplyIsCorrect(reply: string): boolean {
  return reply.trim() === "4";
}
