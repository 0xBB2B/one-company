---
name: 05-acceptance-p18
description: 新增真实模型单点验收 P19：新项目弹技术清单并写进「实现」板块，已有技术栈的需求不弹
---
# 真实模型验收 P19

## 目标
`tests/acceptance/points/` 下新增 P19，用真实模型检查主代理在需要新技术时弹技术清单、同意后写进「实现」板块，在只用已有技术时不弹；文档里的单点范围改成 P1–P19。

## 业务规则（来源：PRD 02-main-agent-asks 与 OVERVIEW 决策记录）
- 场景一（需要新技术）：样例项目里对主代理说“做一个网页版的图书馆借还系统，要有借书、还书、查书的页面、后端接口和保存借阅记录的数据库。请整理成需求草稿给我确认，先不要开始实施。” → 主代理请用户批准之前弹出技术清单窗口（标题行以“提问 · ”开头、窗口文字含“要引入的新技术”），清单里至少有一项类别是“框架”、至少一项是“数据库”，每项来源是 3 种之一；扮演用户选“全部同意”后，草稿正文「实现」板块包含清单里每一项的名称。
- 场景二（只用已有技术）：同一个样例项目里说 P1 那句快跑需求（“我要给角色加快跑：……不做体力值，不改跳跃。请整理成需求草稿给我确认，先不要开始实施。”）→ 整个过程不出现技术清单窗口。
- 窗口作答：技术清单窗口标题以“提问 · ”开头，验收辅助里的 `recommendedChoice` 在没有“推荐”时取第一项，正好是“全部同意”，不用改作答逻辑。
- 两个场景写成两条用例（编号都是 P19，用例名冒号前写 “P19”），跑法和判定沿用 run-parallel 的规则（每条同时跑 2 次，一过一不过补第 3 次）。
- 证据：judgement.json 里写技术清单窗口的文字、各项类别和来源、草稿「实现」板块原文；场景二写出现过的所有窗口标题。

## 涉及文件
- `tests/acceptance/points/p18-main-tech-approval.test.ts` 新建
- `CONTRIBUTING.md` 修改（单点表格加 P19 一行；“P1–P17”改成“P1–P19”）
- `AGENTS.md` 修改（测试一节“P1–P17”改成“P1–P19”）

## 函数清单
### tests/acceptance/points/p18-main-tech-approval.test.ts
| 函数名 | 职责 |
|---|---|
| `test("P19：……新项目……")` | 场景一：startMainPoint 启动、说图书馆需求、从 host.dialogs 找技术清单窗口、读草稿「实现」板块断言 |
| `test("P19：……已有技术……")` | 场景二：说快跑需求，断言 host.dialogs 里没有含“要引入的新技术”的窗口 |
| `implementationSection` | 从草稿正文里取出标了 `{#implementation}`（或规范里 record: implementation 对应编号）的板块原文 |

## 协作关系
- 复用 `tests/acceptance/helpers/point-main.ts` 的 `startMainPoint`、`say`、`requirements`、`close`，和 `installed-host.ts` 记录的 `dialogs`。草稿正文按已有验收读取需求正文的方式读（参照 `tests/acceptance/points/p06-p07-main-targets.test.ts` 等读正文的写法）。
- 验收不进 `pnpm test`；类型检查不含 tests，写完要用 `--only P19` 实际跑通。

## 验证方式
- 测试入口：`ONE_COMPANY_ACCEPTANCE_MODEL=5x/gpt-6.1-sol ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel --only P19`
- 预期结果：
  - [ ] 场景一：出现技术清单窗口，含框架和数据库两类，来源都在 3 种之内；草稿「实现」板块含每一项名称。
  - [ ] 场景二：没有技术清单窗口。
  - [ ] 两条用例按 run-parallel 规则判定通过。
  - [ ] CONTRIBUTING.md 表格有 P19 一行（场景与预期各一句），AGENTS.md 与 CONTRIBUTING.md 里写的单点范围都是 P1–P19。
