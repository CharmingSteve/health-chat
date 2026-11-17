import { makeAsk } from "../src/ask.js";

// Runs one question through the same path as the deployed app, from this machine.
// Usage: AWS_PROFILE=click AWS_REGION=us-east-1 npx tsx scripts/ask-local.ts "your question"
const question = process.argv.slice(2).join(" ").trim();
if (!question) throw new Error("Give a question as the argument");
const ask = makeAsk({ modelId: process.env.BEDROCK_MODEL ?? "us.amazon.nova-2-lite-v1:0", workgroup: "health-chat-data", database: "health_chat" });
console.log(JSON.stringify(await ask(question, ""), null, 2));
