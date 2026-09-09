import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDecisionRecordTool, describeReceipt } from "../runtime/decision-record-tool.ts";

export { describeReceipt };

export default function decisionRecordExtension(pi: ExtensionAPI): void {
  pi.registerTool(createDecisionRecordTool());
}
