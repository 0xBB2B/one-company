---
name: 05-change-apply
description: worker 写入工具 change_apply 的编号由程序生成；只有续写没写完的那批文件时才填编号
---
# worker 写入：编号由程序生成

## 目标
worker 调 `change_apply` 的 apply、import 时不填 operationId。程序生成编号并在结果里返回；没写完的那批文件，worker 照抄结果给出的编号续写。

## 业务规则（来源：PRD 01-program-generated-ids）
- apply、import 不填 operationId 能成功；程序生成合规 UUIDv7；结果里带本次编号（C-1、C-2）。现有结果已经返回 operationId。
- 写到一半或部分文件失败时，结果给出编号；照抄它、带同样的文件再调，就能续写完，结果与一次写完相同（C-4、C-5）。
- 填了 operationId 但对不上时拒绝，并写明原因（C-6）：
  - 不是本运行的写入记录，或编号不存在；
  - 那批已全部写完；
  - 文件或内容与原来那批不同。
- status 动作的 operationId 是"查以前那批写入"的引用编号，仍然必填，不变。
- 说明文字和报错里不出现"新生成""UUIDv7"（C-3、C-8）。其他行为不变（C-9）。

## 涉及文件
- 修改 `src/modules/verification/change-apply.ts`
- 修改 `src/modules/pm/subagent-tools.ts`
- 修改测试：`tests/change-apply.test.ts`、`tests/verification-run.test.ts`
- 修改测试素材：`tests/agent-selection.test.ts`（写死的 operationId 去掉）、`tests/acceptance/points/p05-pm-evidence.test.ts`、`tests/acceptance/points/p10-qa-prototype.test.ts`（apply 调用里的 operationId 去掉，否则会被当成续写编号拒掉）

## 成品定义
参数（`change-apply.ts`）：apply、import 的 `operationId` 改为 `Type.Optional(id)`；status 不变。

`subagent-tools.ts` 工具说明末尾"operationId 每次新生成 UUIDv7。"改为：

```text
apply、import 的 operationId 由程序生成，平时不填；结果显示没写完（applying 或 partial_failure）时，照抄结果里的 operationId、带同样的文件再调一次续写。status 填要查的那次写入的 operationId。
```

原因与建议表：

```ts
operation_conflict: { why: "续写的文件或内容与原来那批不同", next: "带上原来那批文件续写；不是续写就不填 operationId" },
resume_not_found: { why: "找不到这个操作编号对应的、属于本运行的写入", next: "不是续写就不填 operationId，重新发起" },
resume_finished: { why: "这个操作编号对应的那批文件已经全部写完", next: "不填 operationId 发起新的写入；要看结果用 status" },
```

## 函数清单
### src/modules/verification/change-apply.ts
| 函数名 | 职责 |
|---|---|
| `run`（修改） | 没填编号：用 `uuidv7()` 生成，按新写入处理。填了编号：记录不存在或不属于本运行 → `resume_not_found`；已 applied → `resume_finished`；内容不同 → `operation_conflict`；其余按现有续写逻辑继续 |
| 工具 execute 的参数分发（修改） | 把可选的 operationId 传给 `run`，status 分支不变 |

### src/modules/pm/subagent-tools.ts
| 函数名 | 职责 |
|---|---|
| `createSubagentTools` 中 change_apply 注册（修改） | 说明改成上面的文字 |

## 协作关系
- worker 会话和 change_apply 都跑在守护进程里；续写只在同一个运行里有效（记录绑定 runId），这一点不变。
- `uuidv7` 来自 `src/core/storage/database.ts`。

## 验证方式
- 测试入口：change_apply 工具（`tests/change-apply.test.ts` 现有封装）。
- 测试输入：现有样例工作区与授权范围。
- 预期结果：
  - [ ] apply、import 不填编号成功，结果带程序生成的编号；两次调用编号不同。
  - [ ] 制造 partial_failure：照抄结果编号、同样的文件再调 → applied（沿用 `tests/verification-run.test.ts` 现有续写用例的步骤）。
  - [ ] 续写填不存在的编号、已 applied 的编号、内容不同的编号：分别报 `resume_not_found`、`resume_finished`、`operation_conflict` 对应文字。
  - [ ] status 仍要求 operationId，查得到本运行的写入。
  - [ ] 工具说明与 `change-apply.ts` 里没有"新生成""UUIDv7"；"重新生成文件"那句 `import_mismatch` 提示保留。
  - [ ] 真实模型验收 P5、P10 的脚本里没有写死的 operationId。
