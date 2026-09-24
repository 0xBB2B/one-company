# M7 状态

阶段目标：PM 通过接手复核后统一负责规划及持续增量调度，main/PM 共用只读 explore；六类固定职责的完整默认团队、同格式可复制专业定义与 PM 自动选择；子代理对话轮限与一次重试；11 核心工具真实注册；永久移除独立 planner、旧派工/恢复入口与 prompts 资源。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 首次受限读完整基线并经主代理核对，后续 diff 增量；接管/丢基线仅 active 时重核对 | 未开始 | | C 片 |
| AC2 连续追加产生解耦规则与任务 | 部分 | D2：tests/plan-assess.test.ts（连续批准快跑、跳跃、跳跃动画，各自成为独立任务，原任务版本不变） | 规则候选拆分依赖 spec_change 大小与单责门槛（M1/M4 既有测试）；真实模型拆分质量在 M9 |
| AC3 间接影响识别，复核绑定 from/to prodHash 与 plan/task 版本 | 通过 | D2：tests/plan-assess.test.ts（新增独立功能时原任务复核保留；另章节新增全局输入屏蔽时原任务依据闭包变化，判为无关被拒；复核绑定批准版本与任务版本，旧版本复核被拒） | 无 |
| AC4 未决项只阻塞依赖任务，交付范围内未决项须解决或排除 | 部分 | D1/D2：任务登记 blockedByQuestionIds；unknown 复核只阻塞对应任务并保持待处理更新（tests/plan-assess.test.ts） | 派工时按 blockedByQuestionIds 阻塞在 E 片；交付范围内未决项的关闭拒绝沿用 M6 预检 |
| AC5 同需求单一有效 holder，旧运行迟到回执拒绝；不同需求不共用分支/worktree | 部分 | C2：tests/pm-dispatch.test.ts（活着的 PM 再派出被拒；停止后再派出 fence 更高，旧租约的 PM 工具被拒）；不同需求工作区占用登记沿用 M1 managed_workspace_claims 与 tests/workspace-manage.test.ts | 两个 PM 同时竞争派出的并发用例待补 |
| AC6 plan/task 在 data.db，仅存 ID/hash/引用；重启可恢复 | 部分 | D1：tests/plan-manage.test.ts（计划与任务结构在 data.db，任务说明只在 0600 私有文件，数据库字节不含说明正文，按指纹读取） | 重启后 PM 续接读取计划的用例待补 |
| AC7 11 核心工具真实注册、六职责与矩阵一致；无 prompts、planner 及其入口 | 部分 | A 片：tests/agent-session.test.ts（五职责真实 SDK 会话的模型请求工具集＝宿主表＋矩阵核心工具，无 bash/write/edit/git_commit）、tests/core-permissions.test.ts（已实现工具 schema 与核心表双向一致，workflow_manage 无 init）、tests/role-catalog.test.ts（内置恰为五定义）、tests/legacy-workflow-retired.test.ts（planner/旧 PM 工厂文件不存在） | plan_manage、agent_manage 未实现；project_manage 八个 action 已齐（提交 85f4c4f、70f6dfc，tests/project-maintenance.test.ts 与 core-permissions 双向一致）；主会话仅注册 4 个核心工具；agents/skills/rules 其余重构在 G 片 |
| AC8 skill 未加载或模型不遵守提示时核心权限/关闭拒读/通知仍生效 | 未开始 | | A、C 片 |
| AC9 断网/关窗/取消/续接不重复副作用；关闭需求会话不续接 | 部分 | C2：tests/pm-dispatch.test.ts（按需求停止后运行终态 stopped、租约释放）；runs.resume 只续接本进程持有的暂停会话，历史运行 not_resumable（tests/run-manager.test.ts、tests/legacy-workflow-retired.test.ts）；网络暂停沿用 tests/integration/network-and-sleep.test.ts | 主会话 workflow_manage 关闭接线待补 |
| AC10 仅主代理可 workspace-prepare/recycle；越界拒绝；外部切分支后旧绑定不能写 | 部分 | 提交 85f4c4f：tests/workspace-manage.test.ts（真实确认、拒绝不留痕、req/<UUID> 分支与固定目录、基线为主仓库 HEAD、外部切分支后 verifyRequirementWorkspace 失败）；tests/project-manage-tool.test.ts（无 UI 拒绝）；project_manage 仅主会话注册且矩阵仅 main 有该工具（tests/core-permissions.test.ts、tests/agent-session.test.ts） | "未 ready 不能派 PM"待 C 片派工门槛验证 |
| AC11 创建/回收中断幂等恢复；有未交付内容默认保留 | 通过 | 提交 85f4c4f：tests/workspace-manage.test.ts（绑定前中断续办不重复确认/建分支；身份不明目录与指向别处的同名分支阻塞不覆盖；活动需求拒绝回收；未跟踪/未合并内容保留并报告；拒绝确认不删除；回收幂等；只删本需求 worktree 与本地分支） | 无 |
| AC12 四类任务状态按 unaffected/affected/unknown 正确处理 | 通过 | D2：tests/plan-assess.test.ts（已完成+无关保持完成；运行中+未知转受阻且待处理更新不解除、门槛阻塞；已完成/失败+受影响转待更新；冻结前须更新；复核只改任务状态，不改验证记录） | 无 |
| AC13 真实链路中接手复核前拒绝正式 plan 与 worker 派工 | 部分 | D1：tests/plan-manage.test.ts（核对前 propose 被 intake_gate 拒绝，通过后可提出）；tests/pm-dispatch.test.ts（无实施授权不派 PM）；C3：tests/pm-intake-runtime.test.ts（主代理经真实提供方读取 PM 私有会话中的提交；核对前门槛 review_missing，通过后只放行批准清单授权的动作，未授权动作拒绝）；tests/pm-dispatch.test.ts（受限接手上下文、PM 工具含提交入口、上下文不含 prod 正文） | 门槛接入 plan_manage propose/update（D 片）与 worker 派工（E 片） |
| AC14 伪通过/伪身份/任一绑定变化不能用旧回执放行 | 部分 | C3：tests/pm-intake-runtime.test.ts（未受理提交不计、核对不通过拒绝、PM 改交理解后旧核对失效、非本租约运行的会话不被读取）；主代理身份核验沿用 M4 PmIntakeService（tests/pm-intake-service*.test.ts）；绑定逐项变化判定沿用 tests/pm-intake-contracts.test.ts | 新物理 PM 与普通追加的连续复核在真实入口的用例随 D 片补齐 |
| AC15 main 与 PM 经 agent_manage 实际派 explore，模型输入探针证明最小上下文 | 未开始 | | F 片 |
| AC16 三类来源实际运行，未授权网络/无外发授权不发请求 | 未开始 | | F 片 |
| AC17 research 非 PASS，父代理核验 | 未开始 | | F 片 |
| AC18 搜索会话回收；关闭/撤权/接管停止；无关 main 检索不误停 | 未开始 | | F 片 |
| AC19 内置六职责默认团队零专业定义闭环 | 未开始 | | G、H 片 |
| AC20 复制默认配置即得专业定义；无效定义拒绝 | 未开始 | | G 片 |
| AC21 两类目录发现、项目信任、显式覆盖、一键复制 | 未开始 | | G 片 |
| AC22 有界能力目录、两种默认路径、显式指定失败不静默默认 | 未开始 | | G 片 |
| AC23 模型/思考等级缺省跟随主会话，指定不可用则阻塞；skill 按需加载 | 未开始 | | G 片 |
| AC24 实际模型与加载探针和运行元数据一致 | 未开始 | | G 片 |
| AC25 配置变化不静默改在途运行，重派重核验 | 未开始 | | G 片 |
| AC26 专业结果由父代理核验，独立 review/QA，专业实例受互斥与撤权约束 | 未开始 | | E 片 |
| AC27 受限子代理缺目标或有效 maxTurns 拒绝派工 | 通过 | E：tests/plan-manage.test.ts（任务缺目标或非正整数轮次上限拒绝登记）；tests/agent-session.test.ts（非正整数上限拒绝创建会话）；tests/task-dispatch.test.ts（派工轮次上限取任务登记值，写入子代理上下文） | 无 |
| AC28 最多 N 轮，不发 N+1 | 通过 | E1：tests/agent-session.test.ts（上限 2 时模型请求恰为 2 次，第 3 次未发出，标 turn_limit_reached；第 N 轮已提交结果按完成处理）；tests/task-dispatch.test.ts（真实派工链路 turnsUsed=2/3） | 无 |
| AC29 到限自动上报直属父代理 | 部分 | E2：tests/task-dispatch.test.ts（到限后不再调用子代理模型，运行时向直属 PM 会话注入结局、已用轮数、验证引用与处置提示；PM 不在时任务保持 awaiting_parent） | main 直派 explore 的上报在 F 片 |
| AC30 最多一次父代理批准的重试，之后待用户裁决 | 部分 | E2：tests/task-dispatch.test.ts（未带原因的再派被拒；带原因与新上限重试一次；再未完成进入 awaiting_user，第三次派工、修改该任务、另起覆盖其目标的新任务均被拒；无需重试时带 retry 被拒） | 用户新决定解除待裁决的入口待补 |
| AC31 正式计划/派工缺目标/通过条件/范围/性能条件拒绝 | 部分 | D1：tests/plan-manage.test.ts（缺目标、通过条件、范围、性能条件或有效轮次上限拒绝登记；冻结前须覆盖全部获准实施章节；版本递增与过期版本拒绝） | 派工侧校验在 E 片 |
| AC32 非阻塞建议不生成任务，扩范围须用户决定 | 部分 | D1：tests/plan-manage.test.ts（任务只能引用获准实施的章节，越出授权即拒；任务只能由 PM 经 plan_manage 登记，审查结果没有生成任务的入口） | 同一未完成任务的重试限制在 E 片 |

## 当前阻塞

无。

独立审查（A、B 片，基线 c241c86..70f6dfc，两条威胁模型内）：2 条阻塞（读取工具路径以 @、~、file: 或特殊空白改写后绕过范围；MCP 请求夹带 search 绕过只读名单或触发 install/auth/connect），已修复并补回归用例，定向复审"全部解决"。

独立审查（C 片，基线 460f1db..6cf660a）：0 阻塞、2 非阻塞（PM 旧基线下受理的理解会被套上新绑定；租约过期未续时 PM 的 verification_run 仍可用），已修复：受理时由宿主把批准基线写入工具结果，读取只认与当前绑定一致的提交；PM 工具每次调用核验租约仍属本运行，接管前先停止旧运行；定向复审"全部解决"。C 片遗留：门槛尚未读取影响复核链（首次批准更新后会阻塞，D 片 assess-update 补齐）；PM 实际工具缺 knowledge_query、plan_manage（D 片）与 agent_manage（E 片）；派出时未核验思考等级是否被模型支持（G 片 AC23）。

独立审查（D、E 片，基线 77a9d93..2afbc0b）：3 条（2 阻塞：已有尝试任务的目标可经修改或新增任务揽走以绕过一次重试；新版本收回实施授权后旧冻结任务仍可派出。1 非阻塞：计划提交覆盖并发登记的尝试），经四轮定向复审逐项收紧后"全部解决"：一次重试按目标计（已有尝试的任务不能取消、修改须保留原目标、其目标不能被其他任务覆盖）；复核与派工都核对实施授权范围；计划提交按快照比对，影响复核改为套用到最新任务行；尝试结局只在任务仍为运行中时改状态；同一任务同时只允许一个运行中的尝试。

已知抖动：tests/project-baseline.test.ts「真实fs.watch：自动watch对账只暂存」在 4 worker 负载下失败一次，单独重跑通过（.bb-spec/.cache/m7/a-unit-01.txt）。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md，再读 M7-STATUS.md，核对 git status 与最近提交。M0–M6 已收口不重做。
A 片已完成（新定义格式、五个内置定义、按职责工具集、daemon/agent-session.ts 取代 role-session.ts 与 requirement-agent.ts）；runtime/delivery.ts、runtime/result.ts 与 run-store 的旧 phase 字段已无生产引用，随 G 片与 workflow-state 一并删除。
M7 切片顺序：A 工具注册与按职责生成工具集 → B workspace-prepare/recycle → C PM 启动/接手复核门槛 → D plan_manage → E agent_manage 派工与轮限 → F explore 双父与联网 → G 默认团队/专业定义/资源重构 → H 零自定义闭环与全量回归。B、C、E 完成后派独立审查。
已由用户确认：M7 以真实 SDK 会话加脚本化模型验证链路与门槛，真实模型语义质量在 M9；G 片删除 workflow-state.ts、workflow-tool.ts、pi_company_workflow、pi_company_agents 并替换其依赖；删除设置命令中按角色的 model/thinking/mcp 与旧设置页，设置页只保留复制与查看 agent 定义；删除 /pi-company:new、resume、revise、sync 四个旧命令；A 片原地改写 daemon/role-session.ts，删除 bash/write/edit 只读核验、报告路径写入、structured_output 与 resume_check 等死代码并以新语义用例替换旧测试；C-3 与 M5 两条观察本阶段不处理；prod 事件在 PM 可运行时 95% 两秒内投递需实测一次。其余决定已写入计划 §9.1、§9.2、§9.6、§10.5、§10.6、§13.2 与 M7-AC20/21。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。三条测试命令都绿才算全量绿。
```
