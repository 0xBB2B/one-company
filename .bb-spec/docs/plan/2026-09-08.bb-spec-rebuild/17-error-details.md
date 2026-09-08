---
name: error-details
description: 失败运行的错误详情原样提取、原始与清理错误分离、提交诊断合并、本机保存与读取及故障如实报告
---
# 错误详情

## 目标
完成后失败或停止不确定的运行都能按运行身份查到完整、未经改写的错误详情与提交诊断，保存与读取故障不掩盖原始错误。

## 业务规则（来源：spec）
- run-diagnostics：失败或无法确认停止时保存实际取得的错误说明、名称、堆栈、底层原因、错误码、状态码、请求标识与运行身份、模型、失败时间；原文不按长度截断；原始错误与后续清理错误分别保留；缺少原因如实标注，不推断；原样保存不作改写，只在本机保存，正常成功运行不新增；按运行身份可定位，界面摘要有界但详情不截断；保存或读取失败明确报告，不覆盖原始失败、不伪报保存成功、不增加重试；发生过结构化提交时保存每次提交的标识、有效与接受状态、错误、重复与冲突次数，尝试数与有效数分开，不保存提交正文。

## 涉及文件
- 新建：`runtime/error-details.ts`
- 新建：`tests/error-details.test.ts`

## 成品定义

`error-details.json`（文件权限 0600）：

```json
{
  "version": 1,
  "runId": "<uuid>",
  "model": { "provider": "…", "id": "…" },
  "failedAt": "<UTC RFC3339>",
  "original": { "message": "…", "name": "…", "stack": "…", "cause": { "…递归…" }, "fields": { "code": "…", "status": 0, "requestId": "…" }, "noAdditionalCause": true },
  "cleanup": [ { "…同 original 结构…" } ],
  "submissions": { "attemptCount": 2, "validCount": 1, "attempts": [ { "toolCallId": "…", "valid": true, "accepted": true, "error": null, "duplicateEvents": 0, "conflictingEvents": 0 } ] }
}
```

## 函数清单
### runtime/error-details.ts
| 函数 | 职责 |
|---|---|
| `extractErrorDetail` | 从任意错误对象递归提取说明、名称、堆栈、原因链与已知字段，环引用标记不可用，不序列化请求/响应容器 |
| `writeErrorDetails` | 把原始错误、清理错误与提交诊断合并写入运行目录，重复写入保留最早失败时间并去重清理错误 |
| `readErrorDetails` | 读取并校验文档结构与计数，损坏返回不可读状态 |
| `summarizeErrorDetails` | 生成有界摘要（保存状态、路径、首行说明）供界面与运行记录使用 |

## 协作关系
`daemon/run-manager.ts` 在运行失败或停止不确定时调用 `extractErrorDetail` 与 `writeErrorDetails`，把 `summarizeErrorDetails` 写入运行记录；`runtime/result.ts` 的 `diagnostics` 作为 `submissions` 输入；窗口经 `runs.get` 取得摘要，查看页按需读取完整详情。

## 验证方式
- 测试入口：四个导出函数，输入为构造的错误对象与临时运行目录
- 测试输入：4001 与 50001 字符的错误原文；三层 cause；只有 "terminated" 的错误；含 `Bearer x`、`api_key="…"`、`https://u:p@host` 的原文；原始错误后再写一条清理错误；篡改文件把 message 改成数字、把 attemptCount 改成负数；写入目标不可写
- 预期结果：长原文完整保留；原因链逐层保留；仅 terminated 时 `noAdditionalCause` 为真且不补造；含凭据的原文与状态码、请求标识一字不改地保留；两次写入后 original 不变、cleanup 增加一条；损坏文件读取返回不可读且不伪造；写失败返回带原因的失败状态且不抛出到调用方
- [ ] 不截断与原因链
- [ ] 原文原样保留
- [ ] 原始/清理分离与合并
- [ ] 提交诊断计数校验
- [ ] 写读故障如实
