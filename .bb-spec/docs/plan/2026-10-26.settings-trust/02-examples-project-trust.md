---
name: examples-project-trust
description: /one:examples 在授信记录为空时能选项目层，确认复制后先把本项目设为受信任再复制
---
# /one:examples 项目层当场授信

## 目标
授信记录为空的项目里，`/one:examples` 能把规范样例复制到项目层；用户在确认窗口点了复制后，程序先把主仓库根目录在 pi 的 `trust.json` 里记为 true，再复制。

## 业务规则（来源：PRD project-layer-trust）
- 授信记录三种状态：信任（true）、不信任（false）、空（没有记录），按 pi 的 `ProjectTrustStore(agentDir).get(主仓库根目录)` 从主仓库根目录往上找最近一条。
- 第一个窗口（选哪套样例）每行的"项目层：<状态>"：空或信任时写项目层实际的复制状态（和信任时一样检查项目层文件，比如"未复制""已复制"）；不信任时写"未受信任"（C-10）。
- "用户层已全部复制"时的提前结束：只在项目层也已全部复制，或授信记录为不信任时提前结束；空时照常进入选层窗口。不信任时的提示文字保持现状（"……项目未受信任，不能复制到项目层。"）。
- 选层窗口项目层：空时可选，说明"<项目路径>/ · 只对这个项目生效 · 选它会把本项目设为受信任"；不信任时灰掉，写"你在 pi 里选过不信任这个项目，先输入 /trust 选 Trust"；信任时和现在一样（C-9）。项目层已全部复制时仍灰掉写"已全部复制，和样例一致"。
- 确认窗口：空时按项目层计算已关闭的定义、项目层定义目录（和信任时一样，因为确认后项目层就会生效）。
- 只在确认窗口选了"复制"之后才写授信记录；在任何窗口取消都不写（C-6）。空且选项目层时，先 `trustProject` 再复制文件；写授信记录失败时不复制任何文件，用 `ctx.ui.notify(..., "error")` 报"✗ 复制没有完成：<原因>"，原因取错误信息第一行（C-5）。
- 完成提示：这次写了授信记录时，在 `resultText` 生成的提示末尾加"· 已把本项目设为受信任"（C-9）；信任时不加。
- 复制失败（文件复制阶段的 `ExampleCopyError`）沿用现有 `copyFailureText`；此时授信记录已经写入，不回滚（用户已明确选择项目层）。

## 涉及文件
- 修改 `src/modules/settings/examples-extension.ts`

## 函数清单
### src/modules/settings/examples-extension.ts
| 函数名 | 职责 |
|---|---|
| `openExamplesPage` | 用 `readProjectTrust`（来自 `./project-trust.ts`，由 settings-project-trust 新建）取三态；按三态决定是否检查项目层、提前结束条件、选层窗口项目层的说明或灰掉原因、确认窗口参数；确认复制后、unset 且选项目层时先 `trustProject`；完成提示加后缀 |
| `layerStatusText` | 不信任时仍返回"未受信任"（调用方在 unset 时传入实际检查结果） |

## 协作关系
`openExamplesPage` → `readProjectTrust` → `inspectExample`（unset 和 trusted 都检查项目层）→ `chooseWindow` 选样例 → `chooseWindow` 选层 → `confirmLines` 确认 → unset 且项目层时 `trustProject` → `copyExampleFiles` → `resultText` + 后缀 → `ctx.ui.notify`。外部依赖：pi 的 `ProjectTrustStore`。

## 验证方式
- 测试入口：`openExamplesPage(ctx)`，用 tests/examples-command.test.ts 的 `setup` 和脚本化 ctx（`setup({ trusted: true })` 会写 `trust.json`；不传时没有记录）。
- 测试输入：`trust.json` 不存在、`{仓库: false}`、`{仓库: true}`；选一套样例、选项目层、确认或取消；`trust.json` 所在目录只读模拟写入失败。
- 预期结果：
  - 无记录：第一个窗口写项目层实际状态（如"未复制"）；项目层可选且说明带"选它会把本项目设为受信任"；确认后文件复制进项目、`trust.json` 里仓库为 true、提示末尾有"· 已把本项目设为受信任"；在选层或确认窗口取消，`trust.json` 不变、没有复制文件。
  - false：第一个窗口写"未受信任"；项目层灰掉，写"你在 pi 里选过不信任这个项目，先输入 /trust 选 Trust"；`trust.json` 不变。
  - true：行为和提示与现在一致，提示里没有后缀。
  - 写授信记录失败：error 级提示"✗ 复制没有完成：<原因>"，项目里没有新文件。
- [ ] 无记录时第一个窗口状态、选层窗口文字、确认后授信并复制、提示后缀
- [ ] 无记录时取消不写授信记录
- [ ] false 时灰掉与原因文字
- [ ] true 时行为不变
- [ ] 授信记录写入失败时不复制
