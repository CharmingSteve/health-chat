import { answerQuestion } from "../src/chat.js";
import { createChatModel } from "../src/bedrock.js";
import { athenaRunner } from "../src/query.js";

// Runs one question through the same chat loop, model, and query checks as the deployed app, from this machine.
// Usage: AWS_PROFILE=click npx tsx scripts/ask-local.ts "your question"
const question = process.argv.slice(2).join(" ").trim();
if (!question) throw new Error("Give a question as the argument");
const modelId = process.env.BEDROCK_MODEL ?? "us.amazon.nova-2-lite-v1:0";
const answer = await answerQuestion(question, {
  callModel: createChatModel(modelId),
  runQuery: athenaRunner({ workgroup: "health-chat-data", database: "health_chat" }),
});
console.log(JSON.stringify(answer, null, 2));
