# M6 状态

阶段目标：需求关闭后文件仍在，专用入口拒读，PM/子会话结束且不复用；通知主代理并建议清空，主会话既有内容及通用工具旁路不承诺全面消除。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 真实记录退出码/超时/取消/未运行与 debug/formal 类别；自填 PASS 不构成通过；debug 不能升级为正式证据 | 通过 | tests/verification-run.test.ts（提交 639456e）：exit 0/3、SIGKILL 超时、stop 取消；run 参数不接受 status/verdict/exitCode/baseline；worker 只能 debug、pm/reviewer/qa 只能 formal；直写记录改 kind/checkRoundId/baseline 后 formalEvidence 报 round_binding_invalid；事务失败不留半条记录 | 非 darwin 平台无沙箱后端时 formal 记 not_run，未在其他平台验证 |
| AC2 代码/spec/断言/环境变化使证据不适用；prod 变化逐任务复核；旧结果保持不变；重填 hash 不恢复 PASS | 通过 | tests/verification-run.test.ts AC2/AC14 用例：src/spec 改动后 input_changed、还原后再适用（内容级）、直写 inputHash 报 round_binding_invalid+input_changed、批准新 prod 后 prod_changed 且原记录状态仍 passed；tests/pending-update.test.ts AC17：pendingRevision 登记与 assessUpdate 逐任务复核 | 环境指纹只含 node/platform/arch |
| AC3 completed 预检缺项即失败且不进入 closing、不提升 epoch、不撤权；取消/拒绝只核对授权与停止条件 | 通过 | tests/workflow-close.test.ts（提交 6e498d6）AC3/AC21：缺证据/授权/角色运行中均返回 missing，版本、epoch、PM 租约、QA 读取不变；cancelled 无需验收即 closed | 无 |
| AC4 关闭后 prod 原文件字节保留、人工可读；六类角色经核心入口读正文均拒绝；索引与上下文不加载归档 | 通过 | tests/workflow-close.test.ts AC6/AC4：closed 后本机 prod.md 字节相同；requirement_manage 读取拒绝、metadata 只回身份/状态；M5 既有 tests/requirement-read-tool.test.ts、tests/prod-exclusion.test.ts、tests/knowledge-query.test.ts 回归 | 通用工具旁路按 §5.7 暂缓 |
| AC5 自有查询/diff/事件/缓存不提供 closed 正文；旧 PM/子会话及摘要不续接、不移入新 PM | 通过 | tests/explore-session.test.ts（提交 88a1b6d）AC5/AC7：closing/closed 后 openSessionManagerForRun 返回 closed，新运行会话无旧消息；M5 既有 closed 拒读用例回归 | 主会话既有消息/摘要不清理，按 §10.4 披露 |
| AC6 closing 生效即拒绝读取/输出/派工/prod 写入/spec 发布；收尾失败保持 closing 与拒读，不回 active；收尾未完不登记 closed | 通过 | tests/workflow-close.test.ts AC6：stopAgents 抛错/未停止时保持 closing（epoch+1、PM 租约撤销、change_apply/verification_run/advance/读取全部拒绝）；再次调用只续办；代理停止后才 closed | 无 |
| AC7 真实完成、代理已结束且 closed 落库后才产生无正文完成通知；取消/拒绝/窗口退出/PM 崩溃不冒发 | 通过 | tests/workflow-close.test.ts：closed 前 notify 报 notice_missing；cancelled 通知不含"已完成"；tests/explore-session.test.ts：PM 运行 failed 不产生通知、status none | 主代理侧消费通知在 M7 接线 |
| AC8 当前 spec/code/test 仍可查；不为漏写规则再读历史 prod | 通过 | requirement_manage 对 closed 需求无正文动作（tests/requirement-read-tool.test.ts、tests/workflow-close.test.ts）；knowledge_query 与需求生命周期无关（tests/knowledge-query.test.ts 回归） | 无 |
| AC9 正常重启可续接、索引损坏只重建；不确定备份与人工同 UUID 归档不判完成 | 通过 | M1 既有 tests/requirement-recovery.test.ts、tests/database-recovery.test.ts、tests/requirement-state.test.ts（closed 后 archive_found 保持真实关闭原因）回归；CheckRoundService.open 崩溃对账（tests/verification-run.test.ts） | 无 |
| AC10 只有 completed 可归档；活动/取消/拒绝拒绝归档；中断可幂等恢复、不覆盖不同内容、不回显正文 | 通过 | tests/workflow-close.test.ts AC10：cancelled 归档报 archive_unavailable；目标已有不同内容时 blocked 且不覆盖；移除后归档字节 hash 一致；重复归档幂等；返回值不含正文 | 无 |
| AC11 预检通过后注入更新/变化/失效/授权变化/新写入，正式关闭被拒；重复关闭不重复副作用、不改原因 | 通过 | tests/workflow-close.test.ts AC11：代码变化→delivery_content_mismatch，prod 更新→pending_update，轮次落后→check_round_prod_mismatch，阻塞/未验证裁决→拒绝，受控写入后拒绝；同 operationId 重复 close 只有一个 closed 事件与一条通知；不同 reason/operationId→close_intent_conflict | 无 |
| AC12 最终检查前本轮 worker 与写入型子进程确实结束；仍有 worker/延迟写入/旧令牌禁止进入检查 | 通过 | tests/verification-run.test.ts AC12：运行中 worker→workers_active，未收尾 change_set→writes_pending，写占用→requirement_write_busy，旧 fence→stale_pm_lease | worker 会话结束以 runs 记录终态为准 |
| AC13 检查阶段拒绝新修改 worker、change_apply/spec_change 及命令改源码/测试/spec/配置；输出只能写授权目录；停止未完成不释放锁 | 通过 | tests/verification-run.test.ts AC13：change_apply→check_phase_active，debug→check_phase_active，spec publish→check_phase_active；沙箱内写 src/spec 失败、写 outputs 成功、读本机数据目录失败；有验证进程时 release→verification_active | 沙箱后端仅 darwin |
| AC14 外部编辑/输入变化被发现后不能沿用旧 PASS；观察到 A→B→A 也失效；取消/崩溃清理进程与输出 | 通过 | tests/verification-run.test.ts AC14：运行中新增文件→invalidated(input_changed)；observeInputChange→invalidated(observed_change) 即使内容还原；取消后 outputs 删除、manifest 保留；崩溃后重开服务把无进程记录标 interrupted | 漏事件且前后内容相同时无法发现，作为已知限制 |
| AC15 完成通知只含身份/结果/代理结束状态与固定建议；离线/重复/重试不重启 PM、不回退 closed | 通过 | tests/workflow-close.test.ts AC15：通知载荷固定四字段，投递失败只增 attempts，成功后不再投递；closed 状态不变 | 无 |
| AC16 检查中新增已批准需求只由有效 PM 决定 interrupt/defer；interrupt 等进程结束；defer 用原 prodCommit/hash 继续并可提交原轮结果 | 通过 | tests/verification-run.test.ts AC16 与 tests/pending-update.test.ts AC16（提交 4a407a3）：旧 fence 拒绝、错误 revision 拒绝；defer 期间正式结果绑定原基线；绑定检查轮的读取只取原批准版本；interrupt 后进程未结束不能释放，释放记 interrupted | 无 |
| AC17 检查 PASS 但 pending/未知影响在时拒绝完成与交付；多次更新有序复核；用户取消优先 | 通过 | tests/pending-update.test.ts AC17：unknown 不解除 pending、旧修订复核报 assessment_conflict；tests/workflow-close.test.ts AC11：pending_update 阻塞关闭；cancelled 关闭不受 pending 约束 | 无 |
| AC18 绑定需求的 explore 在关闭/父撤权/PM 接管时停止，旧结果不当当前；无关 main 检索不误停；搜索会话不跨需求复用 | 通过 | tests/explore-session.test.ts AC18：closing→requirement_closed，PM 接管→pm_taken_over，父运行结束→parent_revoked，结束会话→session_ended，同 runId 再登记→session_reused；无需求 main 会话不受关闭影响；关闭收尾只结束绑定该需求的会话 | 真实派出链路在 M7 |
| AC19 审查结果分阻塞/建议/未验证并关联目标与证据；仅建议不阻交付；阻塞/未验证仍拒绝 completed | 通过 | tests/pending-update.test.ts AC19：结论由程序计算，不接受 PASS 字段；tests/workflow-close.test.ts：仅建议时 deliverable 且 suggestions 计数，阻塞/未验证裁决阻塞关闭 | 无 |
| AC20 性能阈值/基线/测量方法在验证前固定，不适用须说明；检查后换指标不生效；局部修复只失效受影响证据 | 通过 | tests/verification-run.test.ts AC20：run 必须声明 performance（applicable + thresholds 或 reason），记录后无更新动作；证据适用性按实际内容重算 | 无 |
| AC21 条件满足且有授权即按原协议关闭；仅缺授权则等待；建议不转未决 | 通过 | tests/workflow-close.test.ts AC3/AC21：全部满足但回执无效→仅 close_authorization_invalid，状态不变；回执有效→closed | 无 |

新工具均以工具工厂加夹具宿主验证，尚未注册进会话；M7 接线。

已知限制（非首版门槛）：验证命令沙箱后端仅 darwin，其他平台 formal 记 not_run；输入变化检测靠指纹与观察事件，漏事件且前后内容相同时无法发现；主会话既有消息/摘要不清理；通用工具旁路按 §5.7 暂缓。

独立审查（两条威胁模型内，基线 fdbacf1..88a1b6d）：0 阻塞、3 非阻塞、1 边界外备注，均已修复并补用例（提交 0bebbc1）：关闭再核对依据纳入本需求 spec_proposals/change_sets 状态；reviewer/QA 裁决必须引用该轮正式结果；影响复核任务表不得为空；epoch 已变的遗留检查轮不再占用检查阶段。定向复审指出凭据事务与依据读取事务之间仍有窄窗口，已改为同一事务签发（提交 4e78bd0）。

全量回归：第一轮（2026-09-22，提交 88a1b6d，.bb-spec/.cache/m6/*-01.txt）：typecheck 通过；`pnpm test` 152 文件 3931 用例通过、1 跳过，4 分 29 秒；`pnpm run test:integration` 16 文件 97 用例通过，59 秒；`pnpm run test:installation` 5 文件 12 用例通过，150 秒。第二轮（提交 0bebbc1，*-02.txt）：typecheck 通过；单元 152 文件 3932 通过、1 跳过；integration 全绿；installation 中 tests/installation/git-prerequisite.test.ts「Linux 容器断网运行」一例因 Docker 构建 ETIMEDOUT 失败（同一时段独立审查代理也遇到 API ENOTFOUND，属本机网络中断），本阶段未改动该模块。第三轮（提交 4e78bd0，*-03.txt 与 installation-03-rerun.txt）：typecheck 通过；`pnpm test` 152 文件 3932 用例通过、1 跳过，4 分 34 秒；`pnpm run test:integration` 16 文件 97 用例通过，59 秒；`pnpm run test:installation` 5 文件中 4 文件通过，tests/installation/git-prerequisite.test.ts 的 Docker 用例两次均在镜像构建阶段 ETIMEDOUT（同时段实测 registry.npmjs.org 单次请求 25–30 秒，容器内 npm install 4 个包耗时 121 秒后 apk 阶段超时），该用例与本阶段改动无关且在第一轮（提交 88a1b6d）通过；失败保留的临时现场与带测试标签的 Docker 镜像已清理。

第四轮重跑（提交 7fe35e3，installation-04.txt）：同一 Docker 用例仍在 `valid` 阶段 `apk add git` 超过 180 秒构建上限（每个包约 35 秒）；同时段实测宿主到 dl-cdn.alpinelinux.org 约 10 KB/s、registry.npmjs.org 单次请求 16–26 秒、github.com 60 秒超时，Docker Desktop 经 http.docker.internal:3128 代理出网。属本机出网带宽问题，不改动该测试。遗留镜像与保留现场已再次清理。

第五轮重跑（2026-09-23，提交 55e4f57，installation-05.txt，带宽恢复后容器内 `apk add git` 实测 8 秒）：`pnpm run test:installation` 5 文件 12 用例通过，44 秒。至此 typecheck 与三条测试命令在最终代码基线 4e78bd0（此后仅有状态表提交）上均有通过记录。

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md，再读 M6-STATUS.md，核对 git status 与最近提交。M0–M6 已收口不重做。
本窗口任务：M7（计划 §12 M7，AC1–AC32）。先按计划列出验收目标、范围与非目标、验证方法、性能指标、停止条件与复用模块，经用户确认后再动。
M7 可直接复用：runtime/check-round.ts（检查轮与 assertModificationAllowedIn）、runtime/verification-run.ts、runtime/verdicts.ts、runtime/workflow-close.ts 与 workflow-manage.ts（close/check-decision/delivery-check；init/repair 待接）、runtime/explore-session.ts（派出/回收）、requirement-state.assessUpdate（plan_manage assess-update 的状态侧）。M5/M6 新工具均未注册进会话。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。三条测试命令都绿才算全量绿。
任何新增机制、加固或计划正文修改都必须先经用户拍板；第一版威胁模型只有两条。
待用户决定：周期对账改为发布时原子切换（C-3）；M5 两条非阻塞观察；workflow-state.ts/workflow-tool.ts 淘汰桩的删除。
```
