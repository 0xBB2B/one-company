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

## 成品定义

需求状态记录（仓库 SQLite 的 `requirements` 命名空间，业务键为需求名，UUIDv7 主键与 version 由数据库管理）：

```json
{ "requirement": "<reqId>", "stage": "draft",
  "shape": null,
  "tasks": { "<taskId>": { "progress": "todo", "runId": null, "description": "", "agent": "", "note": "", "commit": null, "blockedReason": "", "workspaceDir": "", "reason": "", "repairRound": 0 } },
  "followUps": [],
  "history": [ { "stage": "confirmed", "at": "<UTC>", "runId": null, "decisionId": "U-1", "reason": null } ] }
```

`shape`（`recordShape` 写入）：`{ "tasks": [ { "id": "<taskId>", "roles": ["planner", "worker", "reviewer"] } ], "gates": { "plan": true, "whiteboxReview": true, "blackboxAcceptance": false }, "skipped": [ { "gate": "blackboxAcceptance", "decisionId": "U-3" } ], "acceptanceReport": "<报告位置或 null>", "decisionId": "U-2" }`；`gates` 为 false 的门禁必须在 `skipped` 中有用户决定编号。

运行记录 `result`（守护进程在运行结束时写入，本单元只读）：在结构化裁决对象（阶段 `plan|work|review|acceptance`，`plan` 只要求 `phase`、`verdict`、`summary`）之上附加绑定与交付：

```json
{ "phase": "work", "verdict": "PASS", "…结构化裁决字段…",
  "binding": { "requirement": "<reqId>", "task": "<taskId 或 null>", "definitionFingerprint": "<sha256>", "codeHead": "<git HEAD>", "cwd": "/abs" },
  "delivery": { "commit": "<sha 或 null>", "verificationOk": true } }
```

证据记录（仓库 SQLite 的 `evidence:<reqId>` 命名空间，业务键为 stage）：`{ "stage", "runId", "phase", "definitionFingerprint", "codeHead", "cwd", "boundAt" }`。

逐阶段门禁（目标阶段 ← 前提；"当前版本"由调用方传入的定义指纹与代码 HEAD 给出）：

| 目标 | 前提 |
|---|---|
| confirmed | 用户确认决定编号存在于本需求用户决策台账（所有需要用户决定的门禁只接受用户台账编号，AI 台账编号一律拒绝） |
| planned | runId 的运行已 completed、`phase=plan`、`verdict=PASS`、绑定本需求且版本一致；形状声明 `plan=false` 时凭 skipped 决定越过 |
| executing | 形状已记录且任务集已登记 |
| reviewing | 全部任务 done |
| accepting | runId 的运行 `phase=review`、`verdict=PASS`、绑定本需求且版本一致；`whiteboxReview=false` 时凭决定越过 |
| accepted | runId 的运行 `phase=acceptance`、`verdict=PASS`、验收结果 accepted、报告位置等于形状的 `acceptanceReport`、绑定本需求且版本一致；`blackboxAcceptance=false` 时凭决定越过 |

`finishTask` 条件：runId 的运行 completed、`phase=work`、`verdict=PASS`、绑定本需求与本任务且版本一致、`delivery.verificationOk=true`；`changedFiles` 非空时 `delivery.commit` 非空且在绑定 cwd 的仓库中存在；`changedFiles` 为空时须 `workState=green-baseline-no-change` 且 `preexistingEvidence` 非空。

## 函数清单

### runtime/workflow-state.ts
| 函数名 | 职责 |
|---|---|
| `initRequirementState` | 创建需求状态文档：阶段 draft、任务表空、后续问题清单空、version 1；已存在则拒绝 |
| `readRequirementState` | 读取状态与 version，损坏时抛"损坏"而非空状态 |
| `updateTaskFields` | 在 version 一致时更新任务的 note、description、agent、commit、blockedReason、workspaceDir 与需求的后续问题清单；拒绝未知字段与把阶段/进度混入普通更新 |
| `advanceStage` | 校验目标阶段是当前阶段按已确认形状声明的下一步（声明跳过的门禁对应阶段直接越过，以确认形状时记录的用户决定编号为证据），并对 `evidenceFromRun` 返回的运行结果执行该阶段门禁谓词，成立才写入新阶段与证据引用（runId） |
| `retreatStage` | 受控回退：reviewing→executing、accepting→executing、planned→confirmed；要求理由与用户决定编号；本需求名下存在任何未停止（非终态且非 interrupted，含 paused/waiting_answer/queued）的运行即拒绝并列出其标识，不接收调用方指定的运行；history 登记的原运行只用于溯源。陈旧的 queued/running 记录只能由守护进程启动时的中断标记解封 |
| `gateForStage` | 返回某阶段的门禁谓词：需要的运行类型、结构化结果种类与判定 |
| `evidenceFromRun` | 按 runId 读取运行记录中守护进程写入的结构化结果，核对其绑定的需求、任务、定义指纹与代码 HEAD 与当前一致；缺失、绑定不符或版本不一致返回明确原因而非证据 |
| `recordShape` | 记录用户确认的形状与门禁声明及其确认决定编号；不含某门禁的声明必须附用户决定 |
| `registerTasks` | 由形状写入任务集：新编号写入 todo，已存在编号沿用其记录（进度与返修轮次不重置，供回退后重记形状） |
| `startTask` | todo 或 failed → doing 并记录运行标识 |
| `finishTask` | doing → done：以 runId 取运行结果，核对交付证据、验证成功、提交信息（commit 须为 7–40 位十六进制且存在于绑定 cwd 的仓库，绑定 cwd 须落在本需求仓库内，git 调用带超时）或无改动证据；任一缺失拒绝并说明 |
| `failTask` | doing → failed 并记录原因与返修轮次 |
| `rollbackTask` | done/failed → todo：要求原运行已停止的证明与决定编号 |
| `rejectRequirement` | 仅在提供用户裁决决定时置 rejected |
| `bindEvidence` | 把 runId 对应的审查或验收结果与定义指纹、代码 HEAD、工作目录绑定后写入 evidence 文件 |
| `checkEvidence` | 核对证据版本与当前定义指纹、代码 HEAD 是否一致，不一致返回"待重新核对" |
| `checkResume` | 续接核对：状态存在且未损坏、原运行已停止、已绑定证据与传入的当前版本一致；返回可续接位置与当前 version，或阻塞原因（含待重新核对） |
| `skippedGates` | 返回形状声明跳过的门禁及其决定编号 |

所有变更函数的失败结果为 `{ ok: false, reason, staleVersion?: true }`：版本冲突时 `staleVersion` 为 true 且 reason 只陈述事实（"版本已变化"），重试提示由调用方追加。

## 追加（40 write-guard 联动）
- `invalidateEvidence(ctx, stage, reason)`：把该阶段证据覆写为失效载荷（保留阶段可列出，`checkEvidence` 返回未通过并附原因，`checkResume` 阻断）；`listEvidenceStages(ctx)` 列出已存在证据的阶段。

## 协作关系
- 读写经 `runtime/store.ts`；路径经 `runtime/identity.ts`；决定编号由 `runtime/decisions.ts` 核对存在；运行记录经 `runtime/run-store.ts` 读取。
- 所有需要证据的动作只接收 runId 与当前版本（定义指纹、代码 HEAD），不接收调用方拼装的证据对象；守护进程在运行结束时把结构化结果连同需求、任务与版本绑定写入运行记录。
- 守护进程的 run-manager 在派工前调用 `startTask`，交付核对后调用 `finishTask` 或 `failTask`；主会话在提交前审查失败时经工具调用 `retreatStage`。

## 验证方式
- 测试入口：`runtime/workflow-state.ts` 导出函数
- 测试输入：隔离数据区中的需求状态与运行记录夹具（含结构化结果与需求/任务/版本绑定）、决定编号、定义指纹与代码 HEAD
- 预期结果：
  - 提交未知阶段、未知进度或把运行状态 paused 写成任务进度均被拒绝，原值不变，错误列出合法集合
  - 从 draft 依次推进到 accepted，每一步 runId 指向的运行缺少对应结果时保持原阶段并给出缺失原因；直接 draft → accepted 被拒绝
  - runId 指向的运行结果绑定另一需求、另一任务或定义指纹/代码 HEAD 不一致时推进被拒绝并说明不匹配项
  - 形状声明不含黑盒验收且附用户决定时，可从 reviewing 经 accepting 进入 accepted 而不需要验收运行，并记录跳过依据；无决定时记录形状被拒绝
  - `startTask` 后进度为 doing；只有启动回执、交付失败、验证失败、有提交但未核对四种情况 `finishTask` 均拒绝；条件齐全或无改动且有既有证据时完成
  - `retreatStage` 三条允许路径在原运行为终态或中断且附理由与决定编号时成功并记录；原运行仍活动、缺决定编号、accepted 需求、executing→planned 等未列路径均被拒绝
  - 两个调用方读同一 version 后先后更新，后者得到版本冲突
  - `bindEvidence` 后修改定义指纹再 `checkEvidence` 返回待重新核对；`checkResume` 对缺失状态、损坏状态、原运行未停止分别返回明确阻塞而不初始化
  - `rejectRequirement` 无用户决定被拒绝；已 accepted 的需求 `rollbackTask` 被拒绝
- [x] 集合与非法值
- [x] 随形状声明的逐阶段门禁与跳过
- [x] 运行结果绑定核对
- [x] 任务完成条件
- [x] 受控回退
- [x] 证据版本失效与续接核对

阶段或任务完成与证据绑定在同一短事务提交；外部核验前读取证据版本，提交时比较身份和版本，核验期间发生失效操作时拒绝旧绑定。
