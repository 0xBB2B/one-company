# M8K 状态

阶段目标：追加需求后草稿段数变多时批准仍能登记；模型给选填游标填占位值时仍能读到第一页；主代理不靠 @ 也能用 list 知道现有哪些草稿与进行中需求。

范围与非目标：按计划 M8K 一节。不把需求清单放进系统提示；不给 PM、worker、reviewer、QA、explore 开 list；不改游标的有效期与绑定规则；与段数无关的条数上限不变。

验证方法：AC1 到 AC3 有对应测试；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 通过；AC4 由 M9-AC2 真实模型重跑取证。

性能指标：不新增指标。

停止条件：出现 AGENTS.md「停止规则」任一情况。

起因（用户 2026-10-03 决定）：M9-AC2 第 1、2 轮追加动画后草稿有 22 段，批准分段与批准存档的 20 段上限让批准登记不上；第 3 轮通过后逐题核对，④⑥ 因模型自填全 0 游标没读到正文，⑤ 主代理不知道有哪些进行中需求（证据 .bb-spec/.cache/m9/acceptance-sol61/progressive-2026-10-03T11-34-47-938Z/questions-verified.md）。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 25 段需求从保存、批准、登记清单到 PM 提出计划不被段数拒绝 | 通过 | tests/plan-manage.test.ts「需求有 25 段时」、tests/approval-manifest.test.ts「段数不设单独上限」（都先失败后通过）；324fe92、6ff3194 | 无 |
| AC2 全零游标按第一页，其他伪造游标仍被拒 | 通过 | tests/main-requirement-interaction.test.ts「分页保留中文」、tests/requirement-read-tool.test.ts「游标不能篡改」、tests/knowledge-query.test.ts「游标绑定caller」（都先失败后通过）；6e7300c | 无 |
| AC3 list 列出编号、标题、状态与仓库，不含正文，可按仓库筛选 | 通过 | tests/main-requirement-interaction.test.ts「M8K-AC3」（先失败后通过，含送达核对） | 无 |
| AC4 真实模型验收并入 M9-AC2 | 通过 | 2026-10-03 第 5 轮（7185c86）：追加动画后批准一次登记成功；④⑥经需求工具读到正文与差异；⑤先 list 再读出进行中需求（证据 .bb-spec/.cache/m9/acceptance-sol61/progressive-2026-10-03T14-15-17-768Z/questions-verified.md）。第 4 轮曾暴露 list 绕过送达登记，已由 7185c86 修复并补测试 | 无 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
M8K 已收口（AC1 到 AC4 通过）。先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8F 到 M8K、M9 章节与 §13），再读 M9-STATUS.md，核对 git status 与最近提交，然后回 M9 按状态表推进其余 AC。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
