import { answerQuestion, type ChatAnswer } from "./chat.js";
import { createChatModel } from "./bedrock.js";
import { FACTS_SQL, formatFacts } from "./facts.js";
import { athenaRunner } from "./query.js";

/** The one question path: verified figures + earlier turns + the question, through the model and the checked queries. */
export function makeAsk(opts: { modelId: string; workgroup: string; database: string; ownerNotes?: () => Promise<string> }) {
  const runQuery = athenaRunner({ workgroup: opts.workgroup, database: opts.database });
  return async (question: string, context: string): Promise<ChatAnswer> => {
    const block = formatFacts(await runQuery(FACTS_SQL));
    const notes = opts.ownerNotes ? await opts.ownerNotes().catch(() => "") : "";
    return answerQuestion(question, { callModel: createChatModel(opts.modelId), runQuery }, [block, notes, context].filter(Boolean).join("\n\n"));
  };
}
