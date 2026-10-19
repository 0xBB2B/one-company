---
name: esc-back
description: 设置页焦点在右栏时 Esc 回到目录，右栏按键提示改为"←/Esc 回左栏"，窄屏"←/Esc 回目录"
---
# 设置页右栏按 Esc 回到目录

## 目标
设置页焦点在右栏、没有在分步修改或复制起名时，按 Esc 回到目录；焦点在目录时按 Esc 关闭设置页；按键提示如实写出 Esc 的作用。

## 业务规则（来源：PRD esc-back）
- 设置页：/one:setting 打开的页面；目录：左栏分类列表；右栏：选中分类的内容；焦点：按键作用在哪一栏。分步修改：「模型」「开关」里按回车后的逐步选择画面；复制起名：在角色定义上按 C 后输入新名字的画面。窄屏：终端不到 60 列，两栏轮流占满全屏。
- C-1：焦点在右栏且不在分步修改或复制起名时，Esc 与 ← 完全一样：焦点回目录，目录光标停在原分类，展开的详情收起，设置页不关闭。
- C-2：焦点在目录时按 Esc，设置页关闭（调 onClose）。
- C-3：分步修改和复制起名里的 Esc 行为不变：分步修改退回上一步，第一步 Esc 取消并提示"已取消修改"；复制起名 Esc 取消并提示"已取消复制"；取消后焦点留在右栏，页面不关闭。
- C-4（≥ 60 列）按键提示：
  - 目录："↑↓ 选分类  → 进右栏  Esc 退出"
  - 职责分类："←/Esc 回左栏  ↑↓ 选择  回车 详情  C 复制"，展开后"回车 收起"
  - 模型或开关："←/Esc 回左栏  ↑↓ 选择  回车 修改  R 清除本层"
  - 问题："←/Esc 回左栏  ↑↓ 选择  回车 详情"，展开后"回车 收起"
- C-5（< 60 列）：在 C-4 基础上 "→ 进右栏"→"→ 进入"，"←/Esc 回左栏"→"←/Esc 回目录"；Esc 行为同 C-1、C-2。
- 决策：Esc 在右栏的效果直接照搬 ←，不另设"连按两次关闭"机制（效果相同还多一套逻辑）。用户 2026-10-19 决定。

## 涉及文件
- 修改 `src/modules/settings/settings-page-ui.ts`
- 修改 `tests/settings-page-ui.test.ts`（视图层用例：Esc 行为、按键提示、折行用例里的提示文字）
- 修改 `tests/settings-page.test.ts`（页面组装层用例：凡是焦点在右栏时靠一次 Esc 关闭页面的步骤，改成先回目录再 Esc 关闭；断言里的旧提示文字同步改）

## 函数清单
### src/modules/settings/settings-page-ui.ts
| 函数名 | 职责 |
|---|---|
| `SettingsPageView.handleInput` | 焦点在右栏（已排除命名和分步选择两种情况）时，Esc 与 ← 走同一分支：焦点回目录、收起详情；焦点在目录时 Esc 仍调 onClose |
| `SettingsPageView.hintFor` | 右栏三类提示的开头改为"←/Esc 回左栏"并去掉末尾"Esc 退出"；窄屏把"←/Esc 回左栏"替换为"←/Esc 回目录"，"→ 进右栏"替换为"→ 进入" |

## 协作关系
`handleInput` 先处理复制起名（`handleNaming`），再交给分步选择（`SettingsTab` / `SwitchPicker` 的 `handleInput`），这两种情况的 Esc 不经过本次改动的分支。`render` → `hintFor` → `hintLines`（`wrapHint` 按两个空格分组折行）。无外部依赖。

## 验证方式
- 测试入口：`new SettingsPageView({...})` 的 `handleInput(按键)` 与 `render(宽度)`；页面组装层用 `openSettingsPage` 的现有脚本化测试方式。按键：ESC=`\x1b`，←=`\x1b[D`，→=`\x1b[C`，↓=`\x1b[B`，回车=`\r`。
- 测试输入：默认测试素材（用户层一份 ui-worker、项目层一份 reviewer、一份写错的定义），宽度 80 与 44。
- 预期结果：
- [ ] 80 列：↓ 到「模型」→ → → Esc：onClose 未被调用；目录「模型」行带选中底色；按键提示含"↑↓ 选分类  → 进右栏  Esc 退出"（AC-1）
- [ ] worker 分类 → → 回车展开 → Esc → →：选中行光标是 ▸ 不是 ▾，详情行不出现（AC-2）
- [ ] 打开直接 Esc：onClose 被调用；右栏出发连按两次 Esc：onClose 被调用（AC-3）
- [ ] 「模型」PM 回车 → 回车 → Esc → Esc：底部"已取消修改"，焦点在右栏，onClose 未调用，未保存；再 Esc：焦点回目录，onClose 未调用（AC-4）
- [ ] worker 定义上按 C → Esc：底部"已取消复制"，焦点在右栏，onClose 未调用，未复制（AC-5）
- [ ] 80 列下目录、职责分类（含展开）、模型、开关、问题（含展开）的提示与 C-4 完全一致，右栏提示都不含"Esc 退出"（AC-6）
- [ ] 44 列：目录提示"↑↓ 选分类  → 进入  Esc 退出"；进「模型」后提示以"←/Esc 回目录"开头；Esc 后只画目录（无"│"、无"名称 来源"表头）；再 Esc 调 onClose（AC-7）
- [ ] 36–80 列逐列：新提示文字按两个空格分组折行，一组不被拆开，放得下时只占一行
- [ ] `pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全部通过
