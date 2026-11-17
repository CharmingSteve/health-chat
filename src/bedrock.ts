import { BedrockRuntimeClient, ConverseCommand, type Message } from "@aws-sdk/client-bedrock-runtime";

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

// ---- Tool-using chat (Converse with a query_data tool) --------------------------------------

import { systemPrompt, QUERY_TOOL, type CallModel, type ModelTurn } from "./chat.js";

/** Calls the configured model with the system prompt and the query tool, and maps the reply to a ModelTurn. */
export function createChatModel(modelId: string, client = new BedrockRuntimeClient({})): CallModel {
  return async (messages: Message[]): Promise<ModelTurn> => {
    const response = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: systemPrompt() }],
        messages,
        toolConfig: QUERY_TOOL,
        inferenceConfig: { maxTokens: 1200, temperature: 0 },
      }),
    );
    const blocks = response.output?.message?.content ?? [];
    const text = blocks.map((b) => ("text" in b && typeof b.text === "string" ? b.text : "")).join("").trim();
    const toolUses = blocks
      .map((b) => ("toolUse" in b ? b.toolUse : undefined))
      .filter((t): t is NonNullable<typeof t> => t !== undefined)
      .map((t) => ({ toolUseId: t.toolUseId ?? "", name: t.name ?? "", input: typeof t.input === "object" && t.input !== null && !Array.isArray(t.input) ? t.input : {} }));
    if (response.stopReason === "tool_use" && toolUses.length > 0) return { kind: "tool_use", text, toolUses };
    if (!text) throw new Error("Model returned no text");
    return { kind: "text", text };
  };
}
