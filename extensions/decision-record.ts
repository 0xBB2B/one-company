import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export { describeReceipt } from "../runtime/decision-record-tool.ts";

/** 保留扩展加载入口，不注册自由写决定工具。 */
export default function decisionRecordExtension(_pi: ExtensionAPI): void {}
