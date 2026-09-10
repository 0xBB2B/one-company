---
name: structured-verdict
description: 三类角色结构化裁决的 typebox 格式、语义谓词与提交收集器：唯一对象、工具调用标识去重、正常结束后才放行
---
# 结构化裁决

## 目标
完成后派工方能把结构化格式传给角色，并只依据格式校验通过、语义自洽且在运行正常结束后取得的唯一对象推进阶段检查。

## 业务规则（来源：spec）
- structured-verdict：角色必须按调用方格式提交唯一对象，顶层字段精确匹配，类型、非空、枚举合法，通过与失败的字段组合自洽；未提交、多余字段、缺字段、语义矛盾一律失败关闭，不从自然语言推断通过；首个有效对象被接受前的失败尝试允许以新调用纠正；接受后再提交必须失败；同一工具调用标识的相同完成事件重复投递不计数，同标识内容冲突失败，无标识独立处理；运行正常完成后才把对象交给阶段检查，提前提交或异常退出不能构成通过；规划角色不要求结构化裁决。
- direct-acceptance：验收通过要求逐条结果非空且全部通过、问题清单与未覆盖项为空、报告位置等于指定位置。
- direct-pre-review：审查通过要求问题清单与发现清单为空、可追踪关系与证据非空、审查头与内容指纹等于快照。

## 涉及文件
- 新建：`runtime/result.ts`
- 新建：`tests/structured-verdict.test.ts`

## 成品定义

```ts
import { Type } from "typebox";

const Common = {
  verdict: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]),
  summary: Type.String({ minLength: 1 }),
  issues: Type.Array(Type.String({ minLength: 1 })),
  evidence: Type.Array(Type.String({ minLength: 1 })),
};

export const WORK_SCHEMA = Type.Object({
  phase: Type.Literal("work"),
  ...Common,
  changeKind: Type.Union([Type.Literal("behavior-change"), Type.Literal("refactor"), Type.Literal("unclear")]),
  workState: Type.Union([Type.Literal("red-green"), Type.Literal("green-baseline-no-change"), Type.Literal("blocked")]),
  coverage: Type.Array(Type.Object({ ref: Type.String(), test: Type.String() }, { additionalProperties: false })),
  redCommands: Type.Array(Type.Object({ command: Type.String(), status: Type.Union([Type.Literal("failed"), Type.Literal("passed")]), details: Type.String() }, { additionalProperties: false })),
  greenCommands: Type.Array(Type.Object({ command: Type.String(), status: Type.Union([Type.Literal("failed"), Type.Literal("passed")]), details: Type.String() }, { additionalProperties: false })),
  changedFiles: Type.Array(Type.String()),
  productionPath: Type.Array(Type.String()),
  preexistingEvidence: Type.Array(Type.String()),
  fakeRed: Type.Literal(false),
}, { additionalProperties: false });

export const REVIEW_SCHEMA = Type.Object({
  phase: Type.Literal("review"),
  ...Common,
  reviewedHead: Type.String({ minLength: 1 }),
  contentFingerprint: Type.String({ minLength: 1 }),
  traceability: Type.Array(Type.Object({ ref: Type.String(), test: Type.String(), implementation: Type.String() }, { additionalProperties: false })),
  findings: Type.Array(Type.Object({
    kind: Type.Union([Type.Literal("security"), Type.Literal("robustness"), Type.Literal("traceability"), Type.Literal("tdd"), Type.Literal("scope")]),
    severity: Type.Union([Type.Literal("Blocker"), Type.Literal("Important")]),
    location: Type.String(), problem: Type.String(), fix: Type.String(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

export const ACCEPTANCE_SCHEMA = Type.Object({
  phase: Type.Literal("acceptance"),
  ...Common,
  acceptanceResult: Type.Union([Type.Literal("accepted"), Type.Literal("rejected")]),
  reportPath: Type.String({ minLength: 1 }),
  items: Type.Array(Type.Object({ id: Type.String(), result: Type.Union([Type.Literal("PASS"), Type.Literal("FAIL")]), observed: Type.String(), difference: Type.String() }, { additionalProperties: false })),
  uncovered: Type.Array(Type.String()),
}, { additionalProperties: false });
```

语义谓词（格式通过后再判定）：

| 谓词 | PASS 成立条件 | FAIL 成立条件 |
|---|---|---|
| `isWorkPass` | `workState ≠ blocked`、`issues` 空、`coverage` 非空、`greenCommands` 全 passed、`changeKind = behavior-change` 时 `redCommands` 至少一条 failed | `workState = blocked` 或 `issues` 非空 |
| `isReviewPass` | `issues` 与 `findings` 空、`traceability` 与 `evidence` 非空、`reviewedHead`/`contentFingerprint` 等于调用方快照 | 任一不满足即 FAIL 且 verdict 必须为 FAIL |
| `isAcceptancePass` | `acceptanceResult = accepted`、`items` 非空且全 PASS、`issues` 与 `uncovered` 空、`reportPath` 等于指定路径且报告结论为 accepted | 其余 |

verdict 与谓词矛盾（如 verdict PASS 但谓词不成立）判为语义矛盾，失败关闭。

## 函数清单
### runtime/result.ts
| 函数 | 职责 |
|---|---|
| `assertOutputSchema` | 校验调用方传入的格式本身合法（顶层对象、含 phase 常量、不含未知关键字） |
| `validateResult` | 用格式校验对象，强制 phase 等于期望阶段，返回校验错误列表 |
| `isWorkPass` / `isReviewPass` / `isAcceptancePass` | 按上表判定语义，返回不成立原因 |
| `ResultCollector.accept` | 处理一次结构化提交完成事件：去重、冲突、唯一性、尝试与有效计数 |
| `ResultCollector.markSettled` | 记录运行正常完成与停止原因 |
| `ResultCollector.finish` | 仅在正常完成、无错误、恰一个有效对象时返回对象，否则返回失败原因 |
| `ResultCollector.diagnostics` | 输出尝试数、有效数与逐次尝试记录供错误详情保存 |

## 协作关系
`daemon/role-session.ts` 在角色会话内注册提交工具并把完成事件交给 `ResultCollector.accept`；`daemon/run-manager.ts` 在会话结束后调用 `finish` 决定运行结果；`runtime/error-details.ts` 保存 `diagnostics`。

## 验证方式
- 测试入口：`validateResult`、三个谓词、`ResultCollector`
- 测试输入：合法三类对象；多余字段、缺字段、枚举错误、verdict PASS 但 issues 非空；相同标识重复事件、相同标识不同内容、无标识两次事件、首个有效后再提交、格式错误后用新标识纠正；提交后未 settled 即 finish；stop 原因为 error/aborted/length
- 预期结果：合法对象通过且谓词按表判定；偏差对象返回具体错误；重复事件不增计数、冲突失败、无标识各计一次、纠正成功不残留旧错误、有效后再提交失败；未 settled 或非法 stop 原因时 finish 返回失败
- [x] 三类格式正反例
- [x] 谓词表逐条
- [x] 去重、冲突、无标识、纠正、唯一性
- [x] 正常结束才放行
