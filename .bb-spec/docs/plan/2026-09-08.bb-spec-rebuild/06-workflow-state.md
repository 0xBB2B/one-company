---
name: workflow-state
description: 需求阶段与任务进度的本机状态模型、随形状声明的门禁谓词、受控回退、以运行身份为证据的绑定核对与续接核对
---
# 需求与任务状态机

## 目标
需求的 8 个阶段与任务的 4 种进度只能按形状声明的门禁推进或经受控回退，完成证据来自运行记录并与定义/代码版本绑定，续接前能核对原运行。

## 业务规则（来源：spec）
- state-transitions：需求阶段限于 draft、confirmed、planned、executing、reviewing、accepting、accepted、rejected；任务进度限于 todo、doing、done、failed；拒绝未知值与把子运行状态写成任务进度。正常推进逐阶段核对前提：确认需用户确认回执，规划完成需规划产物核验，执行需调度就绪，审查需全部任务完成，验收需匹配版本的白盒 PASS，完成需黑盒结构化结果与指定报告一致。任务先登记 doing 再关联子运行；done 需合法交付与成功验证，有本次提交时核对提交信息，无改动时须有既有实现已满足的证据；失败记 failed 与原因；启动回执或子运行结束不得直接完成任务。返修、规划退回或产品变更须核对原运行停止、授权范围与对应决定后才回退；仅产品裁决可置 rejected，纯技术失败保持阻塞；已完成需求不原地重开。
- workflow-shape：形状含任务集、每任务角色序列与门禁声明；确认后才执行；声明不含某门禁时须有用户决定记录，缺记录不得执行。
- data-ownership：需求阶段、任务运行字段、返修轮次、阻塞原因与开发现场只保存在本机；定义文档不因运行更新变化。
- version-bound-recovery：完成状态与审查验收证据须核对对应定义、代码与工作现场，版本改变时标待重新核对并拒绝沿用；续接先核对原运行与停止情况，缺失或损坏时报告阻塞，不初始化为完成。

## 涉及文件
- 新建：runtime/workflow-state.ts
- 新建：tests/workflow-state.test.ts

## 函数清单

### runtime/workflow-state.ts
| 函数名 | 职责 |
|---|---|
| `initRequirementState` | 创建需求状态文档：阶段 draft、任务表空、后续问题清单空、version 1；已存在则拒绝 |
| `readRequirementState` | 读取状态与 version，损坏时抛"损坏"而非空状态 |
| `updateTaskFields` | 在 version 一致时更新任务的 note、agent、commit、description 等普通字段与需求的后续问题清单；拒绝未知字段与把阶段/进度混入普通更新 |
| `advanceStage` | 校验目标阶段是当前阶段按已确认形状声明的下一步（声明跳过的门禁对应阶段直接越过，以确认形状时记录的用户决定编号为证据），并对 `evidenceFromRun` 返回的运行结果执行该阶段门禁谓词，成立才写入新阶段与证据引用（runId） |
| `retreatStage` | 受控回退：reviewing→executing、accepting→executing、planned→confirmed；要求理由与决定编号，并核对该阶段关联的原运行已处于终态或中断；其他回退路径与 accepted 需求一律拒绝 |
| `gateForStage` | 返回某阶段的门禁谓词：需要的运行类型、结构化结果种类与判定 |
| `evidenceFromRun` | 按 runId 读取运行记录中守护进程写入的结构化结果，核对其绑定的需求、任务、定义指纹与代码 HEAD 与当前一致；缺失、绑定不符或版本不一致返回明确原因而非证据 |
| `recordShape` | 记录用户确认的形状与门禁声明及其确认决定编号；不含某门禁的声明必须附用户决定 |
| `registerTasks` | 由形状写入任务集（进度 todo），拒绝与已存在任务编号冲突 |
| `startTask` | todo 或 failed → doing 并记录运行标识 |
| `finishTask` | doing → done：以 runId 取运行结果，核对交付证据、验证成功、提交信息或无改动证据；任一缺失拒绝并说明 |
| `failTask` | doing → failed 并记录原因与返修轮次 |
| `rollbackTask` | done/failed → todo：要求原运行已停止的证明与决定编号 |
| `rejectRequirement` | 仅在提供用户裁决决定时置 rejected |
| `bindEvidence` | 把 runId 对应的审查或验收结果与定义指纹、代码 HEAD、工作目录绑定后写入 evidence 文件 |
| `checkEvidence` | 核对证据版本与当前定义指纹、代码 HEAD 是否一致，不一致返回"待重新核对" |
| `checkResume` | 续接核对：状态存在且未损坏、原运行终态、证据版本；返回可续接位置或阻塞原因 |
| `skippedGates` | 返回形状声明跳过的门禁及其决定编号 |

## 协作关系
- 读写经 `runtime/store.ts`；路径经 `runtime/identity.ts`；决定编号由 `runtime/decisions.ts` 核对存在；运行记录经 `runtime/run-store.ts` 读取。
- 所有需要证据的动作只接收 runId，不接收调用方拼装的证据对象；守护进程在运行结束时把结构化结果连同需求、任务与版本绑定写入运行记录。
- 守护进程的 run-manager 在派工前调用 `startTask`，交付核对后调用 `finishTask` 或 `failTask`；主会话在提交前审查失败时经工具调用 `retreatStage`。

## 验证方式
- 测试入口：`runtime/workflow-state.ts` 导出函数
- 测试输入：隔离数据区中的需求状态与运行记录夹具（含结构化结果与需求/任务/版本绑定）、决定编号、定义指纹与代码 HEAD
- 预期结果：
  - 提交未知阶段、未知进度或把运行状态 paused 写成任务进度均被拒绝，原值不变，错误列出合法集合
  - 从 draft 依次推进到 accepted，每一步 runId 指向的运行缺少对应结果时保持原阶段并给出缺失原因；直接 draft → accepted 被拒绝
  - runId 指向的运行结果绑定另一需求、另一任务或定义指纹/代码 HEAD 不一致时推进被拒绝并说明不匹配项
  - 形状声明不含黑盒验收且附用户决定时，可从 reviewing 直接进入 accepted 并记录跳过依据；无决定时拒绝
  - `startTask` 后进度为 doing；只有启动回执、交付失败、验证失败、有提交但未核对四种情况 `finishTask` 均拒绝；条件齐全或无改动且有既有证据时完成
  - `retreatStage` 三条允许路径在原运行为终态或中断且附理由与决定编号时成功并记录；原运行仍活动、缺决定编号、accepted 需求、executing→planned 等未列路径均被拒绝
  - 两个调用方读同一 version 后先后更新，后者得到版本冲突
  - `bindEvidence` 后修改定义指纹再 `checkEvidence` 返回待重新核对；`checkResume` 对缺失状态、损坏状态、原运行未停止分别返回明确阻塞而不初始化
  - `rejectRequirement` 无用户决定被拒绝；已 accepted 的需求 `rollbackTask` 被拒绝
- [ ] 集合与非法值
- [ ] 随形状声明的逐阶段门禁与跳过
- [ ] 运行结果绑定核对
- [ ] 任务完成条件
- [ ] 受控回退
- [ ] 证据版本失效与续接核对
