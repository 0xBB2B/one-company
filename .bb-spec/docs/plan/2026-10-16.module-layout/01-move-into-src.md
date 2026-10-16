---
name: move-into-src
description: 按对照表把 155 个源文件搬进 src/core、src/modules、src/app，改写所有路径，包照常安装运行
---
# 按模块搬进 src/
## 目标
所有源文件按功能放进 `src/core/<名>/`、`src/modules/<名>/`、`src/app/<extension|daemon>/`，仓库根上不再有 `runtime/`、`extensions/`、`daemon/`；包照常安装、加载、运行，行为不变。

## 业务规则（来源：PRD move-into-src）
- 一个功能的全部源文件只在一个目录里。目录和内容：
  - `src/core/policy`：内容和权限规则、时钟、文字清洗。
  - `src/core/exec`：外部命令报错格式、读 git、目标分支、git 快照、分支保护、安装前检查 git。
  - `src/core/storage`：本机数据库、数据目录、本机身份、操作日志。
  - `src/core/host`：主窗口生命周期、守护进程客户端、通信格式、程序窗口、底部面板、后台 shell 登记表、网络暂停。
  - `src/modules/agents`、`requirement`、`prototype`、`verification`、`explore`、`settings`、`pm`、`delivery`、`panel`、`interaction`、`project-index`、`shell`：各自功能的全部代码，包括原来 `extensions/` 下的主窗口注册代码和 `daemon/` 下的守护进程代码。
  - `src/app/extension`：pi 入口、命令注册、主会话规则。`src/app/daemon`：守护进程的启动、加载器、生命周期、运行管理、PM 工具注册、启动配置、通信服务端、项目索引在守护进程里的宿主。
- `src/` 下每个 `.ts`、`.mjs` 都在上面某个目录里；仓库根上没有 `runtime/`、`extensions/`、`daemon/`。
- 包照常工作：pi 从 `package.json` 找到入口并加载；守护进程能启动；随包分发的角色定义（`agents/`）、技能（`skills/`）、语法解析资源（`resources/tree-sitter/`）、守护进程启动脚本、项目索引规则文件在新位置都能找到；安装前的 git 检查照常执行。
- 不改行为：除了 import 路径和按自身位置拼的相对路径，函数体一个字不改。
- 现有测试只改路径（import 路径、文件路径字符串、目录名字符串）。会扫描源码目录的测试改成递归扫描 `src/`，扫到的源文件数不少于搬家前（`tests/error-advice-coverage.test.ts` 搬家前扫 `runtime/` 下 124 个 `.ts`）。
- 在新路径上 `git log --follow`、`git log -L :<函数名>:<新路径>` 能查到搬家之前的提交。

## 涉及文件
- 移动：对照表里的 155 个文件（旧目录随之删除）
- 修改：`package.json`、`tsconfig.json`；按自身位置拼路径的 6 个源文件；`tests/` 下引用旧路径的测试和辅助文件（只改路径）
- 新建：`tests/module-layout.test.ts`

## 成品定义：文件对照表
从 `extensions/` 搬进模块的文件统一加 `-extension` 后缀（和已有测试文件名 `*-extension.test.ts` 一致，也避免和同模块里的同名逻辑文件重名）；`extensions/lifecycle.ts` 改名 `extension-lifecycle.ts`，避免和守护进程的 `lifecycle.ts` 混淆。

| 旧路径 | 新路径 |
|---|---|
| `daemon/bootstrap.mjs` | `src/app/daemon/bootstrap.mjs` |
| `daemon/lifecycle.ts` | `src/app/daemon/lifecycle.ts` |
| `daemon/loader.d.mts` | `src/app/daemon/loader.d.mts` |
| `daemon/loader.mjs` | `src/app/daemon/loader.mjs` |
| `daemon/main.ts` | `src/app/daemon/main.ts` |
| `daemon/pm-tools.ts` | `src/app/daemon/pm-tools.ts` |
| `daemon/project-index-host.ts` | `src/app/daemon/project-index-host.ts` |
| `daemon/project-index-requirements.ts` | `src/app/daemon/project-index-requirements.ts` |
| `daemon/run-manager.ts` | `src/app/daemon/run-manager.ts` |
| `daemon/sdk.ts` | `src/app/daemon/sdk.ts` |
| `daemon/server.ts` | `src/app/daemon/server.ts` |
| `runtime/daemon-startup-config.ts` | `src/app/daemon/daemon-startup-config.ts` |
| `extensions/commands.ts` | `src/app/extension/commands.ts` |
| `extensions/index.ts` | `src/app/extension/index.ts` |
| `extensions/rules.ts` | `src/app/extension/rules.ts` |
| `runtime/branch-guard.ts` | `src/core/exec/branch-guard.ts` |
| `runtime/git-prerequisite.mjs` | `src/core/exec/git-prerequisite.mjs` |
| `runtime/git-read.ts` | `src/core/exec/git-read.ts` |
| `runtime/git-snapshot.ts` | `src/core/exec/git-snapshot.ts` |
| `runtime/target-branch.ts` | `src/core/exec/target-branch.ts` |
| `runtime/tool-failure.ts` | `src/core/exec/tool-failure.ts` |
| `runtime/tool-request.ts` | `src/core/exec/tool-request.ts` |
| `extensions/lifecycle.ts` | `src/core/host/extension-lifecycle.ts` |
| `runtime/daemon-auth.ts` | `src/core/host/daemon-auth.ts` |
| `runtime/daemon-client.ts` | `src/core/host/daemon-client.ts` |
| `runtime/dock.ts` | `src/core/host/dock.ts` |
| `runtime/network-pause.ts` | `src/core/host/network-pause.ts` |
| `runtime/protocol.ts` | `src/core/host/protocol.ts` |
| `runtime/question-window.ts` | `src/core/host/question-window.ts` |
| `runtime/shell-registry.ts` | `src/core/host/shell-registry.ts` |
| `runtime/clock.ts` | `src/core/policy/clock.ts` |
| `runtime/content-policy.ts` | `src/core/policy/content-policy.ts` |
| `runtime/core-permissions.ts` | `src/core/policy/core-permissions.ts` |
| `runtime/ranges.ts` | `src/core/policy/ranges.ts` |
| `runtime/text-sanitize.ts` | `src/core/policy/text-sanitize.ts` |
| `runtime/data-root.ts` | `src/core/storage/data-root.ts` |
| `runtime/database-maintenance.ts` | `src/core/storage/database-maintenance.ts` |
| `runtime/database-paths.ts` | `src/core/storage/database-paths.ts` |
| `runtime/database-recovery.ts` | `src/core/storage/database-recovery.ts` |
| `runtime/database.ts` | `src/core/storage/database.ts` |
| `runtime/identity.ts` | `src/core/storage/identity.ts` |
| `runtime/operation-log.ts` | `src/core/storage/operation-log.ts` |
| `runtime/store.ts` | `src/core/storage/store.ts` |
| `runtime/strict-json.ts` | `src/core/storage/strict-json.ts` |
| `runtime/transaction-context.ts` | `src/core/storage/transaction-context.ts` |
| `daemon/agent-session.ts` | `src/modules/agents/agent-session.ts` |
| `extensions/search-exclusion.ts` | `src/modules/agents/search-exclusion-extension.ts` |
| `runtime/agent-copy.ts` | `src/modules/agents/agent-copy.ts` |
| `runtime/agent-resolve.ts` | `src/modules/agents/agent-resolve.ts` |
| `runtime/mcp.ts` | `src/modules/agents/mcp.ts` |
| `runtime/model-ref.ts` | `src/modules/agents/model-ref.ts` |
| `runtime/package-rules.ts` | `src/modules/agents/package-rules.ts` |
| `runtime/role-tools.ts` | `src/modules/agents/role-tools.ts` |
| `runtime/roles.ts` | `src/modules/agents/roles.ts` |
| `runtime/run-metadata.ts` | `src/modules/agents/run-metadata.ts` |
| `runtime/run-store.ts` | `src/modules/agents/run-store.ts` |
| `runtime/search-exclusion.ts` | `src/modules/agents/search-exclusion.ts` |
| `runtime/session-records.ts` | `src/modules/agents/session-records.ts` |
| `extensions/git-delivery.ts` | `src/modules/delivery/git-delivery-extension.ts` |
| `extensions/workflow-manage.ts` | `src/modules/delivery/workflow-manage-extension.ts` |
| `runtime/git-delivery.ts` | `src/modules/delivery/git-delivery.ts` |
| `runtime/workflow-close.ts` | `src/modules/delivery/workflow-close.ts` |
| `runtime/workflow-manage.ts` | `src/modules/delivery/workflow-manage.ts` |
| `runtime/workspace-manage.ts` | `src/modules/delivery/workspace-manage.ts` |
| `extensions/agent-manage.ts` | `src/modules/explore/agent-manage-extension.ts` |
| `runtime/explore-contracts.ts` | `src/modules/explore/explore-contracts.ts` |
| `runtime/explore-dispatch.ts` | `src/modules/explore/explore-dispatch.ts` |
| `runtime/explore-session.ts` | `src/modules/explore/explore-session.ts` |
| `runtime/web-access.ts` | `src/modules/explore/web-access.ts` |
| `extensions/requirement-manage.ts` | `src/modules/interaction/requirement-manage-extension.ts` |
| `runtime/ask-question.ts` | `src/modules/interaction/ask-question.ts` |
| `runtime/interaction-derivation.ts` | `src/modules/interaction/interaction-derivation.ts` |
| `runtime/main-intake-interaction.ts` | `src/modules/interaction/main-intake-interaction.ts` |
| `runtime/main-requirement-interaction.ts` | `src/modules/interaction/main-requirement-interaction.ts` |
| `runtime/mention-completion.ts` | `src/modules/interaction/mention-completion.ts` |
| `runtime/requirement-manage-tool.ts` | `src/modules/interaction/requirement-manage-tool.ts` |
| `runtime/user-interact-tool.ts` | `src/modules/interaction/user-interact-tool.ts` |
| `runtime/user-interaction-model.ts` | `src/modules/interaction/user-interaction-model.ts` |
| `runtime/user-interaction.ts` | `src/modules/interaction/user-interaction.ts` |
| `extensions/pm-panel.ts` | `src/modules/panel/pm-panel-extension.ts` |
| `runtime/adjudication.ts` | `src/modules/panel/adjudication.ts` |
| `runtime/decision-packet.ts` | `src/modules/panel/decision-packet.ts` |
| `runtime/panel-item-ask.ts` | `src/modules/panel/panel-item-ask.ts` |
| `runtime/pm-overview.ts` | `src/modules/panel/pm-overview.ts` |
| `runtime/pm-panel.ts` | `src/modules/panel/pm-panel.ts` |
| `daemon/subagent-tools.ts` | `src/modules/pm/subagent-tools.ts` |
| `runtime/plan-manage.ts` | `src/modules/pm/plan-manage.ts` |
| `runtime/pm-attention.ts` | `src/modules/pm/pm-attention.ts` |
| `runtime/pm-commit.ts` | `src/modules/pm/pm-commit.ts` |
| `runtime/pm-event-delivery.ts` | `src/modules/pm/pm-event-delivery.ts` |
| `runtime/pm-intake-contracts.ts` | `src/modules/pm/pm-intake-contracts.ts` |
| `runtime/pm-intake-runtime.ts` | `src/modules/pm/pm-intake-runtime.ts` |
| `runtime/pm-intake-service.ts` | `src/modules/pm/pm-intake-service.ts` |
| `runtime/pm-intake-store.ts` | `src/modules/pm/pm-intake-store.ts` |
| `runtime/pm-sync.ts` | `src/modules/pm/pm-sync.ts` |
| `runtime/requirement-read-tool.ts` | `src/modules/pm/requirement-read-tool.ts` |
| `runtime/result-submit.ts` | `src/modules/pm/result-submit.ts` |
| `runtime/task-dispatch.ts` | `src/modules/pm/task-dispatch.ts` |
| `runtime/verdicts.ts` | `src/modules/pm/verdicts.ts` |
| `runtime/verification-run.ts` | `src/modules/pm/verification-run.ts` |
| `extensions/knowledge-query.ts` | `src/modules/project-index/knowledge-query-extension.ts` |
| `extensions/project-manage.ts` | `src/modules/project-index/project-manage-extension.ts` |
| `runtime/code-extractor.ts` | `src/modules/project-index/code-extractor.ts` |
| `runtime/index-store.ts` | `src/modules/project-index/index-store.ts` |
| `runtime/knowledge-query-contracts.ts` | `src/modules/project-index/knowledge-query-contracts.ts` |
| `runtime/knowledge-query-tool.ts` | `src/modules/project-index/knowledge-query-tool.ts` |
| `runtime/knowledge-query.ts` | `src/modules/project-index/knowledge-query.ts` |
| `runtime/project-index-policy.ts` | `src/modules/project-index/project-index-policy.ts` |
| `runtime/project-index-service.ts` | `src/modules/project-index/project-index-service.ts` |
| `runtime/project-maintenance.ts` | `src/modules/project-index/project-maintenance.ts` |
| `runtime/project-manage-tool.ts` | `src/modules/project-index/project-manage-tool.ts` |
| `runtime/syntax-parser.ts` | `src/modules/project-index/syntax-parser.ts` |
| `extensions/prototype.ts` | `src/modules/prototype/prototype-extension.ts` |
| `runtime/prototype-dispatch.ts` | `src/modules/prototype/prototype-dispatch.ts` |
| `runtime/prototype-windows.ts` | `src/modules/prototype/prototype-windows.ts` |
| `runtime/approval-manifest-store.ts` | `src/modules/requirement/approval-manifest-store.ts` |
| `runtime/approval-manifest.ts` | `src/modules/requirement/approval-manifest.ts` |
| `runtime/host-authorization.ts` | `src/modules/requirement/host-authorization.ts` |
| `runtime/interaction-continuity.ts` | `src/modules/requirement/interaction-continuity.ts` |
| `runtime/prod-storage.ts` | `src/modules/requirement/prod-storage.ts` |
| `runtime/prod-view.ts` | `src/modules/requirement/prod-view.ts` |
| `runtime/requirement-backup.ts` | `src/modules/requirement/requirement-backup.ts` |
| `runtime/requirement-contracts.ts` | `src/modules/requirement/requirement-contracts.ts` |
| `runtime/requirement-coordination.ts` | `src/modules/requirement/requirement-coordination.ts` |
| `runtime/requirement-doc.ts` | `src/modules/requirement/requirement-doc.ts` |
| `runtime/requirement-events.ts` | `src/modules/requirement/requirement-events.ts` |
| `runtime/requirement-identity.ts` | `src/modules/requirement/requirement-identity.ts` |
| `runtime/requirement-manage-contracts.ts` | `src/modules/requirement/requirement-manage-contracts.ts` |
| `runtime/requirement-operations.ts` | `src/modules/requirement/requirement-operations.ts` |
| `runtime/requirement-prototype-revisions.ts` | `src/modules/requirement/requirement-prototype-revisions.ts` |
| `runtime/requirement-prototypes.ts` | `src/modules/requirement/requirement-prototypes.ts` |
| `runtime/requirement-recovery.ts` | `src/modules/requirement/requirement-recovery.ts` |
| `runtime/requirement-service.ts` | `src/modules/requirement/requirement-service.ts` |
| `runtime/requirement-state.md` | `src/modules/requirement/requirement-state.md` |
| `runtime/requirement-state.ts` | `src/modules/requirement/requirement-state.ts` |
| `runtime/requirement-summary.ts` | `src/modules/requirement/requirement-summary.ts` |
| `runtime/requirement-workspace.ts` | `src/modules/requirement/requirement-workspace.ts` |
| `runtime/short-decision-format.ts` | `src/modules/requirement/short-decision-format.ts` |
| `runtime/short-decisions.ts` | `src/modules/requirement/short-decisions.ts` |
| `runtime/user-interaction-format.ts` | `src/modules/requirement/user-interaction-format.ts` |
| `extensions/settings.ts` | `src/modules/settings/settings-extension.ts` |
| `runtime/agent-settings-ui.ts` | `src/modules/settings/agent-settings-ui.ts` |
| `runtime/agent-settings.ts` | `src/modules/settings/agent-settings.ts` |
| `runtime/internal-model.ts` | `src/modules/settings/internal-model.ts` |
| `runtime/settings-page-ui.ts` | `src/modules/settings/settings-page-ui.ts` |
| `extensions/shell-ui.ts` | `src/modules/shell/shell-ui-extension.ts` |
| `runtime/shell-bash.ts` | `src/modules/shell/shell-bash.ts` |
| `runtime/shell-page.ts` | `src/modules/shell/shell-page.ts` |
| `runtime/shell-summary.ts` | `src/modules/shell/shell-summary.ts` |
| `extensions/conventions-guard.ts` | `src/modules/verification/conventions-guard-extension.ts` |
| `runtime/change-apply.ts` | `src/modules/verification/change-apply.ts` |
| `runtime/check-round.ts` | `src/modules/verification/check-round.ts` |
| `runtime/command-boundary.ts` | `src/modules/verification/command-boundary.ts` |
| `runtime/project-conventions.ts` | `src/modules/verification/project-conventions.ts` |
| `runtime/write-guard.ts` | `src/modules/verification/write-guard.ts` |

## 成品定义：配置
- `package.json`：`files` 里的 `"daemon"`、`"extensions"`、`"runtime"` 换成一项 `"src"`，其余不变；`scripts.preinstall` 改为 `"node src/core/exec/git-prerequisite.mjs --check"`；`pi.extensions` 改为 `["./src/app/extension/index.ts"]`。
- `tsconfig.json`：`include` 里的三项 `runtime/**/*.ts`、`daemon/**/*.ts`、`extensions/**/*.ts` 换成 `"src/**/*.ts"`，`tests/typecheck/**/*.ts` 保留。

## 函数清单
不新增、不改任何函数。按步骤做：
1. 用 `git mv` 按对照表逐个移动（保持 git 能识别为重命名）。
2. 改写所有相对引用：`src/` 和 `tests/` 下的 `import … from`、`export … from`、`import type`、动态 `import("…")`、类型里的 `typeof import("…")`、`new URL("…", import.meta.url)`，按对照表算出新的相对路径。
3. 改写 `tests/`（含 `tests/helpers/`、`tests/installation/`、`tests/integration/`、`tests/acceptance/`）里写死的旧路径字符串，例如 `"runtime/identity.ts"`、`join(installed, "daemon/loader.mjs")`、`join(PACKAGE_ROOT, "extensions/commands.ts")`、`"extensions", "index.ts"`，按对照表换成新路径。**`tests/` 下只允许改路径，不许改断言和测试逻辑。** `tests/module-layout.test.ts`、`tests/error-advice-coverage.test.ts`、`tests/erasable-syntax.test.ts`、`tests/package-skeleton.test.ts` 由测试阶段负责，不要动。
4. 修正按自身位置拼的路径，让它们仍指向原来那个文件或目录：
   - `src/modules/agents/package-rules.ts`：包根目录（原来是本文件目录的上一级，现在是上三级）。
   - `src/modules/requirement/requirement-doc.ts`：包根下的 `skills/`。
   - `src/modules/agents/roles.ts` 的 `defaultRoleDir`：包根下的 `agents/`。
   - `src/modules/project-index/syntax-parser.ts`：包根下的 `resources/tree-sitter/`。
   - `src/core/host/daemon-client.ts`：包根，以及守护进程启动脚本 `src/app/daemon/bootstrap.mjs`。
   - `src/app/daemon/project-index-host.ts:49`：对 `src/modules/project-index/project-index-policy.ts` 计算哈希。
   - `src/app/daemon/main.ts`、`bootstrap.mjs` 里同目录的 `./lifecycle.ts`、`./main.ts`、`./loader.mjs` 不变，核对一遍。
5. 按「成品定义：配置」改 `package.json`、`tsconfig.json`。
6. 确认 `runtime/`、`extensions/`、`daemon/` 已不存在。

## 协作关系
- pi 按 `package.json` 的 `pi.extensions` 加载 `src/app/extension/index.ts`，它再依次调用各模块的 `*-extension.ts`。
- `src/core/host/daemon-client.ts` 按包根拼出 `src/app/daemon/bootstrap.mjs` 启动守护进程；`bootstrap.mjs` 通过同目录的 `loader.mjs` 加载 `main.ts`。
- 安装测试会把包打包后装到临时目录再运行，能发现按自身位置拼路径的错误。

## 验证方式
- 测试入口：`pnpm exec vitest run tests/module-layout.test.ts tests/error-advice-coverage.test.ts tests/erasable-syntax.test.ts tests/package-skeleton.test.ts`；之后 `pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation`。
- 测试输入：仓库根目录、`package.json`、`tsconfig.json`、`src/` 下的文件。
- 预期结果：
  - [ ] 仓库根上没有 `runtime/`、`extensions/`、`daemon/`；`src/` 下只有 `core`、`modules`、`app` 三个目录。
  - [ ] 这些文件存在：`src/modules/delivery/git-delivery.ts`、`src/modules/delivery/git-delivery-extension.ts`、`src/modules/settings/settings-page-ui.ts`、`src/core/exec/tool-failure.ts`、`src/core/exec/git-read.ts`、`src/modules/requirement/requirement-state.ts`、`src/core/host/extension-lifecycle.ts`、`src/app/extension/index.ts`、`src/app/daemon/bootstrap.mjs`。
  - [ ] `package.json` 的 `pi.extensions` 是 `["./src/app/extension/index.ts"]`；`files` 含 `src`、不含 `runtime`、`daemon`、`extensions`；`scripts.preinstall` 是 `node src/core/exec/git-prerequisite.mjs --check`；`tsconfig.json` 的 `include` 含 `src/**/*.ts`、不含三个旧目录。
  - [ ] `tests/error-advice-coverage.test.ts` 递归扫描 `src/`，扫到的 `.ts` 不少于 124 个；`tests/erasable-syntax.test.ts` 检查 `src/`；`tests/package-skeleton.test.ts` 要求 `files` 含 `src`；`tests/user-documentation.test.ts` 里搜索旧命令的目录清单用 `src` 代替三个旧目录。
  - [ ] 四项纯代码测试全部通过。
  - [ ] `git log -L :deepFreeze:src/modules/requirement/requirement-state.ts -s` 能列出搬家前的提交。
