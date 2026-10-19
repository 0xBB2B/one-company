---
name: 09-change-apply-auto-resume
description: worker 写入 apply、import 去掉 operationId，程序按本运行里同一批文件自动续写
---
# worker 写入：程序按同一批文件自动续写

## 目标
worker 调 `change_apply` 的 apply、import 参数里没有 operationId。没写完的那批文件，worker 带同样的文件再调一次，程序就接着写完。

## 业务规则（来源：PRD 01-program-generated-ids C-1、C-2、C-3、C-4、C-5，决策记录"续做由程序按内容认出，模型不填操作编号"）
- apply、import 不接受 operationId，带了就是参数不合格（C-1）。status 动作的 operationId 是"查以前那批写入"的引用编号，仍然必填。
- apply、import 结果照旧返回本次操作编号，供 status 查询（C-2）。工具说明不出现"新生成""UUIDv7"，也不要求模型填写 apply、import 的编号（C-3）。
- 续写（C-4）：本运行里有一批没写完的写入（状态 applying 或 partial_failure），worker 带同样的文件（同样的路径、baseHash、内容）再调 → 程序用那批的编号续写，结果编号等于原编号，最终 applied。
- 内容不同（C-5）：本运行里有一批没写完的写入、这次又是另一批文件 → 被拒，报错写明"本运行还有一批没写完的文件"，建议先带同样的文件再调一次把它写完。
- 写入记录建好后异常结束时，报错建议"带同样的文件再调一次可以续写"，不附编号。
- 状态为 stale（文件被外部改过）或 applied 的记录不算没写完，不挡新的写入。

## 涉及文件
- 修改 `src/modules/verification/change-apply.ts`
- 修改 `src/modules/pm/subagent-tools.ts`
- 修改测试：`tests/change-apply.test.ts`、`tests/verification-run.test.ts`

## 成品定义
change-apply.ts 原因与建议表（替换 operation_conflict，删除 resume_not_found、resume_finished）：
```ts
operation_conflict: { why: "本运行还有一批没写完的文件", next: "先带同样的文件再调一次把它写完，再写新的" },
```
subagent-tools.ts 说明末尾那句改为：
```text
结果显示没写完（applying 或 partial_failure）或写入中途报错时，带同样的文件再调一次就会接着写完。status 填要查的那次写入的 operationId。
```
写入记录建好后异常结束时，原因后面附上"带同样的文件再调一次可以续写"。

## 函数清单
### src/modules/verification/change-apply.ts
| 函数名 | 职责 |
|---|---|
| 参数 schema（修改） | apply、import 删除 operationId；status 不变 |
| `run`（修改） | 在本运行的写入记录里，找状态为 applying 或 partial_failure 的那批：intentHash 相同 → 用它的编号续写；不同 → `operation_conflict`；没有 → `uuidv7()` 新建。删除按模型编号续写的判断与 resume_* |
| `unfinishedSet`（新建） | 返回本运行（`ownSet` 成立）里状态为 applying 或 partial_failure 的那批写入记录，没有返回 null |

### src/modules/pm/subagent-tools.ts
| 函数名 | 职责 |
|---|---|
| change_apply 注册（修改） | 说明改成成品定义的文字 |

## 协作关系
- 写入记录绑定 runId，跨运行不续写，这一点不变。

## 验证方式
- 测试入口：change_apply 工具（`tests/change-apply.test.ts` 现有封装）。
- 预期结果：
  - [ ] apply、import 带 operationId → invalid_shape；不带 → 成功，结果带编号，两次编号不同。
  - [ ] 制造 partial_failure 后，带同样的文件再调 → applied，结果编号等于原编号。
  - [ ] 日志提交失败（写入记录建好后异常结束）后，带同样的文件再调 → applied。
  - [ ] 有一批 partial_failure 时，带另一批文件调 apply → 被拒，原因"本运行还有一批没写完的文件"，文件没有变化。
  - [ ] 状态为 stale 的记录存在时，新的写入照常成功。
  - [ ] status 仍要求 operationId，能查到本运行的写入。
  - [ ] 说明与报错里没有"新生成""UUIDv7"；"重新生成文件"那句保留。
