---
name: remove-partial-trust
description: 删掉设置页和 /one:examples 里所有授信相关的界面和分支，项目层总是生效
---
# 删掉半信任分支

## 目标
OneCompany 启用时项目一定受信任，设置页和 `/one:examples` 里所有授信相关的提示、变灰、「问题」条目、顺带授信都删掉，项目层总是加载、总是可选。

## 业务规则（来源：PRD remove-partial-trust）
- C-1 设置页任何状态下都没有授信相关文字：顶部没有"项目还没设为受信任 / 项目未受信任 / 读不了授信记录"黄字，「问题」里没有授信那一条（文件列 `.pi/agents/`），项目层角色定义和设定都加载。
- C-2 模型设定、Git 交付、合并方式三处"存到哪一层"：项目层总是可选，说明 `.pi/settings.json · 只对这个项目生效`，下面没有授信说明；保存到项目层不读、不写授信记录，提示里没有"已把本项目设为受信任"。
- C-3 按 C 复制的选层窗口：项目层说明是目标文件路径，只在目标已有同名文件时变暗；复制到项目层不读、不写授信记录，提示里没有那句话。
- C-4 `/one:examples` 第一个窗口项目层写实际复制状态；选层窗口项目层说明 `<项目路径>/ · 只对这个项目生效`，只在已全部复制时变暗；复制到项目层不读、不写授信记录，提示里没有那句话。
- C-5 会话开始后授信记录变了（不信任、读不了），以上行为不变。
- C-6 36～80 列改动的行不超宽。
- 决策：新规则下 OneCompany 能运行时项目一定受信任（用户 2026-11-10 决定"只在启动时判断"），这些分支都用不上，按项目规矩直接删、不留兼容。

## 涉及文件
- 修改 `src/modules/settings/settings-page-ui.ts`
- 修改 `src/modules/settings/agent-settings-ui.ts`
- 修改 `src/modules/settings/settings-extension.ts`
- 修改 `src/modules/settings/examples-extension.ts`
- 修改 `tests/settings-page.test.ts`、`tests/settings-page-ui.test.ts`、`tests/examples-command.test.ts`（删掉只验证授信分支的用例，按新行为改写受影响用例；由 Test Agent 改）

## 函数清单
### src/modules/settings/settings-page-ui.ts
| 位置 | 职责 |
|---|---|
| `SettingsPageView` 构造参数 | 去掉 `projectTrust`、`untrustedProjectCount`、`trustFile`、`trustReason`、`onTrustProject` |
| `untrustedLabel`、`onTrustRow` | 删除 |
| `problemRows` | 删除 `kind === "untrusted"` 分支（项目层总是受信任加载，catalog 不会产生这条） |
| `render` 顶部黄字、`hintFor` 里"设为受信任" | 删除相关分支 |
| `DeliveryModePicker` / `MergeMethodsPicker` 及其基类 | 去掉 `projectTrust` 参数和据此决定光标、变灰、说明的分支 |

### src/modules/settings/agent-settings-ui.ts
| 位置 | 职责 |
|---|---|
| `layerRows` | 项目层固定 `{ name: "项目层", note: ".pi/settings.json · 只对这个项目生效" }` |
| `layerNote` | 删除（以及 `DENIED_NOTE`、`UNSET_NOTE`），调用处一并去掉 |
| `SettingsTab` 选项 | 去掉 `projectTrust`、`trustFile` |

### src/modules/settings/settings-extension.ts
| 位置 | 职责 |
|---|---|
| `openSettingsPage` | 去掉 `readProjectTrust`、`claimProjectLayer`、`claimedNote`、`TRUSTED_NOTE`、`confirmProjectTrust`、`Picked` 里的 `{ trust }`、`untrustedProjectCount`；`readSettings` 和 `loadRoleCatalog` 用 `projectTrusted: true`；按 C 复制的选层窗口项目层只按"已有同名文件"变暗，说明为目标路径 |

### src/modules/settings/examples-extension.ts
| 位置 | 职责 |
|---|---|
| `openExamplesPage` | 去掉读授信记录、`projectDenied`、`unreadable`、`trustWritten` 和写授信记录那一段；项目层状态总按实际 inspect；`readDisabledAgents`、`confirmLines` 的 `projectTrusted` / 项目层判断按受信任 |
| `layerStatusText` | 去掉"未受信任 / 读不了授信记录"分支（参数只剩 inspection） |

## 协作关系
设置页、`/one:examples` 不再引用 `src/core/host/project-trust.ts`。改完后 `grep -rn "受信任\|授信\|projectTrust\|trustFile" src/modules/settings/{settings-page-ui,agent-settings-ui,settings-extension,examples-extension}.ts` 应无结果（启动授信相关的 `startup-trust.ts` 除外）。`src/modules/agents/roles.ts` 的 `untrusted` 问题类型若在 src 里再无使用者，一并删除（以 grep 为准）。

## 验证方式
- 测试入口：`openSettingsPage(ctx, { mainThinking })`（`tests/settings-page.test.ts` 的 `scripted` 按键驱动）、`SettingsPageView`（`tests/settings-page-ui.test.ts` 的 `page()`）、`openExamplesPage`（`tests/examples-command.test.ts`）。
- 前置：项目 `.pi/agents/` 下若干定义；`trust.json` 为信任、空、不信任、写坏四种分别准备，用来证明结果都一样（C-5）。
- 预期结果：
- [ ] 四种授信记录下打开设置页：没有授信相关黄字和「问题」条目，项目层定义出现在列表里（AC-1、AC-5）
- [ ] 三处"存到哪一层"项目层可选、说明 `.pi/settings.json · 只对这个项目生效`、下面无授信说明；存到项目层后 trust.json 内容不变、提示无"已把本项目设为受信任"（AC-2）
- [ ] 按 C 复制到项目层：trust.json 不变、提示无那句话；目标已有同名文件时项目层变暗（AC-3）
- [ ] `/one:examples` 窗口一项目层写实际状态、选层窗口说明符合 C-4、复制后 trust.json 不变、提示无那句话（AC-4）
- [ ] 36、44、60、80 列下改动的行不超宽（AC-6）
- [ ] 删掉的旧用例只限于验证授信分支的；其他设置页、样例用例全部通过
