import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import writeProtectionExtension from "./write-protection.ts";
import lifecycleExtension from "./lifecycle.ts";
import projectManageExtension from "./project-manage.ts";
import knowledgeQueryExtension from "./knowledge-query.ts";
import projectBaselineExtension from "./project-baseline.ts";
import requirementManageExtension from "./requirement-manage.ts";
import decisionRecordExtension from "./decision-record.ts";
import workflowExtension from "./workflow.ts";
import rulesExtension from "./rules.ts";
import agentManageExtension from "./agent-manage.ts";
import workflowManageExtension from "./workflow-manage.ts";
import relayExtension from "./relay.ts";
import agentsUiExtension from "./agents-ui.ts";
import shellUiExtension from "./shell-ui.ts";
import commandsExtension from "./commands.ts";

// pi 对目录内每个扩展文件各起一次 jiti 导入、模块实例互不共享；
// 单一入口用同一个 pi 依次调用各子扩展，才能让 lifecycle 等模块级共享状态在子扩展间保持同一份实例。
export default function registerExtensions(pi: ExtensionAPI): void {
  lifecycleExtension(pi);
  projectManageExtension(pi);
  projectBaselineExtension(pi);
  knowledgeQueryExtension(pi);
  requirementManageExtension(pi);
  decisionRecordExtension(pi);
  workflowExtension(pi);
  rulesExtension(pi);
  agentManageExtension(pi);
  workflowManageExtension(pi);
  relayExtension(pi);
  agentsUiExtension(pi);
  shellUiExtension(pi);
  writeProtectionExtension(pi);
  commandsExtension(pi);
}
