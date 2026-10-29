import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import lifecycleExtension from "../../core/host/extension-lifecycle.ts";
import projectManageExtension from "../../modules/project-index/project-manage-extension.ts";
import knowledgeQueryExtension from "../../modules/project-index/knowledge-query-extension.ts";
import requirementManageExtension from "../../modules/interaction/requirement-manage-extension.ts";
import rulesExtension from "./rules.ts";
import agentManageExtension from "../../modules/explore/agent-manage-extension.ts";
import workflowManageExtension from "../../modules/delivery/workflow-manage-extension.ts";
import prototypeExtension from "../../modules/prototype/prototype-extension.ts";
import pmPanelExtension from "../../modules/panel/pm-panel-extension.ts";
import shellUiExtension from "../../modules/shell/shell-ui-extension.ts";
import commandsExtension from "./commands.ts";
import searchExclusionExtension from "../../modules/agents/search-exclusion-extension.ts";
import gitDeliveryExtension from "../../modules/delivery/git-delivery-extension.ts";
import { prototypeRecordsV8Step } from "../../modules/requirement/prototype-record-migration.ts";
import conventionsGuardExtension from "../../modules/verification/conventions-guard-extension.ts";

// pi 对目录内每个扩展文件各起一次 jiti 导入、模块实例互不共享；
// 单一入口用同一个 pi 依次调用各子扩展，才能让 lifecycle 等模块级共享状态在子扩展间保持同一份实例。
export default function registerExtensions(pi: ExtensionAPI): void {
  lifecycleExtension(pi, { databaseMigrationSteps: [prototypeRecordsV8Step] });
  projectManageExtension(pi);
  knowledgeQueryExtension(pi);
  requirementManageExtension(pi);
  rulesExtension(pi);
  agentManageExtension(pi);
  workflowManageExtension(pi);
  prototypeExtension(pi);
  pmPanelExtension(pi);
  shellUiExtension(pi);
  searchExclusionExtension(pi);
  conventionsGuardExtension(pi);
  gitDeliveryExtension(pi);
  commandsExtension(pi);
}
