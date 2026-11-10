---
name: trust-read-fail-closed
description: 读授信记录的函数挪到 core/host，守护进程和各模块读不了时按不信任照常运行，Git 交付停下
---
# 读不了授信记录时照常运行

## 目标
所有读授信记录的地方都用同一个能接住错误的函数；`trust.json` 写坏或所在目录只读时，守护进程正常启动和派工、各处按不信任处理，Git 交付停下不交付。

## 业务规则（来源：PRD unreadable-trust-fail-closed）
术语：授信记录 = pi 在 `~/.pi/agent/trust.json` 里给目录记的决定；读不了 = pi 的 `ProjectTrustStore.get` 抛错（文件写坏、值不合法、所在目录只读导致读取前加锁失败）。`<文件>` = 授信记录路径（家目录写 `~`），`<原因>` = 错误信息第一行。
- C-1 守护进程启动、派 PM 和子代理、读模型设定、读关闭名单、读角色目录、找 skill 时，读不了一律按不信任（项目层不加载），不报错、不退出、不拒绝派工。现状：`src/app/daemon/lifecycle.ts:32`（启动时 `loadDaemonRoleCatalog`，经 `:502` 调用）和 `:531-534` 直接 `new ProjectTrustStore(agentDir).get(...)`，写坏时装配失败、守护进程起不来。
- C-2 主窗口为解释器 / 草稿核验器选模型（`src/modules/interaction/main-requirement-interaction.ts:237`）、取需求文档规范（`src/modules/requirement/requirement-doc.ts:57`）时，读不了按不信任，不报错。
- C-3 交付工具（`src/modules/delivery/git-delivery-extension.ts:57`）交付时读不了 → 不推送、不合并、不建 PR、不改文件，工具失败：哪一步失败 + `读不了授信记录 <文件>：<原因>`，建议 `改好这个文件后再交付`。用户 2026-11-10 决定：项目层可能设了"仅本地"，退回默认方式可能误推远程。
- C-4 能读时行为不变：信任时项目层生效，空和不信任时不生效。
- 模块依赖：`src/modules/requirement` 排在 `src/modules/settings` 下面，不能引用 settings（`tests/module-dependencies.test.ts` 的 MODULE_DIRS 顺序），所以读授信记录的函数要放到 core。

## 涉及文件
- 新建 `src/core/host/project-trust.ts`（由 `src/modules/settings/project-trust.ts` 挪过来）
- 删除 `src/modules/settings/project-trust.ts`
- 修改 `src/app/daemon/lifecycle.ts`、`src/modules/requirement/requirement-doc.ts`、`src/modules/interaction/main-requirement-interaction.ts`、`src/modules/delivery/git-delivery-extension.ts`
- 修改所有现在从 `../settings/project-trust.ts` / `./project-trust.ts` 引用的文件，改为引用新位置（`settings-extension.ts`、`examples-extension.ts`、`startup-trust-extension.ts`、`settings-page-ui.ts`、`agent-settings-ui.ts` 等，以 grep 为准）

## 函数清单
### src/core/host/project-trust.ts
| 函数 / 类型 | 职责 |
|---|---|
| `ProjectTrust` | 信任 / 不信任 / 空 / 读不了四种状态（照搬现有定义） |
| `readProjectTrust` | 读授信记录，`get` 抛错时返回读不了并带原因第一行（照搬现有实现） |
| `trustFilePath` | `join(agentDir, "trust.json")`（照搬） |
| `trustProject` / `distrustProject` | 写 true / false（照搬） |

### src/app/daemon/lifecycle.ts
| 位置 | 职责 |
|---|---|
| `loadDaemonRoleCatalog` | `projectTrusted` 改为 `readProjectTrust(...).trust === "trusted"` |
| `startDaemon` 里 RunManager 的 `loadAgentSettings`、`loadDisabledAgents`、`loadSkillDirs` | 同上，每次调用现读 |
| import | 去掉不再用的 `ProjectTrustStore` |

### src/modules/requirement/requirement-doc.ts
| 函数 | 职责 |
|---|---|
| `resolveRepositoryRequirementDoc` | `projectTrusted` 改用 `readProjectTrust(...).trust === "trusted"`；去掉不再用的 `ProjectTrustStore` import |

### src/modules/interaction/main-requirement-interaction.ts
| 函数 | 职责 |
|---|---|
| `#internalModel` | 同上 |

### src/modules/delivery/git-delivery-extension.ts
| 位置 | 职责 |
|---|---|
| 交付工具 execute 里读设定那一步 | 先 `readProjectTrust(agentDir, mainRoot)`：读不了 → 按该文件现有 `fail(原因, 建议)` 写法失败，原因 `读不了授信记录 ${tilde(trustFilePath(agentDir))}：${reason}`，建议 `改好这个文件后再交付`，不往下走；否则 `projectTrusted: trust === "trusted"` 读设定。`tilde` 若不能从 settings 引用（delivery 排在 settings 上面，可以引用），按现有 import 关系取 |

## 协作关系
各处只调用 `readProjectTrust` / `trustFilePath`（core/host），不再直接 new `ProjectTrustStore`。全仓库 `grep -rn "ProjectTrustStore" src` 结果只剩 `src/core/host/project-trust.ts`。core 不引用 modules，符合 `tests/module-dependencies.test.ts`。

## 验证方式
- 测试入口：
  - 守护进程：`tests/daemon-lifecycle.test.ts` / `tests/helpers/` 里现有拉起守护进程的方式（读懂后照用），或 `startDaemon`；`PI_CODING_AGENT_DIR/trust.json` 写成 `{"a": true,}`。
  - 交付工具：`tests/git-delivery-extension.test.ts` 现有驱动方式。
  - 需求文档规范：`resolveRepositoryRequirementDoc(dataRoot, repoRoot)`（`tests/requirement-doc.test.ts`）。
  - 解释器模型：`tests/main-requirement-interaction.test.ts` 或 `tests/internal-model.test.ts` 现有入口，能覆盖就覆盖。
- 预期结果：
- [ ] trust.json 写坏时守护进程正常拉起、能接受请求；派带项目层同名定义的角色时用的是用户层 / 内置那份（AC-1）
- [ ] trust.json 写坏时 `resolveRepositoryRequirementDoc` 返回用户层或包内默认规范、不抛错；解释器模型取用户层或跟随主会话（AC-2）
- [ ] trust.json 写坏时交付工具结果为失败，文字含 `读不了授信记录 <文件>：Failed to read trust store` 和 `改好这个文件后再交付`；仓库分支、提交、远程都没变（AC-3）
- [ ] trust.json 为信任 / 空 / 不信任时现有测试全部通过（AC-4）
- [ ] `tests/module-dependencies.test.ts`、`tests/module-layout.test.ts` 通过；`grep ProjectTrustStore src` 只剩 core/host/project-trust.ts
