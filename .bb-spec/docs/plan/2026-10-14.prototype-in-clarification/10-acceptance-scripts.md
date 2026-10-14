---
name: acceptance-scripts
description: 真实模型验收跟着改：P10 改成主窗口出原型到 QA 读原型，P4 去掉界面标记断言，自动点窗口的辅助代码认新窗口
---
# 真实模型验收脚本

## 目标
真实模型验收能覆盖新流程。合并前按 2+1 规则全量跑通：单点 P1–P12、零自定义完整流程 M9-AC12、渐进需求完整流程 M9-AC2/AC3/AC11。

## 业务规则（来源：PRD OVERVIEW 整体验证路径、downstream-reads）
- P10 改写成新流程。步骤如下：
  1. 主窗口提一个改界面的需求。
  2. 主代理建草稿，派原型设计师。
  3. 交稿后自动弹出确认窗口，辅助代码选"通过（写进需求草稿）"。
  4. 说批准，批准窗口里有原型清单，确认。
  5. PM 拆计划，派出的 qa 读到原型。
- P10 要断言：
  - 看板里这份原型已批准；
  - 第 1 版快照里有它；
  - qa 的会话提示词里有原型段；
  - qa 读过这个原型文件。
- P4 去掉对任务界面标记的断言，其余不变。
- 辅助代码遇到"确认原型"窗口，自动选"通过（写进需求草稿）"。批准窗口带原型清单时，照常选确认。旧的"通过（按这一版开始实现）"和"待你确认原型"事项放行逻辑删掉。
- 只改验收脚本时不用重跑；改了产品代码或提示词，就在新提交上全量重跑。

## 涉及文件
- tests/acceptance/points/p10-qa-prototype.test.ts（改写）
- tests/acceptance/points/p02-p04-pm-planning.test.ts（修改：删 :43、:62 两处 ui 断言）
- tests/acceptance/helpers/installed-host.ts（修改：:94-95 常量、:189 自动选择）
- tests/acceptance/helpers/user-driver.ts（修改：删 :138-139 原型事项放行）
- CONTRIBUTING.md（修改：P10 一行的描述）

## 函数清单
### tests/acceptance/helpers/installed-host.ts
| 函数名 | 职责 |
|---|---|
| 窗口自动应答（修改） | 标题是"确认原型"时选"通过（写进需求草稿）" |
### tests/acceptance/points/p10-qa-prototype.test.ts
| 函数名 | 职责 |
|---|---|
| 用例主体（改写） | 按上面五步驱动，并做四项断言 |

## 协作关系
- 依赖 01 到 07 全部完成。
- 运行命令：`ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型> ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel`，不加 `--only` 就是全量跑。

## 验证方式
- 测试入口：`pnpm run test:acceptance:parallel --only P10 P4`，之后再全量跑。
- 预期结果：
  - [ ] P10 按 2+1 规则判定通过，四项断言都满足。
  - [ ] P4 通过，脚本里不再出现 `task.ui`。
  - [ ] P1–P12、M9-AC12、M9-AC2/AC3/AC11 全量按 2+1 规则通过。全部失败时，先查会话记录里有没有 `429 usage_limit_reached`。
