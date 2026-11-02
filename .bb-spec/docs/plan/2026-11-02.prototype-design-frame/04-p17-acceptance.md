---
name: p17-acceptance
description: 新增真实模型单点验收 P17，判定设计师按分开的格式交稿；同步验收文档
---
# 真实模型验收 P17

## 目标
用真实模型验证设计师会按新格式交稿，页面里没有说明性字样。

## 业务规则（来源：PRD frame-submission）
- P17：真实模型扮演原型设计师，收到一个带界面的设计任务后交稿。
- 程序判定三件事：交稿被收下（这一版进入等确认）；"正常""空数据""加载中""出错"四种状态都在页面清单的画面名称里；提交的 `html` 里没有"演示""原型""待确认"字样。
- 设计得好不好不算进判定，免得模型输出波动让 P17 失败。
- 单点验收范围从 P1–P16 改成 P1–P17。`AGENTS.md` 已在提交 PRD 时改好，这里同步 `CONTRIBUTING.md`。

## 涉及文件
- `tests/acceptance/points/p17-prototype-designer.test.ts`（新建）
- `CONTRIBUTING.md`（修改）
- `README.md`（修改："界面先出原型"一节写新外框；写明升级前的旧格式原型不兼容）

## 成品定义
`CONTRIBUTING.md` 第 25 行的"全部单点（P1–P16）"改成"全部单点（P1–P17）"。第 50 行的"交给真实模型的 PM、worker、reviewer、QA 用"改成"交给真实模型的 PM、worker、reviewer、QA、原型设计师用"。单点表格在 P16 那一行后面加一行：

```markdown
| P17 | 原型设计师收到一个带界面的设计任务 | 按分开的格式交稿：四种状态都在页面清单里，页面里没有"演示""原型""待确认"字样 |
```

README 改两处。"界面先出原型"一节写清原型的新样子：左边切换，右边页面，页面下方说明，有多个方案时切换栏最上面有黄框；"网页里模拟的 80 列终端窗口"改成终端页面铺满右边的框、文字从左上角开始、按 80 列换行。升级须知加一条：

```markdown
- 升级前交的原型文件没有外框，worker、reviewer、QA 的规矩只认新外框。带这种原型的需求，先做完，或让主代理重派设计师出新版本，再升级。
```

## 函数清单
### tests/acceptance/points/p17-prototype-designer.test.ts
| 函数名 | 职责 |
|---|---|
| 测试 `P17：…` | 建运行环境，把设计师的请求交给真实模型，等交稿后判定并写证据 |

## 协作关系
- 用例名以 `P17：` 开头，`tests/acceptance/run-parallel.ts` 按用例名发现它，脚本不用改。
- 运行环境沿用 P9 的写法：`createPmRunWorld`、`acceptanceConfig`、`pointEvidence`、`createRealModel`，`w.provider.awaitReply` 把请求交给 `real.answer`，`close(evidence)` 收尾。
- 派设计师沿用 `tests/prototype-dispatch.test.ts` 的写法：`registerProtocolHandlers` 登记请求，`hello` 后调 `prototypes.dispatch`。`name` 用"暂停菜单"，`brief` 写一个有数据的界面（如"存档列表页：列出存档，可读取和删除，没有存档时给出提示"），`maxTurns` 用 20。
- 等待：轮询 `readPrototypeBoard`，直到这份原型的 `inFlight.status` 是 `awaiting`，最多 15 分钟。
- 判定用 `real.toolCalls()` 里最后一次 `one_company_result_submit` 调用的参数。
- 跳过条件和超时写法与 P9 一样：`test.skipIf(!config || process.platform !== "darwin")`，超时 20 分钟。

## 验证方式
- 测试入口：`ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型> ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel --only P17`。
- 测试输入：一条有效需求和上面的设计任务。
- 预期结果：按验收规则判定通过，证据目录有 `real-model.json` 和判定记录。
- [ ] `pnpm vitest list tests/acceptance/points/p17-prototype-designer.test.ts` 能列出以 `P17：` 开头的用例。
- [ ] 真实模型跑 P17，按"同一提交先跑 2 次，一过一不过再跑第 3 次"的规则通过。
- [ ] 判定记录含四种状态名称和页面清单。
- [ ] `CONTRIBUTING.md` 里不再有"P1–P16"，表格有 P17 一行。
