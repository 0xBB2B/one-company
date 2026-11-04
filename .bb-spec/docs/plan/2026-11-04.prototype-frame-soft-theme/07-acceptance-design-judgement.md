---
name: acceptance-design-judgement
description: P17、P19 的判定加上 DESIGN.md：P17 查交稿的 DESIGN.md 通过程序检查，P19 查主色是样例项目主色
---
# 真实模型验收加 DESIGN.md 判定

## 目标
单点验收 P17、P19 在真实模型上能证明设计师交的 DESIGN.md 合格，并且照项目现有样式写了主色。

## 业务规则（来源：PRD design-spec-file C-18）
- P17（原型设计师按分开的格式交稿）判定加一项：最后一次交稿的 `design`（字符串，或数组里的每一份）用 `checkDesignSpec` 检查都不抛错；判定材料 `judgement.json` 里记下检查结果（通过或原因文字）。原有判定（交稿被收下、四种状态都在、页面没有说明性字样）不变。
- P19（设计师结合项目整体界面）判定加一项：最后一次交稿的 DESIGN.md（数组时取第一份）`## 颜色` 章 `### 明亮` 一节的"主色"是 `#0f766e`（不分大小写）。样例项目只给了浅色样式，暗黑一节的主色要换成在深色背景上对比度够的颜色，不判它。
- 交稿被收下本身已经要求 DESIGN.md 合格（plan design-submit-dispatch），这两项是把原因写进判定材料，方便看失败时卡在哪。
- 合并前按项目规矩跑全部单点 P1–P19 和 M9-AC12，每条先同时跑 2 次，一过一不过跑第 3 次。

## 涉及文件
- 修改 `tests/acceptance/points/p17-prototype-designer.test.ts`
- 修改 `tests/acceptance/points/p19-prototype-project-ui.test.ts`

## 函数清单
### tests/acceptance/points/p17-prototype-designer.test.ts
| 函数名 | 职责 |
|---|---|
| P17 测试用例 | `Submitted` 类型加 `design`；判定加 DESIGN.md 检查并写进 `judgement.json` |
### tests/acceptance/points/p19-prototype-project-ui.test.ts
| 函数名 | 职责 |
|---|---|
| P19 测试用例 | 判定加主色检查并写进 `judgement.json` |

## 协作关系
两条用例从 `src/modules/requirement/design-spec.ts` 引入 `checkDesignSpec`、`designChapters`；其余沿用 plan designer-project-ui 里的写法。

## 验证方式
- 测试入口：`ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型> ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel --only P17 P19`；没有验收配置时 `pnpm run test:acceptance` 里两条都跳过。
- 测试输入：P17 原有的存档列表页任务；P19 的样例项目和任务。
- 预期结果：
- [ ] 没有配置时两条跳过，`pnpm test` 不受影响
- [ ] 有配置时 P17 的 `judgement.json` 含 DESIGN.md 检查结果，判定通过
- [ ] 有配置时 P19 的 `judgement.json` 含明亮一节的主色，判定通过
