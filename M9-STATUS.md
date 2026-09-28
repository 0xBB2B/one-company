# M9 状态

阶段目标：用实际安装产物和全新数据根，验证默认通用团队、专业定义扩展与选择、渐进需求、prod 限制、最小规则、持久索引与可选交付的真实闭环；实测性能与模型上下文成本；清理临时资料并交付证据与已知限制。

状态口径：「待核对」表示已有可复用的测试，但还没在本阶段基线上按 M9 要求（实际安装产物、真实模型或实测）重新取证；「未开始」表示还没有任何本阶段证据。M0–M8 的单元、集成测试只作可复用的测试素材，不直接算 M9 证据。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 一次安装离线解析首批语言，索引跨重启复用，丢失可重建 | 待核对 | 可复用：tests/installation/syntax-parser.test.ts（隔离 HOME 与 agent 目录、PI_OFFLINE、含 Go 样例代码）、tests/installation/project-index-sync.test.ts | 在本阶段基线上重跑；补"删除 index.db 后从允许文件重建"在安装产物中的证据 |
| AC2 至少 10 个预登记问题，出处与权限可核对 | 未开始 | 无 | 问题集待用户批准；需真实模型运行 |
| AC3 完整渐进需求场景：拆分、局部调整，错误代码不反改目标 | 未开始 | 可复用：tests/plan-assess.test.ts（脚本化模型） | 需真实模型在安装产物中跑一轮移动→快跑→跳跃→动画 |
| AC4 六职责、10 工具、拒读、目录排除、关闭竞争、旧 PM 不复用、无正文提醒矩阵；披露 §5.7 与 §10.4 限制 | 待核对 | 可复用：tests/core-permissions.test.ts、tests/agent-session.test.ts、tests/workflow-close.test.ts、tests/explore-session.test.ts、tests/prod-exclusion.test.ts | 按 §13.1 逐行对照出矩阵；把两项已知限制写进交付说明 |
| AC5 关闭后本机 prod 保留，只有完成正文可归档；他人无需原作者数据可人工查归档 | 待核对 | 可复用：tests/team-clone.test.ts、tests/git-delivery.test.ts、tests/workflow-close.test.ts | 在安装产物全流程中复验一次；M8A-AC8 起归档带验收记录，复验时核对他人能在归档里看到 QA 结果 |
| AC6 无 prompts 模板与业务 Git 集成仍可存正文版本并交付；适配器不回显关闭正文 | 待核对 | 可复用：tests/zero-custom-loop.test.ts、tests/git-delivery-extension.test.ts、tests/git-delivery.test.ts | 在安装产物全流程中复验一次；M8A-AC8 起 Git 交付按归档整体 hash 核对 |
| AC7 类型、回归、集成、安装、性能、安全测试实际执行；两种更新调度实测；列出未覆盖项 | 未开始 | 无 | 阶段末全量执行；性能按 §13.2 在当前基线重测（可复用 tests/helpers/m3-benchmark.ts、tests/helpers/m4-query-benchmark.ts） |
| AC8 临时安装、克隆、需求 Git、数据库、WASM 验证文件、日志、进程清理 | 未开始 | 无 | 阶段末执行 |
| AC9 安装产物跑通受限接手、主代理核对、PM 规划与派工、增量复核、新 PM 重核对；伪身份在真实入口被拒 | 未开始 | 可复用：tests/pm-intake-runtime.test.ts、tests/pm-dispatch.test.ts、tests/pm-event-delivery.test.ts | 需在安装产物中实跑 |
| AC10 安装产物中 main 无需求与 PM 有需求的 explore，三种来源；main 未初始化纯网页成功单独实测 | 未开始 | 可复用：tests/explore-dispatch.test.ts、tests/explore-web.test.ts | 需真实模型与真实联网；本机出网慢，联网失败时该项标未完成，不以降级路径冒充 |
| AC11 接手与 explore 的上下文、工具结果、回读、重试、耗时实测 | 未开始 | 无 | 依赖 AC2 问题集与模型选定 |
| AC12 全新数据根、零自定义，真实模型走完需求到关闭 | 待核对 | 上一次通过：第 55 轮（M8A-AC10 修复后的工作区，内容即其提交）：pnpm run test:acceptance 通过（1/1），证据 .bb-spec/.cache/m9/acceptance/zero-custom-2026-09-28T10-17-43-278Z/（report.json：outcome closed、13.3 分钟、全为默认定义；archive.md 含五大板块、实现记录与验收记录）；驱动 tests/acceptance/zero-custom-loop.test.ts | 归档记录改为插入所属板块后须在新基线上重跑；第 56 轮（913482d）中批准、建工作区、派 PM 与接手核对均正常，但两次 PM 运行和一次 explore 都因服务商断流（OpenAI Responses stream ended before a terminal response event）中止，未走到关闭（证据 .bb-spec/.cache/m9/acceptance/zero-custom-2026-09-28T10-58-05-159Z）；真实模型有波动，单轮通过不代表每轮必过（第 54 轮卡在返修审查，已由 M8A-AC10 修复） |
| AC13 复制默认 worker 为专业定义，PM 自动选中完成 UI 设计与实现，独立 review/QA | 未开始 | 可复用：tests/agent-catalog-ui.test.ts、tests/agent-selection.test.ts | 需真实模型与 UI 样例任务 |
| AC14 安装产物中两类目录发现、环境变量覆盖、项目信任、同名冲突、不越根 | 未开始 | 可复用：tests/role-catalog.test.ts | 需在安装产物中实跑 |
| AC15 两种默认路径；显式指定不可用明确失败交用户裁决 | 未开始 | 可复用：tests/agent-selection.test.ts | 需在安装产物中实跑 |
| AC16 注入缺模型、缺 skill、冲突、越权、断网、运行中改配置，均明确阻塞 | 未开始 | 可复用：tests/agent-selection.test.ts、tests/integration/network-and-sleep.test.ts | 需在安装产物中实跑 |
| AC17 真实模型请求、能力目录、skill 加载探针与运行元数据逐项对应 | 未开始 | 无 | 需真实模型 |
| AC18 默认与专业路径的目录、加载、输入输出、回读、重派、耗时实测 | 未开始 | 无 | 依赖 AC11 同一测量方法 |

## 当前阻塞

M8A（移除 spec、代码即文档、TDD 先红后绿、PM 上报、批准之后再建工作区）已于 2026-09-28 收口，M9 恢复。

待用户回复：PM 接手核对结果里 M4 遗留的 executionEnabled: false 与 scheduling: "not_implemented" 是否清理（runtime/pm-intake-contracts.ts、runtime/pm-intake-service.ts 共 14 处，6 个测试文件）；第 25 轮主代理曾据此误称"执行授权尚未启用"。

推进方式：真实模型验收按"跑一轮 → 查卡点 → 修 → 再跑"；小的格式与说明修正直接做，涉及机制、授权或规则设计的先问用户。

已知风险：本机出网慢（M6 实测约 10 KB/s），AC10 的纯网页成功路径与 Docker 安装用例可能因网络失败，失败时如实标未完成。模型服务商中途断流（"stream ended before a terminal response event"、"terminated"）在第 47、51 轮重复出现，已按用户决定改为交 SDK 有限次重试（最多 3 次，约 2/4/8 秒）：断网类错误仍立刻转网络暂停，其余瞬时错误重试后仍失败才判失败。第 47 轮有一次断流被标为"已中止"（aborted），SDK 不重试这类，再出现时需查明来源。已知偶发：tests/daemon-client.test.ts 全量并行时偶发抢锁失败；tests/integration/network-and-sleep.test.ts 的计时用例全量并行时偶发失败；两者单独重跑均通过。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M9 章节与 §13），再读 M9-STATUS.md，核对 git status 与最近提交。M0–M8 已收口不重做。
用户已定的 M9 前提：
- 真实模型全部用 5x / gpt-6-luna，thinking high；隔离 agent 目录临时复制 models.json 与 auth.json（0600），每轮结束即删，不动 ~/.pi/agent。
- 真实模型与联网验收走 pnpm run test:acceptance（pnpm test 默认不跑）；pi 开发依赖为 0.87.1。
- 验证分工：AC2、3、10、11、12、13、17、18 用真实模型；AC9、14、15、16 在安装产物中用受控模型验程序门槛。
- AC2 问题集 11 题（快跑跑到关闭并归档、跳跃动画进行中之后提问：①水平速度怎么算在哪；②Go 的 Greet 做什么谁调用；③空中能否再跳依据哪段代码与测试；④进行中的跳跃动画要求哪些姿态；⑤不指定需求列出所有进行中需求内容；⑥最新批准版比上一版改了什么；⑦已完成快跑当时的验收标准；⑧快跑与跳跃的实现有没有相互影响（依据代码与测试）；⑨快跑测试正式通过了吗；⑩这次改动让移动计算快了多少；⑪参考 docs/prod 旧需求写新需求）。⑤⑦⑪须拒给正文，模型用普通 read 读归档即判未通过并记为旁路案例；⑨⑩无记录须答"未知"。
- AC13 UI 样例：HUD 状态面板（速度、是否在空中、是否快跑），TS 函数输出 HTML 字符串加 CSS，node 单元测试验证；默认 worker 复制为 ui-worker，挂样例项目自带 skill ui-basics。
当前：M8A、M8B 已收口；用户已决定在 M9 之前另起 M8C（需求文档规范可自定义 skill），M8C 计划待用户批准。AC12 在第 55 轮通过，归档记录改为插入所属板块后须重跑；之后按计划推进其余 AC（建议先 AC2 问题集，它依赖快跑已关闭并归档的状态）。真实模型运行命令：PI_COMPANY_ACCEPTANCE_MODEL=5x/gpt-6-luna PI_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance，用后台运行加看门狗：证据目录 events.jsonl 10 分钟无更新就在该目录放 STOP 文件。每轮卡点从证据目录的 main-session.json、side-calls.json、runs/*.jsonl 查。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
