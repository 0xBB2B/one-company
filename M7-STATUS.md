# M7 状态

阶段目标：PM 通过接手复核后统一负责规划及持续增量调度，main/PM 共用只读 explore；六类固定职责的完整默认团队、同格式可复制专业定义与 PM 自动选择；子代理对话轮限与一次重试；11 核心工具真实注册；永久移除独立 planner、旧派工/恢复入口与 prompts 资源。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 首次受限读完整基线并经主代理核对，后续 diff 增量；接管/丢基线仅 active 时重核对 | 未开始 | | C 片 |
| AC2 连续追加产生解耦规则与任务 | 未开始 | | D 片 |
| AC3 间接影响识别，复核绑定 from/to prodHash 与 plan/task 版本 | 未开始 | | D 片 |
| AC4 未决项只阻塞依赖任务，交付范围内未决项须解决或排除 | 未开始 | | D 片 |
| AC5 同需求单一有效 holder，旧运行迟到回执拒绝；不同需求不共用分支/worktree | 未开始 | | C 片 |
| AC6 plan/task 在 data.db，仅存 ID/hash/引用；重启可恢复 | 未开始 | | D 片 |
| AC7 11 核心工具真实注册、六职责与矩阵一致；无 prompts、planner 及其入口 | 部分 | A 片：tests/agent-session.test.ts（五职责真实 SDK 会话的模型请求工具集＝宿主表＋矩阵核心工具，无 bash/write/edit/git_commit）、tests/core-permissions.test.ts（已实现工具 schema 与核心表双向一致，workflow_manage 无 init）、tests/role-catalog.test.ts（内置恰为五定义）、tests/legacy-workflow-retired.test.ts（planner/旧 PM 工厂文件不存在） | plan_manage、agent_manage 未实现；project_manage 八个 action 已齐（提交 85f4c4f、70f6dfc，tests/project-maintenance.test.ts 与 core-permissions 双向一致）；主会话仅注册 4 个核心工具；agents/skills/rules 其余重构在 G 片 |
| AC8 skill 未加载或模型不遵守提示时核心权限/关闭拒读/通知仍生效 | 未开始 | | A、C 片 |
| AC9 断网/关窗/取消/续接不重复副作用；关闭需求会话不续接 | 未开始 | | C 片 |
| AC10 仅主代理可 workspace-prepare/recycle；越界拒绝；外部切分支后旧绑定不能写 | 部分 | 提交 85f4c4f：tests/workspace-manage.test.ts（真实确认、拒绝不留痕、req/<UUID> 分支与固定目录、基线为主仓库 HEAD、外部切分支后 verifyRequirementWorkspace 失败）；tests/project-manage-tool.test.ts（无 UI 拒绝）；project_manage 仅主会话注册且矩阵仅 main 有该工具（tests/core-permissions.test.ts、tests/agent-session.test.ts） | "未 ready 不能派 PM"待 C 片派工门槛验证 |
| AC11 创建/回收中断幂等恢复；有未交付内容默认保留 | 通过 | 提交 85f4c4f：tests/workspace-manage.test.ts（绑定前中断续办不重复确认/建分支；身份不明目录与指向别处的同名分支阻塞不覆盖；活动需求拒绝回收；未跟踪/未合并内容保留并报告；拒绝确认不删除；回收幂等；只删本需求 worktree 与本地分支） | 无 |
| AC12 四类任务状态按 unaffected/affected/unknown 正确处理 | 未开始 | | D 片 |
| AC13 真实链路中接手复核前拒绝正式 plan 与 worker 派工 | 未开始 | | C 片 |
| AC14 伪通过/伪身份/任一绑定变化不能用旧回执放行 | 未开始 | | C 片 |
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
| AC27 受限子代理缺目标或有效 maxTurns 拒绝派工 | 未开始 | | E 片 |
| AC28 最多 N 轮，不发 N+1 | 未开始 | | E 片 |
| AC29 到限自动上报直属父代理 | 未开始 | | E 片 |
| AC30 最多一次父代理批准的重试，之后待用户裁决 | 未开始 | | E 片 |
| AC31 正式计划/派工缺目标/通过条件/范围/性能条件拒绝 | 未开始 | | D、E 片 |
| AC32 非阻塞建议不生成任务，扩范围须用户决定 | 未开始 | | D 片 |

## 当前阻塞

无。

独立审查（A、B 片，基线 c241c86..70f6dfc，两条威胁模型内）：2 条阻塞（读取工具路径以 @、~、file: 或特殊空白改写后绕过范围；MCP 请求夹带 search 绕过只读名单或触发 install/auth/connect），已修复并补回归用例，定向复审"全部解决"。

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
