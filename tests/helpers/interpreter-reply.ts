import type { Context } from "@earendil-works/pi-ai";
import type { ControlledProvider, ScriptedReply } from "./controlled-provider.ts";

type ReviewContext = { candidate: { candidateId: string }; partition: { units: Array<{ id: string }> } };

function interpreterDocument(request: Context): ReviewContext | undefined {
  const content = request.messages[0]?.content;
  const text = typeof content === "string" ? content : (content as Array<{ text?: string }> | undefined)?.map((block) => block.text ?? "").join("");
  try { return (JSON.parse(text ?? "").context?.document as ReviewContext | undefined) ?? undefined; } catch { return undefined; }
}

/** 解释器的回复由它收到的候选与分区现算：编号由程序生成，测试事先不知道。 */
export function scriptReview(provider: ControlledProvider, build: (context: ReviewContext) => unknown,
  options: { chunkDelayMs?: number; otherwise?: ScriptedReply } = {}): void {
  provider.awaitReply = async (request) => {
    const document = interpreterDocument(request);
    if (!document) return options.otherwise;
    return { type: "text", text: JSON.stringify(build(document)), ...(options.chunkDelayMs === undefined ? {} : { chunkDelayMs: options.chunkDelayMs }) };
  };
}
