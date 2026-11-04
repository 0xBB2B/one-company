---
name: 06-worker-implementation-section
description: 派给 worker 的任务内容由程序附上用户批准那一版需求「实现」板块的原文
---
# worker 任务内容附上「实现」板块原文

## 目标
worker 判断一项新技术能不能用时，有一份由程序从用户批准的需求里取出的「实现」板块原文可依，不依赖 PM 写的任务说明。

## 业务规则（来源：PRD 03-pm-and-review C-5 与 OVERVIEW 决策记录）
- 派给 worker 的任务内容（首次派出和返修都算）里，程序附上当前批准版需求「实现」板块的原文。「实现」板块指需求文档规范里标 record: implementation 的那个板块（包内默认叫「实现」），按需求记录里存的文档规范找它的编号。
- 附的是派出这一刻的批准版本：批准新版本后再派，附的是新版本的原文。
- 原文前面有一行说明，写明这是用户批准的需求「实现」板块原文、新技术只能用这里写了的和项目里已有的；原文为空或找不到这个板块时，写明“「实现」板块里没有写技术”。
- PM 在任务说明里写了别的技术，任务内容里附的仍是「实现」板块原文，两者分开显示。
- 只给 worker 附；审查、QA 有读需求的工具，任务内容不变。
- 原文较长时整段照附，不截断（「实现」板块只写用户明确提出的实现要求，篇幅小）。

## 涉及文件
- `src/app/daemon/run-manager.ts` 修改
- 读批准版正文与定位板块的已有函数所在文件（`src/modules/requirement/prd-view.ts`、`src/modules/requirement/requirement-doc.ts`）按需复用，不改它们的行为
- 对应测试（派工内容的现有测试，如 `tests/run-manager*.test.ts`）修改

## 函数清单
### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `implementationSectionText`（新增，模块内私有） | 按需求记录的文档规范找到 record: implementation 板块编号，从当前批准版正文里取出这一段原文 |
| `taskContext` | worker 任务在内容末尾、对话轮次上限之前加上“需求「实现」板块原文”一段 |
| 派工处（调用 taskContext 的地方） | worker 任务派出时取当前批准版正文并传入 |

## 协作关系
- 批准版正文的读取沿用 `RequirementService.read({ source: "approved" })` 或派工处已有的需求读取途径；板块定位用 `inspectPrdStructure` + `selectPrdSection`（`src/modules/requirement/prd-view.ts`）与 `recordSectionIds`（`src/modules/requirement/requirement-doc.ts`）。
- 不涉及窗口与守护进程通信，PROTOCOL_VERSION 不变；不改数据格式。

## 验证方式
- 测试入口：RunManager 派 worker 的现有测试世界（`tests/helpers/run-manager-fixture.ts` 的 createPmRunWorld，worker 会话收到的第一条消息就是任务内容）。
- 预期结果：
  - [ ] 批准版需求「实现」板块写了“前端用 Vue 3”时，派出的 worker 任务内容含这句原文和说明行。
  - [ ] PM 的任务说明里写“用 lodash”，任务内容里附的「实现」板块原文不含 lodash，两段分开。
  - [ ] 批准新版本（「实现」板块改成“前端用 React”）后再派，附的是新原文。
  - [ ] 「实现」板块写“由 PM 规划”或为空时，说明行写明板块里没有写技术。
  - [ ] 派审查和 QA 时任务内容不含这一段。
