---
name: direct-pre-review
description: 提交前审查由主 agent 单次直接调用白盒审查者，只依据结构化裁决与审查快照决定是否远端写入
---
# 提交前审查直接裁决

## 目的
让提交前审查不经过 workflow，主 agent 拿到一个可完整校验的结构化对象后再决定推送。

## 逻辑
主 agent 记录审查快照（分支头与内容指纹），以一次直接调用派工白盒审查者，输入为仓库位置、基线、规范与验收、审查重点和快照，并传入审查裁决的结构化 Schema。审查者提交的对象顶层字段精确为 `phase`、`verdict`、`summary`、`issues`、`evidence`、`reviewedHead`、`contentFingerprint`、`traceability`、`findings`。主 agent 核对对象与快照一致后才允许 push 或创建 PR/MR；远端写入前重新采集的快照也必须一致。

## 约束
- C-1：当系统执行提交前审查时，系统应由主 agent 以一次直接调用派工白盒审查者，不得为该审查启动 workflow，并仅依据结构化对象的 `verdict`、阶段专用字段与审查快照一致性决定是否允许远端写入。
- C-2：当白盒审查者返回 PASS 时，系统应要求 `issues` 与 `findings` 为空、`traceability` 与 `evidence` 非空，且 `reviewedHead` 与 `contentFingerprint` 精确等于调用方快照。
- C-3：如果白盒审查者未提交对象、对象未通过 Schema、字段语义矛盾或与审查快照不一致，系统应把门禁视为 FAIL，保留本地提交，不执行任何远端写入并显示具体原因。

## 例子
用户在功能分支上执行提交前审查，主 agent 记录分支头与指纹，直接调用白盒审查者，收到 `verdict: PASS` 且快照一致的对象，随后推送分支；界面上没有出现 workflow。

## 验收
### AC-1 直接调用并以结构化对象裁决  ← C-1, C-2
- 触发: 操作 执行提交前只读审查
- Given: 白盒审查者作为门禁被主 agent 直接调用，审查快照已记录
- When: 审查者提交字段集合、PASS 语义与快照均符合约定的对象
- Then: 界面没有为该审查显示 workflow，系统允许远端写入

### AC-2 非法结果失败关闭  ← C-3
- 触发: 操作 让白盒审查者不提交对象、提交额外字段、字段缺失、字段矛盾或快照不一致的结果
- Given: 本地提交已完成，远端尚未写入
- When: 审查者调用结束
- Then: 系统把门禁视为 FAIL，显示校验失败的具体原因，不执行远端写入，本地提交保持不变
