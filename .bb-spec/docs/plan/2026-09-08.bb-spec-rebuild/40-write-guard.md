---
name: write-guard
description: 写入与共享分支守卫：写入前对照他人占用；命令前后按 git 变更路径与占用范围交集核指纹、比对 HEAD 与分支，越界或切换即判本运行失败并使受影响验证失效；范围路径提交与审查快照
---
# 写入与共享分支守卫

## 目标
未获准的写入在编辑与写文件路径上被拦下，无法静态确认范围的命令在执行后被核对，分支现场被改动即被发现，越界写入不能被当作正常交付；提交不混入他人改动，审查结论只对应被审内容。

## 业务规则（来源：spec）
- range-handoff：重叠写入只由一个任务获准；未获准的写入不得发生。
- range-handoff：执行无法静态确认写入范围的命令时，启动前记录其他任务所占范围的内容指纹，结束后核对；发现越界修改即把本任务判为失败并使受影响范围的验证结论失效，不依赖口头提醒。
- validation-consistency：验证期间或放行前发现验证对象变化，拒绝沿用旧通过结论并要求重新核对。
- validation-consistency：多个宿主在共享工作目录提交时只把本任务获准范围内的路径纳入提交；其他宿主存在活动任务时必须在修改发生前拒绝切换分支或重置共享现场，事后判违规不能代替保护。
- validation-consistency：完整分支审查保持既定范围与裁决要求，无法取得一致验证现场时等待或阻塞，不假报通过。
- whitebox-review：记录审查快照（分支头与内容指纹）；对象与快照一致才允许远端写入；远端写入前重新采集的快照也必须一致。
- workspace-coordination：需求代理与角色不得读写其他仓库。

## 涉及文件
- 新建 `runtime/write-guard.ts`
- 新建 `runtime/branch-guard.ts`
- 修改 `runtime/shell-bash.ts`：`createManagedBashOperations` 与 `createManagedBashTool` 都接受可选 `guard?: { before(): Promise<token>; after(token, outcome): Promise<violations> }` 并透传；`before` 在注册中止监听之前调用（抛错则命令不执行）；`after` 在成功、失败、超时、中止路径都调用，其返回的违规清单在成功与失败/超时路径都附加到命令结果（失败时并入错误文本）供模型看到；违规随每次调用绑定而非工具实例级变量；后台命令在 spawn 前调用 before、在任务终态回调里调用 after，该异步链带 catch 不得逃逸为未处理拒绝
- 新建 `runtime/git-snapshot.ts`，`extensions/dispatch.ts` 改为调用它
- 新建 `tests/write-guard.test.ts`
- 新建 `tests/shared-branch-guard.test.ts`

## 函数清单
### runtime/write-guard.ts
| 函数名 | 职责 |
|---|---|
| `checkWrite` | 对 edit/write 目标路径：以最深已存在祖先的 realpath 拼余段做规整（符号链接指向仓库外即拒绝），核对在本仓库内，并以 realpath 后的仓库相对路径（而非词法路径）做范围与占用判定（复用 ranges.ts 的范围规整，目录范围以 `dir/` 后缀且含其下全部路径；经符号链接落到他人占用或范围外即拒绝并说明落点），返回允许或拒绝原因；writePaths 自身逃逸同样以 `{ allowed:false }` 返回 |
| `changedPaths` | 读取 `git status --porcelain=v1 -z -uall` 得到工作区变更路径（含未跟踪；重命名条目同时纳入新旧两条路径，拷贝只纳入新路径） |
| `snapshotForeignRanges` | 命令执行前：取变更路径与其他持有者占用范围的交集，计算这些文件的指纹（无交集时快照为空） |
| `verifyAfterCommand` | 命令结束后：重新取变更路径与他人范围的交集，交集中新出现的路径或指纹变化的路径即为越界清单 |
| `snapshotWorkspace` / `verifyWorkspace` | 只读角色用：命令前后对整个工作区变更路径集合与其指纹（`Record<path, fingerprint>`）比对，新增、消失、指纹变化三类都算写入，返回清单（可排除给定路径） |
| `reportViolation` | 先使受影响验证失效再把越界结果写入运行记录（状态 failed、原因含文件清单；运行已终态时只补原因不抛），并把违规清单回传调用方 |
| `invalidateValidations` | 把**被越界的持有者**（他人任务所属需求）关联该范围的全部阶段验证结论标记为失效：经 workflow-state 的 `invalidateEvidence(ctx, stage, reason)` 覆写证据为失效载荷（阶段仍被列出、`checkEvidence` 返回未通过、`checkResume` 因此阻断并附原因），不删除文件；按持有者需求分组逐个处理 |
| `beforeCommand` / `afterCommand` | 组合入口（`windows`、`windowId`、`runStore` 均必填，缺失即抛，不允许静默关闭分支守卫）：前置采集他人范围指纹与分支状态，后置核对并在越界或（存在其它活动宿主时）切换/重置时 `reportViolation`（分支违规同样标 failed 并进违规清单）；`afterCommand` 返回违规清单供调用方呈现 |
### runtime/git-snapshot.ts（新建，从 extensions/dispatch.ts 抽出）
| 函数名 | 职责 |
|---|---|
| `collectGitSnapshot` | `git rev-parse HEAD` + 分支名 + `status --porcelain=v1 -z -uall` + `diff HEAD --binary` + 未跟踪条目（lstat：常规文件内容、符号链接目标串、不可读/其它类型标记、超 64 MiB 只喂大小）长度前缀哈希；timeout 10s、maxBuffer 64 MiB、LC_ALL=C、可传 signal |
### runtime/branch-guard.ts
| 函数名 | 职责 |
|---|---|
| `snapshotBranchState` | 命令前记录 HEAD 提交与当前分支名（含 detached） |
| `verifyBranchState` | 命令后重新读取并比对；分支名变化、或新 HEAD 不是旧 HEAD 的后代（`git merge-base --is-ancestor` 失败，即 reset/checkout 到别处）才算"切换/重置"，本分支快进提交只记变化不算违规；存在其他活动宿主时切换/重置返回违规与宿主清单，无其他活动宿主时只返回变化事实；不做命令文本匹配 |
| `activeForeignHosts` | 汇总其它存活窗口（非本窗口）与守护进程内其它 runId 的运行中任务（跨需求，`RUNNING_LIKE_STATES` 取自 run-store）作为违规原因 |
| `scopedCommitPaths` | 由本任务获准范围与工作区改动交集得出可提交路径清单，排除他人范围内的改动；重命名只有新旧路径都在获准范围内才整条纳入，一端在范围外的重命名剔除并作为阻断原因返回 |
| `reviewSnapshot` | 采集分支名、分支头、工作区差异与未跟踪文件内容的哈希组成快照（算法与 dispatch 的审查快照共用 `runtime/git-snapshot.ts`，不复制）；git 子进程超时/超限时返回"无法采集"裁决而非抛出 |
| `verifySnapshot` | 远端写入前重新采集并比对，返回一致或差异 |

## 协作关系
- 依赖 `runtime/ranges.ts`（占用与指纹）、`runtime/run-store.ts`（标记失败）、`runtime/workflow-state.ts`（失效标记）、`runtime/identity.ts`（仓库边界）、`runtime/windows.ts` 与 `runtime/daemon-client.ts`（活动宿主）、SDK `exec` 执行 git 命令。
- `runtime/shell-bash.ts` 在主会话与角色的每条 bash 前后调用 `beforeCommand` / `afterCommand`；角色侧 edit/write 的 `checkWrite` 与只读角色的 `snapshotWorkspace` / `verifyWorkspace` 由 `daemon/role-session.ts` 接入；主会话侧 edit/write 钩子由 `extensions/shell-ui.ts` 接入。
- `skills/git-push` 流程调用 `scopedCommitPaths`、`reviewSnapshot`、`verifySnapshot`（经主会话 bash 可调用的入口脚本）。
- 生产接线：角色侧 bash 的 guard 由 23 role-session 经 `createManagedBashTool({ guard })` 注入（23 在飞，随其收口）；主会话侧 bash 与 `user_bash`（用户手敲 `git switch`）的 guard 接线归 35 shell-page/shell-ui。
- `changedPaths` 的权威定义在 `runtime/git-snapshot.ts`，write-guard 不再转发导出。

## 验证方式
- 测试入口：`checkWrite`、`beforeCommand` + `afterCommand`、`snapshotWorkspace` / `verifyWorkspace`、`verifyBranchState`、`scopedCommitPaths`、`reviewSnapshot` / `verifySnapshot`（临时 git 仓库，用真实子进程命令写文件与操作 git）
- 测试输入：他人占用文件 A 与目录 D/；本任务范围 B；命令 `echo x >> A`、只写 B、在 D/ 下新建未跟踪文件、修改他人范围外的大量文件；跨仓库路径；验证结论关联 A；命令 `git switch other`、`git checkout main`、`git reset --hard HEAD~1`、一段用别名切换分支的脚本、`git status`；另一窗口活动记录存在与不存在；工作区同时改动本范围文件与他人范围文件；采集快照后修改一个未跟踪文件
- 预期结果：
  - 对 A 的 edit/write 被拒绝并说明持有者；对 B 允许；跨仓库路径被拒绝；范围声明为目录 `dir/` 时其下文件允许；仓库内符号链接指向仓库外时写入被拒绝。
  - 越界命令后 `afterCommand` 返回 A；D/ 下新建文件被返回；`git mv A A2` 也被返回；运行记录标 failed 且原因含路径；**持有 A 的任务所属需求**关联 A 的全部阶段验证结论标失效（本任务的证据不动），且该需求的 `checkResume` 之后返回未通过并附失效原因；仓库内符号链接指向他人占用目录时 `checkWrite` 拒绝、指向本范围另一目录时允许；命令内本分支快进提交在存在活动宿主时不判违规；命令超时且有越界时违规文本仍出现在结果；同一运行第二次越界或运行已终态时失效仍然发生且不抛；只写 B 的命令核对通过，运行状态不变；他人范围外的大量改动不触发核对成本以外的任何判定。
  - 存在活动宿主时四种切换/重置方式（含别名脚本）在命令后均被判违规并列出宿主，`git status` 不触发；无活动宿主时只报告变化不判违规。
  - `verifyWorkspace` 对只读角色的写入返回清单（含修改命令前已 dirty 的文件、还原为干净的文件），排除路径的写入不返回。
  - 可提交路径只含本范围文件（本范围内重命名同时含新旧路径）；修改未跟踪文件后 `verifySnapshot` 报告不一致；git 超时时 `verifySnapshot` 返回不一致/无法采集而不抛。
  - `beforeCommand`/`afterCommand` 组合：存在其它存活窗口时命令切换分支被判违规并列出宿主；`activeForeignHosts` 对"另一窗口记录存在/不存在"与"其它 runId 运行中"各有用例。
  - shell-bash：经 `createManagedBashTool` 注入 guard 时每条 bash 前后调用；命令超时/中止路径 after 仍调用；后台命令 before/after 也调用；after 返回的违规出现在命令结果文本中。
- [x] 路径写入拒绝与放行
- [x] 交集指纹核对与越界判失败、验证失效
- [x] 分支/HEAD 前后比对
- [x] 只读角色工作区核对
- [ ] 实际 Shell 提交只包含获准范围，其他宿主活动时切换与重置在修改前拒绝

## 实际入口复核

隔离仓库复现了共享暂存区混入提交和切换后才判违规，均不满足验收。辅助函数的单独测试不作为实际 Shell 的通过证据。生产范围组合入口是 createRangeProtection；旧 beforeCommand/afterCommand 组合及仅被测试调用的包装需要迁移行为测试并删除。
