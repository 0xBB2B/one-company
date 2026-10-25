---
name: split-rules
description: PM 规矩与 escalate 工具说明写明待更新的已执行任务想拆分时先上报请求用户决定
---
# PM 规矩写明请求拆分

## 目标
PM 读到的规矩和工具说明告诉它：待更新的已执行任务想拆分时，先上报请用户决定，不要先原地改写成大任务派出。

## 业务规则（来源：PRD split-request）
- C-13：PM 规矩写明：需求更新后复核判为受影响、已执行没完成的任务（占住目标）想拆分时，用 one_company_workflow_manage action=escalate 带 taskId 与 note（新版本怎么改的、想怎么拆）请求用户决定；用户选拆分后可取消它、把目标交给新任务，不需要等新的批准版本；用户选不拆就原地修改它本身（目标不能减少），本批准版本内不要再为它请求拆分。不要先把它原地改写成大任务派出。
- escalate 工具说明补上这种情形（待更新、已执行没完成、想拆分时可以上报）。
- 写法：说大白话，正面写现在怎么做，不写「不再 / 无需」之类过渡说法；不用「夹具」一词。

## 涉及文件
- role-rules/pm.md（修改：第 23 行「收到已批准的需求更新时」那一条）
- src/app/daemon/pm-tools.ts（修改：workflow_manage 工具说明里 escalate 的部分）

## 函数清单
### role-rules/pm.md
| 位置 | 职责 |
|---|---|
| 「收到已批准的需求更新时…」一条 | 在「已执行过、没完成的任务，用户没对它选调整或拆分时只能修改它本身…」之后补上请求拆分的做法 |
### src/app/daemon/pm-tools.ts
| 位置 | 职责 |
|---|---|
| `workflow_manage` 的工具说明 | escalate 适用情形补一句：需求更新后受影响、已执行没完成的任务想拆分时 |

## 协作关系
role-rules/pm.md 由程序加进 PM 提示词；pm-tools.ts 的说明是 PM 看到的工具描述。两者只改文字，不改行为。

## 验证方式
- 测试入口：tests/role-rules.test.ts（读取 role-rules/pm.md 断言关键说法）；tests 中断言 pm-tools 工具说明的现有用例（grep `escalate` 找到）。
- 预期结果：
  - [ ] role-rules/pm.md 含「请求」「拆分」与 escalate 的说明，并写明用户选不拆后本批准版本内不要再请求。
  - [ ] workflow_manage 工具说明含「想拆分」时可 escalate 的情形。
  - [ ] 改动后的两个文件不含「不再」「无需」「夹具」。
