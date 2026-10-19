---
name: 03-workflow-close
description: 关闭需求的操作编号由程序生成；"关闭中"和"已有另一个关闭"时给出原编号，模型照抄续办
---
# 关闭需求：编号由程序生成

## 目标
主代理调 `one_company_workflow_manage` 的 close 时不填 operationId。关闭没办完时，结果或拒绝里给出原编号，模型照抄编号续办。

## 业务规则（来源：PRD 01-program-generated-ids）
- close 不填 operationId 能成功；程序生成合规 UUIDv7，结果里带本次编号（C-1、C-2）。
- 关闭返回"关闭中"，或已有一次没办完的关闭时，结果里给出原操作编号；建议写明照抄它、用原决定编号、原原因再次 close（C-4）。
- 带原编号、原 reason、原 receiptId 再调，关闭办完，结果与一次办完相同（C-5）。
- 填了 operationId 但对不上时拒绝并写明原因（C-6）：
  - 这个需求没有关闭记录；
  - 那次关闭已办完；
  - 编号与这个需求在办的关闭不一致；
  - reason 或 receiptId 与原关闭不同。
- 说明文字不出现"新生成""UUIDv7"（C-3）。其他关闭行为不变（C-9）。

## 涉及文件
- 修改 `src/modules/delivery/workflow-manage-extension.ts`
- 修改 `src/modules/delivery/workflow-manage.ts`
- 修改 `src/modules/delivery/workflow-close.ts`
- 修改测试：`tests/workflow-close.test.ts`、`tests/adjudication.test.ts`（close 调用处）、`tests/zero-custom-loop.test.ts`（close 调用处）、`tests/workspace-manage.test.ts:52` 一带直接调 `closer.close` 的地方

## 成品定义
参数：主会话 schema（`workflow-manage-extension.ts`）与守护进程 schema（`workflow-manage.ts` 的 close 分支）里，`operationId` 都改为可选（`Type.Optional`），其余字段不变。

主会话工具说明末尾加一句：

```text
close 的 operationId 由程序生成，平时不填；结果返回"关闭中"或提示已有关闭在办时，照抄结果给出的 operationId，用原决定编号、原原因再次 close 续办。
```

`workflow-manage.ts` 里"关闭中"的建议改为：

```text
等这些事项结束后，照抄结果里的 operationId，用原决定编号、原原因再次 close 续办
```

`workflow-close.ts` 新增拒绝原因（与现有 `closeItemText` 同一张表）：

```ts
close_not_found: "这个需求没有在办的关闭，不是续办就不填 operationId",
close_finished: "这次关闭已经办完，用 status 查看结果",
close_operation_mismatch: "填的 operationId 与这个需求在办的关闭不一致，照抄结果给出的原操作编号",
```

## 函数清单
### src/modules/delivery/workflow-manage.ts
| 函数名 | 职责 |
|---|---|
| close 分支（修改） | 没填 operationId 时用 `uuidv7()` 生成，填了就原样传给 `close.close`，并标明这是续办 |

### src/modules/delivery/workflow-manage-extension.ts
| 函数名 | 职责 |
|---|---|
| 工具注册（修改） | schema 改可选、说明加上面那句；参数原样转发给守护进程 |

### src/modules/delivery/workflow-close.ts
| 函数名 | 职责 |
|---|---|
| `close`（修改） | 续办时：没有关闭记录 → 拒绝 `close_not_found`；记录已 closed → 拒绝 `close_finished`；编号不同 → 拒绝 `close_operation_mismatch`。新发起时：已有一次没办完的关闭 → 现有"已有另一个关闭请求在办理"拒绝，结果里加原 `operationId` 字段 |

## 协作关系
- 主窗口扩展经守护进程方法 `workflow.manage` 转发到 `createWorkflowManageTool`；PM 侧共用同一份参数定义，但权限表禁止 PM close，不受影响。
- `requirement-contracts.ts` 里 `close_intent_conflict` 的文字由 01 号 plan 改，本 plan 不碰该文件。

## 验证方式
- 测试入口：`one_company_workflow_manage` 的 close（`tests/workflow-close.test.ts` 现有封装）。
- 测试输入：现有样例需求与决定编号（receiptId）。
- 预期结果：
  - [ ] 不填 operationId 关闭一个可直接关闭的需求：结果 `closed`，带程序生成的 operationId。
  - [ ] 关闭返回 `closing`：结果带 operationId；照抄它、原 reason、原 receiptId 再调：先 `closing` 后 `closed`（沿用现有续办测试的步骤）。
  - [ ] 已有一次在办的关闭，再不填编号发起：被拒，结果里带原 operationId。
  - [ ] 续办时填没有关闭记录的需求的编号、已 closed 的编号、不一致的编号：分别被拒，文字对应上面三条。
  - [ ] 工具说明里没有"新生成""UUIDv7"。
