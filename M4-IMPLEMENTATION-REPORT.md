# M4 实施记录

## 当前状态

**M4 尚未通过整体验收，不进入 M5。本窗口仅更新设计和相关文档、交付新窗口继续 M4 的提示，不恢复 M4 产品实施。** 用户已确认 PM 接手复核、PM 直接维护 plan/task/spec 候选、取消独立产品 planner，以及 main/PM 均可调用只读 explore 的新方向；设计文档已完成独立复审和主代理核验，新增产品验收项未被标为通过。

M0—M3 的阶段结果及 M4 部分内核已有核验证据；历史统一 10 文件 288/288、类型检查及后续隔离提交验证均保留，不能替代当前未完成接线或新设计验收。旧工作流永久淘汰、不考虑兼容已获确认，未完成能力默认拒绝，不用旧机制兜底。本次文档修改前 HEAD 为 `b7411103e9e08a80de21694f0487ae2b2d3bafe9`，新窗口须重新核对实际 HEAD；全部未提交成果、原 `.pi/` 及现存原 PID 52973/53030 保留，不能仅凭旧 PID 判断进程身份或误杀。

本报告保留各时点的任务、失败、验证和提交事实，历史“等待新需求”“修复中”及“未提交”不作为当前指令；续接以文末 **M4-DESIGN-HANDOFF-01** 为准，报告只是进度线索，权威依据仍为磁盘上的[当前计划](SQLITE-KNOWLEDGE-REBUILD-PLAN.md)。

## 开工现场与授权

- 工作区：`/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild`；分支 `bb-spec-rebuild`。
- 开工 HEAD：`2237d05c81af9b7d02d14b8babde13e3c623c4e5`。
- 交接文字说 M3 尚未提交，但磁盘报告与 Git 已证明后来获准提交：M3 实现为 `74ae5b336e848faee45181f2b3496c793de197c9`，随后报告提交为上述 HEAD。本轮没有提交授权，不暂存、提交、推送或操作真实数据库。
- 原有未跟踪 `.pi/` 配置与文件全部保留。原有 PID 52973、53030 按 M3 交接保留，不由本轮清理。
- 主代理环境及实际会话 `model_change` 均为 `5x/gpt-6-astra`；注册模型配置已核对该精确 provider/modelId。所有派工显式指定同模型，并另核对实际运行记录，不只依据提示文字。
- 主代理已完整分段读取项目 `AGENTS.md` 与当前计划 1595 行，核对 M3 报告最终验收段和实际证据；没有读取已删除资料或历史正文。
- 主代理已完整读实际 SDK 0.85.1 的 `docs/extensions.md`、`docs/session-format.md`、`docs/sdk.md` 及输入/权限示例。全局与本仓 SDK 文档版本及 extensions 文档 hash 相同。

## 证据根与基线

本轮证据根：

`/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/`

目录权限 0700，记录/日志按 0600 保存。

- `recovery-baseline.json`：M3 最终清单 311 项逐项复算，只有 README 与原验收输入不同，且完全符合 M3 已登记的最终状态文字更新；生产与测试字节一致。
- M3 两 Node 全量日志确有各 122 文件、3255/3255；类型/独立集成/安装 `.exit` 均为 0。这是核对既有证据，不冒称本轮重跑。
- 本轮 `pnpm run typecheck`：exit 0，日志 `baseline-typecheck.*`。
- 本轮 `pnpm exec vitest run tests/requirement-service.test.ts tests/requirement-manage-tool.test.ts tests/short-decisions.test.ts tests/spec-format.test.ts tests/project-index-service.test.ts`：5 文件、105/105，exit 0，日志 `baseline-targeted.*`。
- 本轮 Node `/opt/homebrew/Cellar/node/26.8.2/bin/node`，v26.8.2；pnpm 11.7.0。最低 Node 尚未重跑。

## 任务与主代理核验

所有任务保持子代理优先。失败次数只在同一具体任务内累计；当前没有两次实际失败后由主代理接手的 M4 任务。

| 任务 ID | 子代理 ID | 范围 | 当前事实 |
|---|---|---|---|
| M4-MAP-01 | `ab10ceda-5ec2-413` | 需求工具、交互及旧授权只读定位 | 已返回；主代理已核对 host-authorization、requirement-manage-tool、short-decisions、相关 contracts 与服务源码 |
| M4-QUERY-DESIGN-01 | `39a884cf-dd69-47d` | 当前知识查询只读规划 | 已返回；主代理已核对 IndexStore、ProjectIndexService 与 coordinator 的真实基线/同代次 spec 汇总接缝，采纳复用既有协调器方案 |
| M4-SPEC-01 | `3f25365c-cddd-48a`；返修 `ea275e80-902f-407` | 只读规则/候选分析与严格语义陈述校验 | 首版主代理 44/44、独立结构/引用审查通过；原生 Node 加载失败已限定返修；主代理核对修后 diff/hash，45/45 及原生导入独立重跑通过 |
| M4-INTERACTION-CORE-01 | `a5a79185-af2d-4ef` | 可信输入、渐进归纳、短决定与动作授权内核 | 第二次实现修复 F1—F4，独立复审限定通过；主代理读全部修复 diff、核对真实复审及统一测试。真实宿主撤权通知仍是必需接线条件 |
| M4-PROD-READ-01 | `2562d79f-81cb-427` | 绑定角色的活动 prod 读取/分页/章节/来源工厂 | 第二次实现修复整包预算，独立真实反例/48项复审通过；主代理读全部修复 diff、核对复审并统一复验，未接 daemon |
| M4-QUERY-CORE-01 | `a7264281-e6ad-4ea` | 中文当前查询、事实包与索引读取接缝 | 第二次实现修复 R1—R4，74项与独立真实反例复审通过；主代理读全部修复 diff、核对复审并统一复验。联合返回门槛/产品接线未完成 |
| M4-LEGACY-AUTH-DESIGN-01 | `e93487ee-531e-431` | 旧自填 user/relay 授权入口的最小收口规划 | 已返回；主代理核对关键消费者，建议隔离旧执行入口，涉及旧流程停用，已向用户提出必要确认，尚未实施 |
| M4-SPEC-REVIEW-01 | `1d4f136a-ed5d-413` | 两个冻结 spec 文件的独立只读审查 | 已结束；17/17 及反证通过，指出原生加载问题；仅认可首版结构/引用边界，不签 M4 |
| M4-PROD-READ-REVIEW-01 | `d473d626-af83-48d` | 活动 prod 只读工厂独立安全审查 | 已结束，不通过：F1 整体序列化响应超 50KiB；主代理核对后派第二次实现 `2a2751d7-f535-4db` |
| M4-INTERACTION-REVIEW-01 | `4d878783-05a3-4cb` | 输入/决定/候选授权独立安全审查 | 已结束，不通过：F1—F4；主代理核对完整报告及源码，派第二次实现 `d82dc0be-88f5-475` |
| M4-QUERY-REVIEW-01 | `7be83ce1-823b-423` | 当前查询、只读 SQLite 与分页独立审查 | 已结束，不通过：R1—R4；主代理核对完整报告及源码，派第二次实现 `d8bdb0a0-2c48-4b4` |

### M4-SPEC-01 已核对交付

- 新增 `runtime/spec-analysis.ts`，SHA-256 `11ff71482d4f3dee3e97f4879ddbceb93669dce899800036f0779a2e0a75ec2a`。
- 新增 `tests/spec-analysis.test.ts`，SHA-256 `3e2793ba79344b3243fec5632c5194d91a62b960ff51f54f33767d60460fbb4d`。
- 复用当前结构门槛，当前与完整 pending 目标集合分离；提供完整规则、文件/规则指纹、依赖/例外声明和跨 feature 规则对；公开预算未覆盖项。
- 语义陈述只校验结构、真实引用和原文引证，固定标为未独立验证、无授权，不凭陈述发布或宣布通过。
- 子代理最终 44/44、typecheck exit 0；首轮夹具边数断言失败已按实际四条边修正，原失败日志保留。
- 主代理独立执行两文件 44/44，exit 0，hash 与交付一致；日志 `main-spec-verification.*`。这只覆盖本任务机械契约，不是 M4-AC6/7 全部自然语言验收。

### 后续任务交付与实际复验

- `prod-read/REPORT.md`：四文件只读工厂、显式稳定章节与有界游标；主代理重跑 36/36（60.64 秒），日志 `main-prod-read-verification.*`，hash 匹配。工厂不是 SDK 的多参数 ToolDefinition，接线须显式适配；PM/子角色绑定由真实宿主提供。
- `interaction-core/DELIVERY.md`：四文件可信交互内核和真实 pi-ai 适配器；主代理重跑 87/87（9.07 秒），日志 `main-interaction-verification.*`。解释器测试是预设/faux，未证明真实云模型质量；同候选未确认项与决定取代后的旧能力，正在独立反证。
- `query-core/DELIVERY.md`：当前查询两个模块、三个相关测试及 IndexStore/ProjectIndexService 的只读接缝；主代理重跑 57/57（37.70 秒），日志 `main-query-verification.*`。首次读/每页必须由真实 coordinator 提供 fresh capture/return check，尚未接线。
- 主代理阶段中间 `pnpm run typecheck` exit 0，日志 `main-interim-typecheck.*`。这不是冻结后的全量或最终验收。
- spec 原生导入返修：旧 agent 的 resume 未实际执行，未计一次失败；新 agent `ea275e80-902f-407` 仅改错误类参数属性与新增原生导入测试。句柄被宿主清理后，从其输出记录只提取最终 text、stopReason 与模型元数据，未恢复思维或工具转录；`spec-repair-recovered-result.json`。旧审查不改绑修后 hash。

### 独立审查问题与限定返修

- **M4-PROD-READ-01**：首次交付审查失败 1 次。真实响应可达 86,569 字节（256 长章节 ID）、57,527 字节（正文仅 4 字节）、66,568 字节（引号）和 197,640 字节（控制字符）；coverage/游标可能在宿主截断位置之后。第二次实现仅处理完整序列化预算、正文及章节续页与原权限保持，目标整包 ≤49,152 字节。没有删目标或章节凑预算的许可。
- **M4-INTERACTION-CORE-01**：首次交付审查失败 1 次。F1 同候选 pending 仍获完整 hash 授权；F2 另一合法 core 取代决定后旧能力仍有效；F3 原生 Node 加载失败；F4 保留 read、撤销动作许可时仍放行。独立探针 23 项中 18 通过、5 失败，原结果保留。第二次实现仅修上述一致性、逐次动作权限、决定现状核对及原生加载，不实施旧工作流映射。
- **M4-QUERY-CORE-01**：首次交付审查失败 1 次。R1 最后文件核验后又异步取需求元数据，真实源码变化仍返旧内容；R2 中文词跨 131072 码点片段边界漏报且称 complete；R3 合法公开预算可返回 65,480 字节超宿主上限；R4 只读路径接受 0644 主库。第二次实现仅修联合返回门槛、可证明连续的跨片段匹配、整包预算、私有文件/目录权限拒绝。
- **M4-SPEC-01**：首次交付的结构/引用审查通过，但原生加载检查失败 1 次；第二次实现已修复。主代理修后 45/45、原生导入 exit 0，日志 `main-spec-repair-verification.*`、`main-spec-native-import.*`。新生产 hash `c41e8de987c9961c6c064dac8921ee5116c6a8ee514f1a57493f0529f64451ee`，新测试 hash `dda29910305f5dc2a49dbd05e272ee35980ce6d4fbff00abc02638c8e0c035c1`。

第二次实现结果均已返回，主代理已完整核对实际修复 diff 与新测试，并核对以下独立复审报告，再在同一冻结输入上统一验证。原失败证据保留，没有用第一次 PASS 掩盖修复。每项实现任务均只累计首次交付审查失败 1 次，第二次实现通过本次限定复核；没有主代理接手实现或跨任务累计失败。

## 已确定的接缝与后续依赖

1. prod 的版本保存、准确批准 diff、生命周期/epoch 检查复用既有服务，不另造存储层。角色读取工厂和主代理写入/确认入口须最终接到真实宿主与 daemon，不能用注入恒真授权的单测冒充产品闭环。
2. 真实输入来源来自宿主 input 事件与窗口/会话绑定，不靠 `message.role=user`。原话只在有界交互内存中处理；无工具模型归纳结果须严格校验、绑定具体目标差异/版本/范围，短决定及授权元数据才入库。目标、分析/规划/实施等动作分开；未决、未来想法和代理建议不能自动升级。
3. 查询复用已有扫描批准附件、coordinator 队列和 M3 真实文件核验，不另开 watcher、不机械重复批准。无内容变化但重新发布的 generation 与实际基线变化分开；分页不能偷换原出处或跳过撤权检查。
4. 当前没有完整 M6 formal 证据入口；历史代理 PASS 不展示为当前通过，缺输入/阶段依据明确 unknown。所有输出预算必须保留阻塞及覆盖不足提示。
5. 旧 `decision_record`、relay 转述和旧 workflow 消费者的授权收口尚未实现。仅禁新写 user 不足：已有 confirmed/shape/skipped、USER effects 和旧运行恢复仍可产生执行能力。主代理已核对 `workflow-state.ts:156/286/431/489`、`workflow-tool.ts` 的公开消费者及 `requirement-agent.ts` 的 relay 自动决定路径；只读规划还追踪了 run-manager 的派工、排队、恢复与返修门槛。用户已明确永久移除旧执行机制，不考虑兼容。当前M4范围直接收口对应入口，保留查询、安全停止和已有数据，不为保持旧流程运行提前做M5—M7映射。实际移除和安全验证完成前不能宣称授权面已收口。
6. 各内核验收后再派产品接线、真实安装/角色/模型夹具及性能验证。安全改动和最终阶段检查交独立审查，主代理再核对整合。最终检查前所有写入子代理和子进程必须真实结束。

## 本轮最终核验与整合结论

### 独立复审与适用范围

- prod 读取：`prod-read/repair-review-01/REPORT.md`，agent `bd97e685-4e89-496`；48/48、真实 SQLite/Git/worktree 分页探针通过，F1 解除。4字节长正文全量续页另用纯视图验证，未冒充全程真实 Git 调用。
- 交互授权：`interaction-core/repair-review-01/REPORT.md`，agent `63206e81-9b35-4ee`；原23项、新25项安全检查、86项任务测试与原生导入通过，F1—F4 在约定的内核边界解除。另1项观察性诊断不是安全通过：宿主若只改自己的权限表而不通知 `core.revoke()`，仍可能返回先前许可。真实接线必须证明撤权通知及时到达，不能用本报告跳过它。
- 当前查询：`query-core/repair-review-01/REPORT.md`，agent `9a8f504d-0ba1-427`；74/74、真实 FIFO/文件/SQLite 竞争、片段边界、整包预算和权限探针通过，R1—R4 解除。实际 daemon 必须实现联合 `finalCheck`，不能用两个独立 await 或 noop 代替。该审查如实记录了一次超出子任务字面限制的只读 `git status`，没有工作项目 Git 写入，不影响受审文件指纹。
- spec：原结构/引用独立审查通过，原生加载的显式字段修复已由主代理核对并独立重跑；自然语言语义与后续消费者仍未验收，不将原审查绑定到未经说明的新字节。

### 主代理统一输入与命令

17个生产/测试改动文件由 `kernel-freeze-before.json` 和 `kernel-freeze-after.json` 绑定，统一验证前后及收尾复核均无变化。

```sh
pnpm exec vitest run \
  tests/spec-format.test.ts tests/spec-analysis.test.ts \
  tests/requirement-read-tool.test.ts tests/prod-view.test.ts tests/requirement-service.test.ts \
  tests/user-interaction.test.ts tests/short-decisions.test.ts \
  tests/knowledge-query.test.ts tests/index-store.test.ts tests/project-index-service.test.ts
pnpm run typecheck
```

- 10文件 **288/288**，exit 0，124.93秒；`main-kernel-combined.log/.exit`。
- 类型检查 exit 0；`main-kernel-typecheck.log/.exit`。
- `git diff --check` 通过；严格 unused 检查仅有原有 `runtime/shell-bash.ts:event`、`runtime/shell-page.ts:width` 两项，真实失败退出码保留在 `main-unused.*`，没有本轮新增孤立声明。
- 主代理已完整读本轮新增代码/测试及四份既有文件 diff，返修逐项再次核对；没有无关重构、schema/依赖变更或覆盖用户改动。
- 整合范围只是已核对的四项内部能力及索引只读接缝，**不是实际注册的完整 prod/user_interact/knowledge_query 业务工具**。不接受下游据此宣布 M4 已完成。

### 进程、临时文件与 Git

- `pre-handoff-check.json` 核对18名实际子代理均为 `5x/gpt-6-astra`，最后实际 assistant 记录均为 stop 且没有待执行工具调用；工具返回/已清理句柄及运行进程核对一致。本轮所有写入和审查均已结束。
- 进程检查只剩原交接要求保留的 PID 52973/53030；未停止或回收它们。
- 本轮证据根内没有遗留 DB、Git 夹具、node_modules、scratch 或 cache；280份既有交付证据的权限检查无异常，后加核对日志仍按0600保存。正式成功/失败日志、复现探针、差异及指纹保留用于交接；不删除原 M3 证据或来源不明目录。
- HEAD 仍为 `2237d05c81af9b7d02d14b8babde13e3c623c4e5`，暂存区为空，**本轮没有任何本地提交或推送**。所有 M4 改动留在当前工作区，原 `.pi/` 保留。

## 当前阻塞与未完成项

**旧流程兼容性取舍已解决**：用户明确要求永久淘汰旧工作流、不考虑兼容，并授权继续 M4。按当前阶段职责移除旧执行机制，未完成的新能力默认拒绝，不用旧机制兜底、不建立转换或重放旧授权的兼容链。数据保全、真实数据库/进程/worktree及 Git 写入仍受原授权边界约束。

其余未完成：真实宿主/daemon/角色接线、旧 receipt 桥接和旧授权入口收口、真实模型分项归纳/规则判断、M4-AC1—AC11 整体验收、全量/独立集成/真实安装/最低 Node/查询性能、阶段最终独立审查。未对这些项目降级或冒报通过；没有进入 M5。

## 阶段总览与续接

| 阶段 | 职责 | 状态 |
|---|---|---|
| M0 | Node/pnpm基线、安装资源和安全边界 | 已完成（既有证据，非本轮重跑） |
| M1 | 协议、SQLite生命周期和本机prod存储 | 已完成（既有证据及本轮相关回归） |
| M2 | 当前代码/spec持久索引和prod排除 | 已完成（既有证据及本轮相关回归） |
| M3 | 文件同步、需求事件和撤权通知 | 已完成（311项输入及最终证据已核对） |
| M4 | 完整prod、渐进确认、当前查询及接手需求侧契约 | **未完成；本窗口仅文档更新，新窗口按新计划续接** |
| M5 | 代码/spec专用变更、六角色权限基础 | 未开始 |
| M6 | 正式验证、关闭、归档和完成提醒，覆盖需求绑定的explore | 未开始 |
| M7 | 单PM真实接手门槛、直接规划、planner移除及explore双入口 | 未开始 |
| M8 | 团队历史边界和Git外置 | 未开始 |
| M9 | 真实闭环、性能、安装和总验收 | 未开始 |

当前计划为 M0—M9 共 10 阶段；M0—M3 的已完成状态依据既有核验，不是本窗口重跑，也不覆盖新增设计要求。新方向已明确，本窗口不再等待全量需求审批，但仍只做文档交付，不恢复产品实施。新窗口先核对磁盘计划、实际源码和全部未提交范围，再继续 M4；不提前实施 M7，不自动进入 M5。保留原 `.pi/`、用户资料及旧进程现场，全部子代理交付必须经过主代理实际核验整合才能计完成。

### 可复制的新窗口提示词

原暂停提示已由文末 **M4-DESIGN-HANDOFF-01 → 最新可复制续接提示** 替代，请只复制最新段落。下面历史记录保留原任务、失败及提交时点，不将其中的暂停前状态或模型表述当作新的执行要求。

## M4-COMPLETION-02：永久淘汰旧流程后的续接

- 已重读当前AGENTS、M4验收及§5.3/8.1—8.5/9相关原文；同一会话首次已完整读当前计划，本次核对计划hash仍一致。
- 本次主代理环境与实际session model_change均为`5x/gpt-6-astra`，注册配置仍有该精确模型；17项内核hash全部匹配上轮冻结输入，没有重做已有成果。
- 证据位于原证据根下`completion-02/`，恢复记录`recovery.json`。M3证据及M4原成功/失败记录均保留。
- 新派任务（均首次实际尝试、显式同模型，返回后须主代理核验）：
  - `M4-LEGACY-RETIRE-01` / `5e31a7ad-5585-426`：旧自由决定、workflow变更、relay授权及实际daemon旧派工/恢复入口永久移除，保留查询/停止/真实状态。
  - `M4-QUERY-WIRING-01` / `c1390337-aa4d-495`：复用现有持续索引grant/coordinator，接通RPC及主会话knowledge_query；角色接线另作后续整合。
  - `M4-HOST-DESIGN-02` / `94639260-8240-4d9`：只读规划真实prod/user_interact接线，明确提交前候选、部分目标/动作范围及M4/M7 workspace前置边界。
- 三任务文件所有权不冲突；当前不派最终验收，不操作真实数据库或保留的两个旧进程。

### 用户暂停请求

用户要求“这波子代理运行完成之后先暂停，需求有变化”。主代理已停止新派工，8个在途子代理均返回实际completed；进程检查未见本次Vitest、SDK测试、daemon或代理写入残留，只保留原PID52973/53030。新返回结果只作交付登记与现场保全，未启动新一轮代码审查、返修或统一验收，不能计为主代理已验收成果。尚未收到变更后的具体需求，不推定新目标或授权。请求及在途ID在`completion-02/pause-request.json`，103项工作区文件指纹在`completion-02/pause-workspace-checkpoint.json`。

### 续接派工与实际审查进度

以下结果仍须按对应文件与基线整合；任务级测试不代替M4最终验收。

| 任务 | 当前实际结果 |
|---|---|
| M4-LEGACY-RETIRE-01 | 首次12文件交付、187/187；独立审查`8d44e87c-6fce-464`确认F1—F6：停止假确认、close吞失败、查询跨repo/建空库/坏值回传/无预算。首次审查失败1次，第二次实现`db229c9b-3bde-4ee`修复中，不恢复旧执行器。 |
| M4-QUERY-WIRING-01 | 首次11文件交付，190项任务回归及真实SDK/daemon2项通过；独立审查`c78596ac-0189-4ad`确认最外层撤权微任务缝隙、Anthropic实际序列化丢参数、32名额异步超售。首次审查失败1次，第二次实现`a236d815-ad9a-459`修复中。 |
| M4-APPROVAL-SCOPE-01 | `d7c3229e-482e-4fc`交付8文件/189项；主代理读实际manifest/format/core新逻辑。独立审查`84c55f51-f9aa-45c`复现只问A却可接受B的单位范围越权，首次失败1次；第二次实现`2abe9e2c-20ea-403`修复中。跨范围后续决策变化的局部影响复核仍属M7，不以当前保守全量失效冒充已完成持续独立调度。 |
| M4-APPROVAL-PERSIST-01 | `0bed8caf-0cc4-4a7`交付9文件，真实saved loader/manifest store/批准事件/读取摘要。末次任务默认测试4项超时，30秒诊断17/17不算默认通过；主代理随后按默认配置独立重跑17/17、32.21秒，日志`completion-02/main-persist-default.*`。独立审查`209d087c-e7cd-474`进行中，尚未计完成。 |
| M4-LEGACY-TESTS-STATE-01 | `bfe645f3-9df0-4de`交付5测试文件，原243→315项，连同其他回归370/370。当前映射仍保留旧read/inspect及bind/check证据构建，需随生产第二次返修进一步淘汰，不恢复这些无生产用途的旧辅助来保绿。 |
| M4-LEGACY-TESTS-RUNTIME-01 | `9899caa4-9c1b-442`交付5测试文件，238→124项，原217项失败逐项映射，连同底层回归405/405；另5项RoleSession安全选择性回归，未执行的65项未计通过。生产停止/查询返修后还需重新核验。 |
| M4-LEGACY-TESTS-BOUNDARY-01 | `f37ee8dd-ae63-42a`交付11测试文件，72→73项、73/73；原19项失败有映射，保留M3通用基线/停止不变量。指出close吞失败，与正式F2一致；未把并发现场当冻结验收。 |
| M4-LEGACY-UI-01 | `0b7aed37-3ad7-47e`交付10文件，去除恢复/查看/USER人工停止UI；142/142及底层140/140。主代理尚需核对实际diff，并随停止确认/查询覆盖字段整合后复审。 |
| M4-HOST-WIRING-01 | `3dd7359d-23ef-42b`首次实现进行中：共享真实输入控制器、requirement_manage/user_interact、生产模型解释/范围授权/保存与SDK接线，不保留旧确认回退。 |
| M4-ROLE-READER-01 | `64457921-0291-4d3`首次实现进行中：新只读目标SDK角色适配，禁止沿旧session-records把prod消息写SQLite；不是M7派工器，未完成能力默认拒绝。 |

- 新派工实际模型均已由主代理从运行记录核验为`5x/gpt-6-astra`，见`completion-02/{initial,second,third}-agent-models.json`。
- 主代理已准备官方Node22.19.0独立工具链并核验官方SHA256（`completion-02/toolchain/checksum-verification.json`）、实际Node/SQLite入口；尚未把它计为最低Node测试通过。测试结束后回收本次二进制与压缩包，保留校验/环境证据。
- 旧入口首次带来的389项已执行失败是迁移线索，不得用删除有效安全断言或恢复兼容消除。三组测试迁移覆盖映射保存在各自`completion-02/tests-*`报告/JSON中；生产返修后的完整验证与独立覆盖审查尚未执行。

## 暂停时最终交付登记（未作新一轮主代理验收）

用户暂停请求后没有再派代理。下列8个当时在途任务均已取得工具返回的completed；仅登记其实际交付与未解决项，未把自报通过当成整合验收。

| 任务 / 代理 | 本波交付与仍待处理 |
|---|---|
| M4-HOST-WIRING-01 / `3dd7359d-23ef-42b` | 10文件宿主控制器/两个工具接线；最新typecheck通过，目标14通过1失败。安装首次create被拒原因未定位；Persist R1最终scope guard、同输入修改后重解释、既有目标/部分问题续接仍不完整。报告`completion-02/host-wiring/DELIVERY.md`。 |
| M4-ROLE-READER-01 / `64457921-0291-4d3` | 新一次性内存只读SDK会话及两测试，51项/typecheck/原生导入通过。外层已调用registeredApprovalManifestIn，但新guard和决定取代专门反例仍待整合；没有独立审查或云模型质量证明。报告`completion-02/role-reader/DELIVERY.md`。 |
| M4-LEGACY-RETIRE-REVIEW-02 / `5b19c7b9-51a8-42e` | **不通过**。185项/typecheck通过仍不能覆盖真实后代活着时stop/pause/close误确认、agents序列化23,982字节超16,384上限、双repo分页漏记录、只读封装接受异步回调。原F3/F4/F5限定反例解除，活动WAL及私有附文件验证通过。报告`completion-02/legacy-retire/repair-review-01/REPORT.md`。 |
| M4-LEGACY-UI-01后续 / `d4250539-ebba-474` | UI及安全回归285/285、typecheck/diff通过；coverage时效、多repo/窄尺寸边界和独立复审尚未完成。报告`completion-02/legacy-ui/repair-01/REPORT.md`。 |
| M4-LEGACY-TESTS-STATE-01后续 / `7918f510-4e42-4b5` | 7测试文件适配；原243项和前次328项映射保留，最终10文件413/413、typecheck/diff通过。主代理尚未逐项整合。报告`completion-02/tests-state/followup-01/REPORT.md`。 |
| M4-LEGACY-TESTS-RUNTIME-01后续 / `490109dc-26c7-477` | 仅dispatch-tools/run-manager测试修改，新增9项；RunManager最后38/38、底层327/327。十二文件458/460，其中R23预期已修并单文件复验；**D10 agents list取消后丢停止等待回执仍未修**，合跑期间另有外部文件变化，不是最新统一通过。报告`completion-02/tests-runtime/followup-01/REPORT.md`。 |
| M4-APPROVAL-PERSIST-01第二次 / `611166e1-13eb-4ea` | R1/R2限定修复，新增12项，默认234/234、typecheck/原生导入通过；新同步`tool.assertCurrent(result)`只接受原返回对象，供外层最终复核。Host/Role接线、主代理及独立复审未完成。报告`completion-02/approval-persist/repair-01/DELIVERY.md`。 |
| M4-APPROVAL-SCOPE-REVIEW-02 / `48187e68-181d-4ec` | 原Scope F1在限定复审中可解除：217项、原拒绝探针、14项来源/撤权与原生导入通过。主代理尚未整合这次返回；不代签Store R2、M7影响复核或M4。报告`completion-02/approval-scope/repair-review-01/REPORT.md`。 |

暂停前另已收到QWR第二次实现`a236d815-ad9a-459`：新公开参数`{repoId,query}`、最外层同步guard与32在途名额；真实SDK/daemon撤销12/12、40并行仅32进入、实际serializer保留参数。最新合跑209通过1个invalid-spec集成失败，随后集成单独3/3；M3复跑112通过1项未执行，typecheck当时为并行Host文件错误。尚未独立复审或主代理整合，不能签通过；证据`completion-02/query-wiring/repair-01/DELIVERY.md`。

### 失败尝试保留与后续接手边界

- `M4-LEGACY-RETIRE-01`已有两次真实实现：`5e31a7ad-5585-426`首次被独立审查确认F1—F6；`db229c9b-3bde-4ee`第二次被独立复审再次确认停止/分页/只读回调问题。两次实际结果、原因、已有成果和剩余范围分别在上述实施/复审报告与补丁中。**不得再派第三次实现绕过接手规则；用户恢复且确认该目标仍适用时，由主代理核对两次证据后仅接手此任务的剩余问题，仍须独立审查。当前按暂停要求不实施接手。**
- 其他任务的计数不受此影响；Scope/Persist/Query各自的第一次审查失败及第二次交付事实分别保留，后者尚未主代理验收的不冒称已通过或机械计作另一任务失败。Host首次交付不完整及安装失败已登记；未擅自新派返修。
- 新需求尚未明确，先核对变更范围再决定哪些未完成任务继续，不自动沿旧目标推进，也不进入M5。

### 暂停收尾

- 进程核对无本波代理测试/写入残留；原PID52973/53030保留。没有新开测试、修复、审查或验收轮次。
- 所有M4工作区修改保留，HEAD仍`2237d05`，暂存区为空，没有提交或推送；`.pi/`原内容及M3证据不动。`git diff --check`通过，但不等同代码/功能验收。
- 工作区103项文件指纹保存在`completion-02/pause-workspace-checkpoint.json`；最后报告更新后的指纹另行记录。各agent的报告/日志/失败反例保留，用户已有资料不清理。
- 只回收本次创建的Node22二进制与下载压缩包：确认所有验证已结束且无打开句柄后删除，保留官方SHA256与环境证据（`completion-02/toolchain/cleanup-at-pause.json`）。未运行最低Node验收，不能把准备工具链说成通过。
- 当前暂停完成，等待用户给出新的具体需求。旧工作流永久淘汰、不做兼容仍是已确认方向，除非用户明确变更，不重复询问。

## 已核验内容的本地提交

用户随后授权先提交已完成内容；此授权仅用于本地提交与必要的提交前核对，不恢复M4实施，不推送。此前各节“未提交”是暂停时点的记录，当前Git保存状态以本节及实际提交为准。

### 提交前隔离验证

- 基线HEAD：`2237d05c81af9b7d02d14b8babde13e3c623c4e5`。主代理导出当前HEAD文件并只覆盖17个已完成的spec分析、查询内核、范围确认内核文件；未带入其余未完成的Host/daemon/Persist/旧流程退场等修改。
- 隔离目录：`/private/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-commit-verified-qcg2e42h/`，`candidate.json`记录准确文件/hash。复用当前未变化的锁定依赖，package.json、pnpm-lock.yaml、pnpm-workspace.yaml均与原HEAD一致。
- 首次pnpm命令因临时workspace结构不同触发自动安装检查并中止，未运行测试；日志保留。随后仅对此验证命令使用`--config.verify-deps-before-run=warn`，不重装/修改原依赖或项目配置。警告明确是临时workspace结构变化。
- 在隔离树执行`pnpm --config.verify-deps-before-run=warn run typecheck`：exit0；执行spec-format/spec-analysis、knowledge-query/index-store/project-index-service、approval-manifest/user-interaction/short-decisions/prod-view/requirement-identity共10文件：**336/336，exit0，73.09秒**。命令结果见`typecheck-02.*`、`tests-02.*`。这证明所选内核可独立编译/测试，不是完整M4、安装或真实模型验收。

### M4-SPEC-01：只读规则分析

- 完成内容：有界完整规则事实包、当前与pending分离、严格语义陈述引用校验及原生Node加载。
- 相关文件：`runtime/spec-analysis.ts`、`tests/spec-analysis.test.ts`。
- 主代理核对：当前hash匹配已验证版本，已读实现及修复diff，原独立结构/引用审查、45项回归和本次隔离验证相互对应。
- 未覆盖：真实语义消费者、语言真值及发布/完整M4；不以结构有效自动批准。
- 本功能代码、测试和本实施记录一起提交；实际提交号在成功后记录，不预填。
- 首次暂存差异检查发现本报告末尾多余空行，commit尚未执行；已清理并重新核对。
- 实际本地提交：`55d6e3510e38ebc0d014577292d8dc8d333a2991`，代码、测试和本记录一并保存。

### M4-QUERY-CORE-01：当前知识查询内核

- 完成内容：中文/精确/事实查询、有出处与未知项的有界分页、只读当前索引、跨分片完整视图、私有存储权限及联合返回检查契约。
- 相关文件：`runtime/knowledge-query.ts`、`runtime/knowledge-query-contracts.ts`、`runtime/index-store.ts`、`runtime/project-index-service.ts`、`tests/knowledge-query.test.ts`、`tests/index-store.test.ts`、`tests/project-index-service.test.ts`。
- 主代理核对：七文件当前hash与独立复审通过的修复版本一致；实际源码/diff和R1—R4复现/修复依据已读，本次隔离树336项及类型检查通过，原本任务74项回归通过。
- 未覆盖：实际工具/RPC/六角色接线、外层provider交付及完整M4。它们的未完成代码不在本提交内；提供需求metadata的使用方仍必须实现真正joint finalCheck。
- 本功能七文件与本实施记录一起提交；实际提交号：`3cd0b67ce5d823060114e0d93b89f717e6c5debb`。

### M4-INTERACTION-CORE-01 / M4-APPROVAL-SCOPE-01：可信交互与部分确认内核

- 完成内容：真实输入票据、主体与动作分离、短记录和撤权核验；完整文档非重叠分区、范围清单、单题反向单位边界、独立当前约束来源、有限同输入重解释及Node原生加载。
- 相关文件：`runtime/approval-manifest.ts`、`runtime/prod-view.ts`、`runtime/user-interaction-format.ts`、`runtime/user-interaction-model.ts`、`runtime/user-interaction.ts`、`tests/approval-manifest.test.ts`、`tests/prod-view.test.ts`、`tests/user-interaction.test.ts`。
- 主代理核对：已完整读相关实现/返修diff，当前hash匹配Scope独立复审基线；本次补读最终复审报告，原F1及来源失效条件已核对。217项目标回归、独立来源/撤权探针与本次不带未完成接线的隔离336项/类型检查相互对应。
- 未覆盖：真实云模型语言质量、Host及Persist接线、PM启动和M7局部影响复核。文档许可不等于行为或启动许可，任一审核依据变化仍保守失效；这些边界保留，不宣称完成整阶段。
- 本功能八文件与本实施记录一起提交；实际提交号：`d12ea5a78fb2c5478f735bdccb3e64c6ae3e4c7c`。

### M4-INSTRUCTIONS-01：重建入口指令与提交交接

- 完成内容：`AGENTS.md` 明确永久淘汰旧工作流、不做兼容，同时保持数据/真实库/进程及阶段授权边界。
- 只暂存本会话新增的“重建边界”段。文件中另有非本会话新增的逐功能提交流程与授权条款，虽已按当前指令阅读遵循，但不夹带提交，原工作区字节保留。
- 验证：完整读当前AGENTS并核对精确差异，暂存版仅为原HEAD加上述段落；不修改、撤销或提交其余已有改动。文档改动不需要运行产品测试。
- 当前已成功保存三个内核功能提交：`55d6e35`（spec）、`3cd0b67`（query core）、`d12ea5a`（interaction/scope core）。本段与入口指令作为本地文档提交保存；未完成接线/退场实现及测试仍留工作区。
- M4 仍暂停、未通过整体验收；此次提交不代表恢复实施、不改变已知问题，也没有推送。
- 入口指令与记录的实际提交：`5126ce20f6ac7288704ce9860315d64791a35fcb`。其后仅更新当前续接提示，避免继续把暂停前HEAD或“全部未提交”当现状；不改变历史验证记录或功能代码。

## M4-GIT-RUNTIME-02A：固定系统Git、启用gate与只读接线

- 已整合runtime/git-runtime.mjs及声明、extensions/index.ts启用前初始化、git-read.ts去xcrun及同绑定只读执行前后复验、identity实际worktree根追加、README阶段说明及两份隔离Node测试。缺Git时在任何子扩展注册前拒绝；不修改系统开发目录、许可或安装Git。
- 进程内绑定固定不随PATH改选，原始排除根只精确去重且累计union256有界，超限拒绝不忘旧来源。重复版本检查前后携完整roots，失败不发布新状态。GitExpectation固定数据描述符解析、无accessor/toJSON、路径/记录/decimal独立限额及净数据64KiB预算；JSON不是WeakSet凭据，继承入口从唯一原entry重新验证实际Git，identityKey不是认证或业务授权。
- 主代理全文核对两轮实现与独立`git-prerequisite/review-02a-02/REVIEW.md`；R1/R2/R3原反例、256/257、65536/65537、hook零调用、失败版本后验和独立child均有独立支持。真实macOS read/diff与同一路径通过，写配置/外部helper被拒，fsmonitor/textconv未执行；禁网profile保留但不冒称网络流量端到端已测。
- 最新主代理三文件32/32及typecheck通过，8文件与独立审查hash一致，证据`task-02a/repair-01/final-main-regression.*`、`final-main-typecheck.*`及`main-review-inputs.json`。Linuxwrapper/净PATHchild受控探针通过另列，不等于Linux命令sandbox。旧identity/SDK/storage/daemon夹具依赖未完成的失败不被删除或说成已通过。
- 本次只提交上述8文件及本节记录，不夹带TaskB/legacy/AGENTS/专业计划已有改动。生产storage root-only、实际managed runner和daemon期望/已有实例一致性仍须02B/02C完成，02A只是这些后续接口依赖，不签TaskB或M4整体。实际提交号在成功后核实。

## M4-GIT-PREREQUISITE-01：系统Git前置模块与安装检查

- 已整合共享Node内置依赖Git解析/版本检查模块与类型声明、模块测试、Linux Docker安装测试、package唯一preinstall检查、README及原syntax-parser产品hook预期；不打包或自动安装Git。正常执行安装脚本时缺Git非零退出；--ignore-scripts、pnpm禁第三方脚本、本地引用的限制如实说明，使用前gate仍由Task02接线。
- 从可信宿主PATH解析固定Git，排除包/cwd/业务根与.bin，逐段绑定所有目录/文件链接；普通目录固定路径/inode/owner/权限，不以无关ctime变化误废，文件/链接保留ctime与目标内容hash。root/当前用户及macOS经系统核对admin目录为明确宿主信任域，禁止组写二进制、Linux组写和不安全路径。版本执行绝对路径、无shell、干净环境、5秒/16KiB限制；FIFO预检/非阻塞打开及FD前后校验避免挂起。
- 排除根保留原始输入并按真实语义解析alias/..，普通未创建尾部沿真实父路径处理；既存断链、循环或无法安全解析的配置明确拒绝。Docker命令先记录未知状态/内存结果再写日志，未知build不删镜像，操作/日志/清理错误共同报告，未确认时保全context；只按自产name/ID/label确认并清理资源，不prune。
- 主代理已整合独立review-02/03/04/05的分项证据：FIFO双平台及竞争无FD泄漏；完整Git文件链/目录links与权限/排除；Docker18组故障保全；最终R8双平台各11组根解析通过。R8末次窄复审不单独代表全部Task01，原各项已通过逻辑与对应受审字节由主代理共同核对。未将旧Linux综合探针缺系统Git的失败隐藏或误算全过。
- 最新主代理3文件24/24（模块19、安装4、syntax-parser安装1）及typecheck通过，七文件与最终送审指纹一致。日志`git-prerequisite/main-repair/final-task01-regression.*`、`final-task01-typecheck.*`；所有FIFO、错误输入、挂起/清理、错误日志和修复前证据保留。Task01明确依赖原当前Node/锁定pnpm，不新增任意Git最低版本号；实际macOS系统Git兼容参数和Linux预装Git安装均已验证。
- 本次只提交上述7文件、本节记录及用户已批准的计划§3.3/13.3 Git新增要求；不夹带原专业agent计划修订、AGENTS、TaskB或legacy未完成改动。Task02的启用gate、生产xcrun移除、统一真实spawn和跨进程期望仍未实施，不签完整Git改造或M4。实际本地提交号在成功后核实。

## M4-PM-INTAKE-STORE-IMPL-01：需求侧接手存储与原对象核验

- 主代理已整合TaskA五文件：`runtime/pm-intake-store.ts`、`runtime/pm-intake-service.ts`、`tests/helpers/pm-intake-fixture.ts`及store/service两份测试。真实批准prod/manifest/决定、worktree、PM lease和Host绑定生成接手基线；缺可信Main/来源目录/提交provider默认拒绝，不新增scenario.*强制正文格式、不启动PM或M7调度。
- 三阶段私有凭据固定基础依据、操作前相关行集合及精确提交后的结果；完整行ID/version/内容与唯一性关系、当前head及实际幂等结果意图核对，只有准确自身写集/等价幂等进展可接受。新结果签新proof，旧凭据不换绑；首笔creator/reviewer保留。同步原对象交付检查使用本实例WeakMap及原call/provider句柄，最终DB后不再调用resolver/注入时钟。资料只存元数据与短问题，详细理解不入DB，通过仍不产生用户新授权或执行权限。
- `pm-intake-store-review-02/REVIEW.md`已独立核对原九反例、F1/F2精确写集/幂等、F3末端回调、D1原对象、合法retained及有界frame；余下F4-02/S1由主代理限定返修。`pm-intake-store-review-03/REVIEW.md`独立105/105、25组时序/类型探针及6组安全对照确认这两项通过；主代理完整回读两报告、源码增量及实际指纹后整合，不把单份窄复审当整个TaskA证明。
- 本轮主代理同一候选在Node26及最低Node22.19.0分别105/105，typecheck、五个新增文件no-index空白检查及提交依赖检查通过。最新五文件与review-03及`pm-intake-main-repair/lease-type-review-inputs.json`一致，证据`lease-type-regression-04.*`、`lease-type-node22.*`、`acceptance-typecheck.*`。旧失败和暂停前未验证版本日志保留，不跨版本拼通过数。
- 对应M4-AC12—14的TaskA需求侧存储/绑定/失效部分。尚未实现TaskB真实SDK Main的user_interact目的分流和最终工具交付，不能签三项AC整体或M4。来源分类/提交的生产者、M7真实接手/规划/派工仍按阶段落实；当前正向使用真实服务加受控provider夹具，不是云模型业务理解认证。
- 边界：末端租约检查覆盖业务扫描/复制并在事务回调结束前拒绝过期写入，不承诺磁盘COMMIT物理瞬间与任意OS暂停原子化；合法提交后撤权保留元数据但阻止交付。完整工具外壳49152/49153精确边界及实际SDK闭环留待TaskB/阶段验收；内部frame上限256行/512KiB已测，db.list内部枚举成本未作恒定承诺。系统Python的Xcode许可报错原证据保留，本次未修改系统许可。
- 本功能只提交上述五文件与本节记录，不夹带其他旧流程/Role改动、用户AGENTS/计划或未完成TaskB。实际本地提交号在成功后核实登记。

## M4-HOST-IMPORT-CLEANUP-01：Host导入项收尾

- 实际sol任务`59c10e59-0b4e-46c`仅移除`runtime/interaction-continuity.ts`未引用的`positive`导入。主代理以HEAD全文精确替换对照核验，只有这一行变化，不改变模块加载或运行逻辑，不触碰PM五文件。
- 子代理及主代理`pnpm run typecheck`、限定diff检查通过；严格unused检查本项消失，仍有原`shell-bash:event`和`shell-page:width`两项范围外错误，不声称全仓unused通过。交付与主验证证据：`completion-03/host-import-cleanup/`。
- 仅提交上述单文件与本节记录，不夹带其他已有改动；实际提交号在提交后核实。

## M4-UI-INTEGRATION-MIGRATION-01：面板集成迁移与夹具安全收尾

- 已将原七项面板集成迁移为真实临时运行元数据+认证daemon+实际UI路径，保留导航、状态栏、不抢键、旧正文/resume拒绝、实时状态、停止确认后TTL和晚打开快照断言；不恢复旧派工/转录。配套夹具在分配前登记资源，基于实际child、缓存hello/连接代次及当前PID/PGID核对收尾，客户端关闭失败、未知身份或进程组未确认均保全根。
- 故障探针由父持有独立私有目录的canonical路径/dev/ino/nonce；子只在该根创建资源，默认unknown，资源记录和诊断不单独授予删除。父等待/TERM→必要KILL/close/组消失针对自己的真实child；超时始终失败、独立daemon未确认时不自动删根，不从日志PID发终止信号。正常故障对照只在精确身份及退出双true核验后删除准确三根/已知文件/空目录。
- 原两次实际实现留下的C1—C4由主代理按限定接手修复。独立`ui-fixture-review-02/REPORT.md`14/14确认原四项解除；主代理提交前另遇PGID探测EPERM，保全后只读证实后来ESRCH，再复验路径/inode清本次夹具，原故障日志保留。只调整为原5秒预算内等待未知结果，持续未知/仍活到期拒绝；`ui-fixture-review-03/REPORT.md`13/13确认未弱化停止/保全，原结论继续成立。
- 当前主代理全文件12/12（原7项+5项新增门槛）、typecheck/diff通过；当前完整hash`be6f55ceed6843dc2334abe2d375dec02eef5e667ba794e52bfd3ee67ebca36a`与最新独立复审一致。证据`completion-03/ui-fixture-main-repair/probe-wait-regression.*`、`probe-wait-typecheck.*`及两复审目录。25ms轮询不是硬实时上限，不重置预算或期限后追加探测放行。
- 限制：最初EPERM原因未知；同步spawn抛错时未创建child、目录保全，但可能没有parent-result，不能声称任何失败均有结果文件。日志上限为各256Ki个JS字符而非严格字节；同UID并发替换、全局PID竞态、父被强杀及隐式重启的所有路径未穷举。本功能不签M4全量/安装/正式性能。
- 本次只提交`tests/integration/agents-panel.test.ts`及本节实施记录，不夹带PM存储、后端退场或用户AGENTS/计划。实际提交号在成功后核实。

## M4-QUERY-BENCHMARK-HARNESS-01：固定查询测量装置

- 已交付`tests/helpers/m4-query-benchmark.ts`和`tests/m4-query-benchmark.test.ts`。formal参数固定1000个不同文件（600脚本/300Go/100spec含schema）、文本≤20MiB、closed档位0/1000/10000、每种查询100样本；热态精确500ms、有限事实包2000ms参考门槛不变。smoke明确只作缩小装置自检，不签性能或阶段验收。
- 使用真实临时SQLite、认证socket、持久grant、查询和随后receipt check，归档正文读取探针含正控。必须命中预定路径/规则来源，核对当前workspace/hash和>=1安全整数generation；允许同内容基线下代次变化。按实际page JSON UTF-8字节核对请求预算，不误用含receipt外壳；失败、缺失和截断保留在全部样本分母中。
- queryMs包含客户端前置授权及query调用，checkMs为receipt check调用，combinedMs包含前置授权、query、页面核验、check及末端授权，不含样本落盘/初始化/收尾；不是纯SQL或SDK/云端耗时。逐资源关闭结果真实记录，任一未确认保全根，不把等待超时当已停止；正常/故障证据保留边界已验。
- 原两次sol实现由主代理核对后，主代理按已记录限定接手补R1/R2。独立`query-benchmark-review/REPORT.md`确认F1—F4，`query-benchmark-review-02/REPORT.md`确认R1/R2和计时说明：15/15、真实RPC负向5项正确拒绝+1正控、合法字节/外壳/代次边界6/6。主代理此前15/15及相同负向通过，当前两文件hash与独立复审一致，typecheck、未跟踪文件no-index空白检查和diff检查通过。证据位于`completion-03/query-benchmark-main-repair/`及两审查目录。
- 本功能只确认装置实现和成功/失败判据；formal尚未运行，旧smoke约3.7—4.6秒高于参考值只是小样本观察，高延迟根因未知。M4正式性能、全量/安装/真实模型验收仍未完成。不夹带生产优化、用户AGENTS/计划或其他任务。
- 本次仅提交上述两文件和本节实施记录；实际提交号在成功后核对登记。

## M4-LEGACY-UI-01：旧运行展示与可核对停止整合

- 已整合Agents/Shell的最小运行元数据展示及安全停止入口；不恢复旧正文查看、派工、转录订阅或resume。登记终态不等于需求完成或进程已停，只有当前可信停止证明才启动20秒保留计时；未知/待清理/预算外阻塞提示保留，窄宽看不清目标时拒绝操作。
- Agents在渲染时绑定目标身份、实际client及连接代次，键盘/鼠标/批量按可见目标复核；运行实例代次不可回退，观察到A→B→A后旧画面/旧回执仍无效。镜像每仓100行，额外清理摘要100项，扩展入口最多检查200项且保留原始超限事实；同身份明确cleanup0才解除对应摘要，不扩操作范围。活动字段在改map前校验，避免畸形事件留下半次更新。
- Shell在所有远端await完成后再取本地当前证明；本地/远端行、详情、在途停止、返回及TTL绑定实际身份和连接，旧回执不污染新行。未核对连接代次或后代扫描时明确未知，不假报空或已结束。上述Shell部分沿用`ui-main-review-04/REPORT.md`的已核验保护，相关文件此后指纹未变。
- 独立`ui-review-05/REPORT.md`确认G4和原28项对照通过；`ui-review-06/REPORT.md`确认H1—H3限定通过，原54/54、新48/48，Activity/Panel134/134及扩展预算4/4，另16项该专项未运行不计通过。主代理全文核对报告并核对10个UI文件与其end.json一致，当前全五测试重跑221/221，typecheck及diff检查通过，日志`completion-03/continue-04/ui-final-integrated.*`、`ui-final-typecheck.*`。
- 对应M4-AC4/8及§9.4的本UI旧绑定拒绝/截断保留边界，不签完整AC、M4、安装或后端所有进程情形。`tests/integration/agents-panel.test.ts`清理安全仍有C1—C3，作为独立未完成任务保留，不夹入本功能提交。
- 本功能只提交五个UI生产文件、对应五测试及本节实施记录；用户AGENTS/计划、后端旧流程退场、PM存储、基准装置和集成夹具均不夹带。实际提交号在成功后核实。

## M4-HOST-WIRING-01 / M4-APPROVAL-PERSIST-01：可信主交互与批准范围读取整合

- 已整合主窗口真实输入和主体核对、目标/动作范围分离、无ready时仅登记、真实ready后的manifest批准、同输入有界修订重解释及只绑定身份的`requirement-select`入口。旧自填主体/转述/历史回执不产生新授权，原决定及取代关系保留；只保存短决定与必要来源/版本元数据，不新增原话档案。
- 代码范围：主Host/Core、user_interact与requirement_manage接线、approval-manifest/store、interaction-continuity、requirement service/state及其合同/operation元数据。包括私有原对象返回proof、Host撤权代次/会话/窗口/manager/仓库绑定，完整输入集合proof和最终事务核对；自有supersedes只作准确原输入对照，不恢复旧能力。全局未决影响沿依赖与appliesTo传递，动作同时核对目标和约束。
- 主代理按原两次真实实现失败的限定接手完成H2—H4剩余修复。独立`host-main-review-04/REPORT.md`确认F1/F2反例解除；`completion-03/host-clock-review-05/REPORT.md`确认F3首次拒绝及内存旧顺序对照；`host-resave-review-06/REPORT.md`确认夹具去重读取未减少四轮真实过程、幂等/旧能力/三次上限/原TTL断言，旧候选答复首次拒绝且无新增授权副作用。后两文件hash与当前一致，其余25个原冻结文件与review-04相同；相关合同/operation改动另由主代理逐行核对为本功能所需元数据。
- 最新主代理整合命令：`pnpm exec vitest run tests/user-interaction.test.ts tests/main-requirement-interaction.test.ts tests/host-result-currentness.test.ts tests/interaction-continuity.test.ts tests/requirement-state.test.ts tests/requirement-service.test.ts tests/approval-manifest-store.test.ts tests/requirement-approval-manifest.test.ts tests/requirement-scope-return.test.ts tests/short-decisions.test.ts tests/integration/requirement-interaction.test.ts tests/integration/host-requirement-continuation.test.ts tests/user-interact-tool.test.ts tests/requirement-manage-tool.test.ts tests/requirement-role-reader.test.ts tests/integration/requirement-role-reader.test.ts --no-cache`，16文件348/348、exit0；`pnpm run typecheck`及diff检查通过。主整合日志`completion-03/continue-04/host-final-integrated.*`；先前超时、诊断和失败用例证据全部保留。
- 对应M4-AC1—4/9—11中本Host/范围/续接路径的实现及回归；固定provider是可控语义夹具，不是云模型自然语言能力认证。未在本功能中实现PM接手store/Main purpose或M7调度，不签整个M4、双Node全量/安装或正式性能。Role读取原对象guard已在本次348项中联动验证，其独立改动不夹入此提交。
- 同步纳入本功能测试必需的`runtime/requirement-read-tool.ts`及其直接测试，避免提交依赖未跟踪文件的测试。该读取内核的原对象/同事务范围保护在`/tmp/m4-wiring-recovery-review-01.OYzVE0/REPORT.md`已独立核验，当前生产hash`7bb064a1…5cd7d3`与其reviewed-hashes一致。主代理已全文读当前287行，并额外重跑read-tool与prod-view两文件28/28，日志`continue-04/host-dependencies.*`；原hash列表没有直接测试文件，不将缺记录当匹配，测试以本轮实际运行核验。命令中的requirement-operations过滤项没有匹配测试文件，不计为第三文件或额外覆盖。
- 本功能提交仅限17份生产文件、13份直接修改/新增测试与本节记录；不夹带用户AGENTS/计划、UI、旧流程退场、PM存储、benchmark或其他既有改动。实际提交号在提交成功后核实登记。

## M4-PM-INTAKE-CONTRACT-01：接手材料与连续关系纯契约

- 已完成：新增`runtime/pm-intake-contracts.ts`与`tests/pm-intake-contracts.test.ts`，约定PM理解材料、可信登记所需元数据形状及接手到当前批准版本的连续关系。输出始终`executionEnabled=false`、`scheduling=not_implemented`，不把参数中的身份或当前授权boolean当作真实授权。
- 首次sol`924414a4-4518-45a`的F1—F3由独立审查确认；第二次sol`81ea602a-a0fe-401`分离物理身份与可桥接动作scope、按准确from/to历史ID目录核验来源，并将每段链绑定review/request/submission身份。原29项语义保留为35项；不读取或恢复旧正文，不改写root/link。
- 主代理已完整读原模块和返修生产差异，核对独立复审全文与当前hash；`618a4e42-c6b1-49e`实际astra的复审35/35、99/99及typecheck通过。实际报告位置为原证据根下`pm-intake-review-02/REPORT.md`（不是completion-03子目录）。主代理再跑35/35，日志`completion-03/main-pm-intake-contract.*`。
- 对应M4-AC12—14的纯材料/版本/链路判断部分。真实Main调用、SQLite核对记录、PM提交来源与生产接线仍待后续任务；不签AC12—14整体、不实施M7调度。参考主代理已审核的只读store设计，暂不新增强制scenario.*正文格式；可信来源分类/提交provider缺失时默认拒绝，不猜场景或让PM缩小必要目录。
- 本功能只提交两文件与本节实施记录，不夹带其余未完成成果；实际提交成功后单独核验登记。

## M4-EXPLORE-CONTRACT-01：有界只读检索契约核验

- 已完成：`runtime/explore-contracts.ts`、`tests/explore-contracts.test.ts` 两文件提供双父、三来源的输入/结果纯契约；main无需求且未初始化索引的纯网页约定不伪造本地基线，网络/外发引用分开，来源和失败/截断/未知必填，research不等于PASS。没有角色派出、网络工具、专业定义或M5权限网关实现。
- 两次sol实现及astra独立审查按原任务记录保留；首次F1—F4和第二次等根路径F4-R1均有失败证据。主代理只接手最后文件后缀检查，分离basename规则与相对根目录约定，不放宽普通源码/私有位置和完整32768字节预算。
- 主代理完整核对生产源码及各次精确差异、补9项回归；41/41及原正确拒绝探针exit0。独立`631cb944-a79d-4c7`实际模型`5x/gpt-6-astra`，`completion-03/explore-review-03/REVIEW.md`确认41/41、57组限定反证及原反例均exit0，原F4-R1无剩余阻塞。主代理已读完整复审，起止hash与当前二文件核对。
- 对应M4-AC15的接口/范围约定；当前查询不查prod的实际接线依据为已整合Query提交`6871046`的真实SDK/daemon证据，不以纯契约冒称查询已执行。真实父身份/ACL、文件类型/当前hash、网页取回及M7运行仍未实现或未由本任务验证；不能识别任意自然语言夹带prod，限制保持明示。
- 证据：`completion-03/main-explore-final.*`、`main-explore-root-equality.*`、`explore-review-01/02/03/`及两轮交付；类型检查在本轮实际工作区通过，无新增依赖。只提交本两文件与本节记录，不夹带计划、PM契约、Host/UI等未完成成果。实际提交成功后另行核对登记。

## M4-INSTALL-FIXTURE-01：短私有安装路径修复

- 已完成：仅修正安装测试夹具的临时根长度，使用短私有`ri-`目录并检查owner/权限，在启动前检查实际socket UTF-8字节上限。保留原连接安全门槛、create幂等与本机Git检查、真实SDK加载和清理。此项不是Host H2—H4授权/续接实现，不更改它们的尝试次数。
- 实现：首次`29b0f52b-263a-481`新增的第二客户端被主代理检查否决；第二次`f1028276-829b-407`已精确删除，不再用额外连接自证或维持daemon。两者实际模型均为`5x/gpt-5.6-sol`。首次typecheck遇并行explore临时错误保留；第二次安装1/1、socket超限负向1/1、typecheck通过。
- 主代理核对与独立依据：安全审查`/tmp/m4-wiring-recovery-review-01.OYzVE0/REPORT.md`已实证119字节超104上限、仅短路径的原始安装副本通过。主代理完整读两次diff与报告，确认最终有效变更仅一个导入、短目录与权限检查、socket预算检查；额外client已清除。
- 隔离验证：以当前HEAD导出自有目录，仅覆盖本项8行测试修改，未带Host/其他M4测试迁移；当前AGENTS和计划只作验证指令。`pnpm --config.verify-deps-before-run=warn exec vitest run tests/installation/requirement-manage.test.ts --no-cache` 1/1、typecheck exit0，日志`completion-03/install-fixture/main-integration/isolated-*`。暂存仅该测试的本项差异与本节记录，不夹带同文件尚未整合的M4业务测试改动。
- 未覆盖：这是夹具独立修复，未直接读取宿主client内部状态；实际业务成功经生产connected guard，不冒称新连接探针或完整M4安装验收。没有全量/最低Node重跑；无用户资料、真实库、旧进程操作或推送。第二次代理误把两份报告写到项目相对目录，主代理已限定迁入指定私有证据根，原始内容保留，见`completion-03/evidence-relocation.json`。
- 对应M4安装前置及既有M1-AC12/13/15存储断言；实际本地提交成功后核对并登记，不预填提交号。

## M4-QUERY-WIRING-01：当前主查询接线核验与限定提交

- 完成范围：当前主会话 `knowledge_query` 工具、真实扫描grant/RPC/coordinator接线、原调用/连接/观察代次的同步最终守卫、实际provider参数序列化和32个共享在途名额；保留当前来源、分页、invalid/unknown及prod排除。当前生产查询 `requirement=null`，没有需求metadata适配，不冒称已实现六角色联合授权；未来若提供需求metadata仍必须有真正joint finalCheck。
- 文件：`daemon/project-index-coordinator.ts`；`runtime/{protocol,project-sync-client,project-baseline,project-baseline-hooks,knowledge-query-tool}.ts`；`extensions/{index,knowledge-query}.ts`；`tests/{daemon-protocol,project-index-coordinator,project-sync-client,project-baseline,knowledge-query-tool}.test.ts`；`tests/integration/knowledge-query.test.ts`，共14文件。
- 独立审查：`M4-WIRING-RECOVERY-REVIEW-01` 实际模型 `5x/gpt-6-astra`，报告 `/tmp/m4-wiring-recovery-review-01.OYzVE0/REPORT.md`。QWR三项原反例限定解除：实际serializer保留参数、40并行仅32接纳、真实daemon四组撤权竞争均不向后续模型发送旧正文。审查全部相关命令与起止hash已由主代理核对；不将无外部联网的serializer探针称为云端接受。
- 主代理整合：完整读取新工具、扩展、两份新增测试及其余接线差异；受审hash与当前文件核对。为避免夹带Host/Persist/Role/退场未完成依赖，在自有临时目录以当前HEAD导出基线，仅覆盖上述14文件；生效AGENTS及计划另取当前工作区版本作验证指令，不纳入功能提交。未带原`.pi/`或其他未提交成果。
- 实际验证：隔离树 `pnpm --config.verify-deps-before-run=warn run typecheck` exit0；同入口Vitest六文件261通过、1项最低Node条件未启用而跳过（`query-integration/isolated-tests-01.log`）。随后显式设置已官方核验的 `M3_BASELINE_NODE22`，独立重跑project-baseline 83/83无跳过，exit0（`baseline-node22-enabled.log`），补齐此前唯一条件用例，不改写原跳过结果。临时workspace复用锁定依赖，因此只对验证命令启用布局警告，不安装/修改依赖；首次导出脚本Python filter参数不可用，测试未执行，修正导出方法后使用同一自有目录。
- 验收对应：M4-AC5/8的当前主查询路径与§8.2/9.4当前性、来源和预算；不是全部M4或模型语义质量验收。未覆盖：全部M3间歇稳定性根因、完整阶段/最低Node全量、当前查询正式性能及后续需求角色联合绑定。旧失败与未覆盖保持原状态，未签整个阶段。
- 证据：原证据根 `completion-03/query-integration/` 内的 `candidate.json`、日志及exit；提交前复算所选14文件与隔离验证输入一致，暂存仅本功能和本节实施记录，最新计划及其他任务修改不夹带。实际提交号由成功后单独记录，不预填。

## M4-DESIGN-HANDOFF-01：代理架构设计更新与 M4 续接

### 本窗口范围与核验状态

用户已确认新设计方向。本窗口仅修改设计和相关文档、准备新窗口继续 M4 的提示，不恢复 M4 产品开发，不新建永久第二计划或需求文档。实际文档改动范围为 `SQLITE-KNOWLEDGE-REBUILD-PLAN.md`、`README.md`、`AGENTS.md`、本报告四份；DOC-ARCH-01 修改权威计划，DOC-HANDOFF-01 修改 README 和本报告的设计/提示部分，主代理维护 AGENTS 及本报告的核验记录。现有代码、测试、agents/skills/rules 及原 `.pi/` 不属于本窗口文档修改范围，已有未提交内容全部保留。

设计文档证据目录：`/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-architecture-docs-c_5urzoq/`。

- 主代理已通读四文档实际差异，核对文档代理及独立审查代理的真实运行模型均为 `5x/gpt-6-astra`，见 `agent-models.json`。
- 第一次独立审查 `DOC-REVIEW-01` 未通过，见 `review.md`：R1 为纯网页搜索无条件要求本地索引基线，R2 为无关对照尾句。DOC-ARCH-01 已限定返修；主代理核对实际文字和相关 AC：索引查询、直接本地读取、纯网页各自绑定适用来源，纯网页无需本地初始化且不能借机开放扫描；R2 尾句已移除。原不通过报告保留，不能改写为通过。
- 主代理执行 `python3 /var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-architecture-docs-c_5urzoq/verify-docs.py`：13 项文档/范围检查通过，包括十阶段、原 AC 保留与 ID 唯一、六角色/11 工具、矩阵列数、无关描述清理及纯网页契约。348 个受保护的非本次文档文件与本次基线逐项 hash 相同，见 `verification.json`；这不是产品测试。
- `git diff --check -- AGENTS.md README.md M4-IMPLEMENTATION-REPORT.md SQLITE-KNOWLEDGE-REBUILD-PLAN.md` 通过。实际角色资源、代码、测试及 `.pi/` 未由本任务修改；没有启动产品验证、联网检索、数据库操作或清理原进程。
- 返修后独立复审通过，R1/R2 均解除，见 `review-final.md`。主代理已完整读复审报告，核对所绑定四文档 hash 与实际文件一致；复审后只补记本报告的真实结果，不改架构正文，不把本报告补记后的新 hash 冒称为独立审查的原字节。
- 本次文档任务已由主代理核验整合。提交前保存本记录，按现有授权仅提交这四份文档中本任务引入的内容；AGENTS 原有逐功能提交条款不夹带，工作区字节保留。实际提交结果在成功后登记于证据目录 `commit.json`，新窗口同时用 Git 核对，不预填提交号。
- M4 产品整体验收及新增 AC 均未执行或签发通过；本次记录只证明文档修改、独立复审和上述主代理核对事实。

### 已确认方向与阶段分工

- **接手复核**：PM 读取当前已批准完整需求，回报目标、非目标、约束、允许动作、未决项及场景理解；主代理对照批准需求和可信决定核对。明确部分不重复请求用户全量审批，歧义或新增授权才补问。通过后才能正式 plan 提案/更新及获授权的实现派工；复核不产生新授权。
- **PM 直接规划**：PM 产出并维护 plan、task、依赖、覆盖映射和 spec 候选，取消独立产品 planner。目标仍为 main、PM、explore、worker、reviewer、acceptance/QA 六类角色和 11 个核心业务工具。
- **只读 explore**：main 或 PM 均可调用，只提供最小问题范围，不继承父代理完整会话；检索获准本地文件/代码/当前 spec，联网搜索和取网页须同时具备能力与数据外发授权，不默认上传私有内容。结果包含有界结论、路径/行号/hash 或 URL/短引文/时间、覆盖范围和未知项，由父代理核验整合，不是自动通过。它不改代码、计划或规则，不读 prod 正文、私有数据库或会话，不派工；无网络能力时明确未执行或仅本地。search/fetch 是受限非业务能力，不增加核心业务工具数量。

| 阶段 | 本次设计的落点（均非新增已验收成果） |
|---|---|
| M4 | 接手需求侧输入输出契约、可信主代理核对记录及批准/动作范围与版本测试；explore 此时只约定输入输出和范围，不接运行时派工 |
| M5 | 六角色及受限本地/网络能力的权限基础 |
| M6 | 关闭与撤权覆盖绑定该需求的 explore，不能误停 main 无需求检索 |
| M7 | 真实 PM 接手门槛、PM 直接规划、独立 planner 及派工/恢复/别名移除、explore 的 main/PM 双入口与资源接线 |
| M9 | 真实安装、模型、权限、关闭和完整业务闭环验收 |

具体要求及 AC 以最终核对后的磁盘计划 §9—10、M4/M5/M6/M7/M9 原文为准，不以本报告另立规范，不提前实施 M7。

### 必须保留的未完成任务与接手依据

`M4-LEGACY-RETIRE-01` 已有两次真实实现：首次 `5e31a7ad-5585-426`、第二次 `db229c9b-3bde-4ee`；独立第二次审查 `5b19c7b9-51a8-42e` **未通过**。主代理已读第二次复审，证据为原 M4 根目录下 `completion-02/legacy-retire/repair-review-01/REPORT.md`，首次实现/审查及第二次实现报告也须保留。已有旧入口移除和部分拒绝/私有存储检查成果不机械重做；剩余为 R1 真实后代进程未停却确认 stop/pause/close、R2 序列化超限、R3 跨 repo 分页缺口、C1 只读回调返回 Promise 的同步约束，以及该任务相关原三项测试的迁移核验；其他测试迁移任务仍按各自 ID 和尝试记录处理。新窗口主代理核对两次证据、已有成果及当前代码后，只接手此任务剩余工作，不派第三次实现，不扩成整个 M4 的接手许可，仍须独立审查。

其他待核对项保留原独立次数记录：Host 首次 create 安装失败、同输入修改后重解释/部分目标续接；Persist `assertCurrent` 最后返回边界；Role 接线及独立审查；Query 第二次接线、微任务撤权、实际 serializer、名额与复审；UI/停止及 D10 取消后停止等待回执；全量、集成、真实安装、最低 Node、真实模型、性能和阶段最终独立审查。交付未整合不能自动计为第二次失败，更不能当成已通过。具体结果以本报告既有登记和 `completion-02/` 各 delivery/repair-review 为线索重新核对。

### 最新可复制续接提示

```text
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild，分支 bb-spec-rebuild。本窗口目标仅 M4：按新计划继续 prod 工具、渐进确认、当前查询及接手需求侧契约，补齐真实接线和验收。上一窗口只更新设计/相关文档，没有恢复产品开发，也没有通过 M4 整体验收；新方向已明确，不再等待全量需求审批。阶段内在授权范围自主推进，M4 验收完成后总结、生成下一窗口提示并停止，禁止自动进入 M5。

先完整读取当前生效的 AGENTS.md 和磁盘 SQLITE-KNOWLEDGE-REBUILD-PLAN.md，再读 M4-IMPLEMENTATION-REPORT.md（尤其 M4-DESIGN-HANDOFF-01、completion-02、暂停交付与已核验提交）及 M3 最终证据。报告只是线索，必须核对真实源码、git rev-parse HEAD、全部暂存/未暂存/未跟踪范围、实际运行和证据后续接；不从 M0 重做，不读取、恢复或导入已删除历史规范/计划/验收资料及其 Git 删除差异、历史或缓存正文。

M4 证据根：/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/。重点查看 completion-02 各 delivery/repair-review、pause-workspace-checkpoint、kernel-freeze-before/after、统一核验及内核已提交记录。设计文档证据：/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-architecture-docs-c_5urzoq/；核对主代理最终补记，不把目录存在当审查通过。本次设计文档范围为计划、README、AGENTS、M4 报告四份，核对实际提交及剩余 diff，其他已有改动不得夹带。已核验提交线索为 55d6e35、3cd0b67、d12ea5a、入口 5126ce2；文档修改前 HEAD 为 b7411103e9e08a80de21694f0487ae2b2d3bafe9，实际最新 HEAD 与文档提交须重新核对，不沿用旧值或虚构提交。部分内核的历史通过不代表当前接线或新 AC 通过。

新方向：PM 读当前已批准完整需求，回报目标/非目标/约束/允许动作/未决/场景理解，主代理对照批准需求及可信决定核对；不重复用户全量审批，通过后才正式 plan/实现派工，复核不增加授权。PM 直接维护 plan/task/spec 候选，取消独立产品 planner。目标仍六类 main/PM/explore/worker/reviewer/QA、11 核心业务工具。explore 供 main/PM 只读调用，不继承父完整会话，最小范围查本地文件/代码/spec，联网搜索/取网页须能力及数据外发授权、不默认上传私有内容；结果有界并附路径行号/hash 或 URL 短引文/时间、覆盖及未知，父代理核验整合。它不改代码/计划/规则，不读 prod 正文/私有 DB 或会话，不派工；无能力如实说明，search/fetch 不是新增业务工具。

阶段边界：M4 只做接手需求侧契约、可信主代理核对记录及版本测试，explore 仅输入输出和范围约定；M5 权限基础，M6 关闭覆盖绑定需求的 explore，M7 才做真实 PM 接手门槛/直接规划/planner 移除/explore 双入口，M9 闭环。本窗口不提前做 M7，不把新 AC 标成已通过。

M4-LEGACY-RETIRE-01 两次真实实现为 5e31a7ad-5585-426、db229c9b-3bde-4ee；第二次独立审查 5b19c7b9-51a8-42e 未通过，见 completion-02/legacy-retire/repair-review-01/REPORT.md 及首次实现/审查、第二次实现报告。主代理先核对并记录两次尝试、实际结果、失败原因、已有成果和剩余范围，再只接手 R1 后代进程未停却 stop/pause/close 确认、R2 序列化超限、R3 跨 repo 分页缺口、C1 只读回调 Promise 同步约束及该任务相关原三项测试迁移；其他测试迁移任务仍按各自 ID/尝试处理。不派第三次实现，不机械重做已有成果，不扩到其他任务，仍须独立审查。

其余剩余项按报告分别核对：Host 首次 create 安装失败/同输入修改重解释/部分目标续接；Persist assertCurrent 最后返回边界；Role 接线独立审查；Query 第二次接线/微任务撤权/serializer/名额及复审；UI/停止和 D10 取消回执；全量/集成/真实安装/最低 Node/真实模型/性能/阶段最终审查。必须保留真实 core.revoke 通知、查询联合 finalCheck、实际宿主序列化预算门槛。其他任务按自己的次数和证据，不把尚未整合自动算第二次失败或验收通过。

实现、测试、独立审查优先交宿主子代理，真实配置显式指定 gpt-6-astra 并核验实际模型；接口需要 provider 时先查真实注册配置，不猜名称、不继承默认或静默换模型，不额外要求主代理换模型。plan 可由主代理或 gpt-6-astra 子代理规划。工具/模型不可用不算执行失败，停止受影响派工并说明。同一任务两次真实失败后只由主代理接手该任务，其余继续子代理优先。所有子代理返回必须由主代理检查实际 diff、模型、验证和未覆盖项，整合并必要回归后才计完成；主代理自检不代替独立安全/阶段审查。最终验收前本轮写入代理和子进程须全部真实结束。

旧工作流永久淘汰、不兼容、不保留回退或重新启用入口；未完成新能力默认拒绝，不用旧流程兜底，不把旧决定、运行或恢复状态转成新授权。保全用户全部数据、未提交成果和原 .pi/；原 PID 52973/53030 在交接核对时仍存在，重新检查真实身份，不只按旧 PID 误杀、不回收原现场。文档维护不授权改真实数据库、回收进程/worktree、删除用户文件或读取删除历史。

按当前 AGENTS 逐功能核对实际源码、独立审查和验证，先记录结果，再由主代理在已授权范围限定本地 commit；不得暂存或提交其他改动，不用本提示扩大授权。不 push、创建 PR、发布、操作真实数据库或擅自回收现场。收尾清理仅本轮不需交付的临时产物，保留成功/失败证据。M4 完成后按 AGENTS 给出十阶段总览、本阶段完成/未完成、实际提交、下一阶段前置与可复制提示，然后停止；必要阻塞时仍交接 M4，不跳阶段。
```

#### M4-GIT-RUNTIME-02C 限定完成与提交记录

- 完成内容：daemon启动前共享纯配置解析和同loader Git初始化；现有spawn最终传承完整期望、认证hello双向核对完整根；客户端/服务端入口、成功/失败交付、身份替换、事件与terminal收尾；临时listener归属来源和限定清理；scope测试夹具的取消、真实close/PGID确认、字节预算及失败保全。没有新增启动IPC、业务身份或旧流程兼容入口。
- 文件：runtime/{daemon-client,git-daemon-binding,identity,protocol,data-root,daemon-startup-config}.ts；daemon/{bootstrap.mjs,main.ts,lifecycle.ts,server.ts}；tests/{git-daemon-binding,git-daemon-fixture,daemon-client}.test.ts；tests/helpers/git-daemon-fixture.ts。直接测试依赖tests/helpers/test-git-binding.ts为02B已独立验证的纯初始化wrapper，本次按相同SHA明确整合；不含02B worker/storage及TaskB混合fixture/交互接线。
- 验证：`pnpm exec vitest run tests/git-daemon-fixture.test.ts tests/git-daemon-binding.test.ts --no-cache` 23/23；最低Node22.19.0执行上述两文件及git-process-binding、prod-storage、prod-storage-link-race共67/67；`pnpm run typecheck`与限定`git diff --check`通过。67项后仅删未用Socket类型导入，去类型运行代码一致性已核实，保留原测试输入身份说明。
- 独立审查：review-02c-02确认R1/R2/R4/R5有效；review-02c-03确认剩余R3/R6/R7功能复验无阻塞，VM10组、真实4组。后者未取得终点hash，主代理在恢复写入前补核14/14 SHA、HEAD、real-results、exit0、真实close记录及临时目录不存在/两个自产组ESRCH，保存`review-02c-03/main-end-verification.json`，不冒称审查代理做了终点动作。固定输入不能排除未观察A→B→A。
- 对应要求：计划§3.3/§13.3系统已装Git、§7.7/§8.6进程和身份边界、§13.4真实性，以及M4-AC4/AC8相关运行前提；不据此签全部AC或整个M4。
- 未覆盖：真实安装daemon/SDK/数据库启动闭环，旧hello测试整体迁移，range/Shell最终执行边界，本轮Linux真实daemon路径及完整TaskB/M4回归。02B其余文件仍因TaskB混合依赖暂未提交；共用纯helper的本次整合不代表02B已提交。
- 证据根：`/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/`；具体见`task-02c/main-repair/`、`review-02c-02/`、`review-02c-03/`。本地提交号由提交后记录核验，不虚填。

#### M4-GIT-02E-A-REPO-FIXTURE 限定完成

- 完成：`tests/helpers/repo-fixture.ts`明确测试宿主入口初始化固定Git、使用绑定绝对路径及命令前后复验；setup环境白名单与命令级maintenance/gc/hook限制；自产根首次真目录及创建期dev/ino复核；workspace/worktree和同仓队列适用同一保护，未知/绑定失效保全。`tests/git-repo-fixture.test.ts`覆盖上述入口/配置/失败及目录竞争，顶层afterEach负责外层scope关闭。
- 当前验证：`pnpm exec vitest run tests/git-repo-fixture.test.ts tests/local-identity.test.ts tests/managed-git.test.ts --no-cache`本机65/65；最低Node22.19.0同3文件65/65；`pnpm run typecheck`与限定diff-check通过。文件未与其它任务混写，不涉及生产或global setup。
- 独立审查：review-01分类及固定绑定限定有效；review-02完成原R1修复复核，三个真实FS/Git场景、独立单文件11/11、21项分类/队列VM及2项外层清理VM通过。主代理已读报告/终点对比/资源记录，重新核两SHA/HEAD一致、真实probe scope不存在及handles=0；不把VM计成真实OS故障。
- 对应计划§3.3/§13.3 Git前置与§13.4验证真实性及M4相关夹具前提。未覆盖真实signal/timeout/worker强杀/未知进程及rm部分失败；不承诺FS检查到写入原子，不扩大未改removeRepoFixture的调用者信任边界，不签整个M4/TaskB/安装。
- 证据：`/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/repo-fixture/`下repair-01与review-01/02；本地提交完成后记录实际号，不夹入其它未提交成果。

#### M4-GIT-02D 已验证scope子成果独立保存

- 从原02D中单独整合`tests/helpers/git-daemon-fixture.ts`：固定scope的真实spawn工厂、先登记的在途操作、关闭hook和保全原因传递，支持宿主独立清理及迟到操作拒绝。它是已完成并独立审查过的共享测试基础模块，不新增实现任务、不改变02D两次失败记录，也不夹入shell-registry的混合生产差异。
- 当前SHA与02D `r2-final-inputs.json`相同，原02D review-03/04及后续02E-B相关验证适用同一helper字节；当前节点/最低Node的116项关联回归均通过，既有git-daemon-fixture VM测试已在HEAD且验证通过。必要独立证据仍在git-prerequisite/task-02d/main-repair及review-02d-03/04，后续使用者证据在task-02e/daemon-fixture/main-repair。
- 本次只提交这个共享依赖及本节记录，供已验证的02E-B夹具核心使用；不把它称为整个02D已提交，也不签业务daemon、M4或实际安装。其它混合改动继续保留。

#### M4-GIT-02E-B 共享daemon夹具核心第一层完成

- 整合`tests/helpers/daemon-harness.ts`、`temp-home.ts`、`repo-fixture.ts`及`tests/daemon-harness.test.ts`、`daemon-harness-vm.test.ts`五文件：原allocator收据、固定输入/目录与Git证明、Raw/default-token与便利认证、一次结算、完整根/身份检查、取消/fence/期限、真实close与进程组/逐根删除/未知保全、创建期外层清理、硬字节预算；不新增生产RPC或业务身份。
- 证据：主代理当前明确6测试文件Node26/最低Node22均116/116，项目tsc及两测试文件单独strict tsc通过；独立review-03核S1—S6并找到C1/C2，review-04复核两窄修及正常对照8组通过，终点八SHA/HEAD/暂存不变。主代理已完整读取报告并复算当前八hash相符；真实与VM范围按原日志区分。
- 直接依赖的共享scope子成果已另行保存为`89f828890d3573a53d42d960d19ccedc7e9a7e2a`，其代码与原02D已审版本一致，不夹入混合shell-registry。此处只提交五文件与本节记录；三个正常raw/rehello消费者增量仍保留工作区，两处无法直接应用HEAD且与legacy改动混合，本次不整文件提交，也不把它们说成已执行联调。
- 未覆盖：真实业务bootstrap/daemon/SDK模型/索引/安装、三消费者运行及整个M4。后续worktree的分配归属仍不能由可变数组提供删除权，当前明确保全，不因核心第一层完成扩大删除许可。真实未知进程/强杀/网络隔离不由VM证明。
- 证据根`/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/daemon-fixture/`，main-repair/c12-*及review-03/04。本地提交号完成后核实，不宣称M4通过。

## M4-PM-SDK-P1B-WORKTREE-RECEIPT：独立功能整合

- 完成内容：`tests/helpers/repo-fixture.ts`增加worktree原始分配收据。私有WeakMap只绑定`addWorktree`成功返回的原对象；收据来自分配时`owned`，返回冻结副本，克隆/伪造对象不能取得收据，公开字段或列表变异不能改写原身份。原Git绑定、准备队列、失败和删除逻辑保持。
- 测试文件：`tests/git-repo-fixture.test.ts`增加一个受管子进程用例，真实核对两处目录身份、冻结副本、克隆拒绝、独立收据和公开变异；原11例及imports逐字不变。所有repo/worktree位于父scope原分配临时根，子脚本不执行递归删除，父scope按原ChildProcess/真实close/组和目录身份处理收尾。
- 验证：`node node_modules/vitest/vitest.mjs run tests/git-repo-fixture.test.ts --no-cache --bail=1`在Node26.8.2下12/12、exit0；主代理以既有最低Node22.19.0绝对入口执行相同文件与参数，12/12、exit0。显式两文件`tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --allowImportingTsExtensions --skipLibCheck --types node`通过。
- 独立审查：e0a5f26a-ae63-467实际`5x/gpt-6-astra`，13组静态/纯VM/类型核对通过；主代理重核54输入hash与11个实际依赖的HEAD字节一致，两目标任务前无既有差异。实现/返修使用实际`5x/gpt-5.6-sol`。本功能可以只提交两代码文件及本小节，不夹带TaskB/B2等混合成果。
- 证据：`completion-03/git-prerequisite/task-02e/pm-unit/sdk-worktree-receipt/attempt-01/`、`attempt-02/`、`main-integration.json`、`main-node22.log/.exit`，及同级`sdk-worktree-receipt-review-01/REVIEW.md`和验证记录；根目录为`/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/`。首轮setup保护缺口及配置/证据格式错误原记录保留。
- 对应验收：支持M4-AC8及§14.4的真实证据/测试资源归属前置；不单凭收据签M4-AC12—14全项。收据本身不证明进程结束、不授权删除；PM cleanup消费者、F5完整账本、真实SDK/daemon和Linux本功能验证均未完成。全阶段M4与TaskB/B2继续按实际缺项推进。
- 本地保存：本功能通过必要验证及独立/主代理核对后，按既有授权限定提交；实际提交号由提交后核验并另记证据，不预写成功号。

## M4-PM-Q1：纯结束状态模型独立功能整合

- 完成范围：`tests/helpers/pm-sdk-quiescence-state.mjs` 与 `tests/pm-sdk-quiescence-state.test.ts`。模型无外部模块依赖、不执行进程/网络/SDK/目录删除；测试仅依赖该helper、Node内建模块与已声明Vitest。主代理核当前package/锁文件/测试配置与HEAD无差异，本功能不捆绑未提交的TaskB/B2、PMfixture、daemon或legacy实现。
- 当前行为：原owner/epoch与原资源/适用handle确定来源；五个子流入口共享保护边界，流校验先于auth/fact完整外壳及载荷。来源未成立不污染，已认证拒收永久保全，日志满额不替换首个异常。reserved/bound/close、独立group、连续序号与完整EOF分别记录；父group独立于子流；执行域终止判定单调锁存，坏消息不复活stop；已发出回收的原attempt使用有界固定终态槽保留实际结果及原错误。
- 状态边界：case/stop/正常执行、物理结束候选、回收候选、实际removed及overallPass分列。`executionPassCandidate`只表示独立业务条件；协议损坏阻断physical/reclaim/integrity/overall。`stopDomain=execution-tree`只是适用域声明；所有候选仅诊断，不能证明OS来源或授予删除权。removed永久退役，原凭据只读诊断。
- 任务尝试：原Q1两次实际实现后由主代理限定接手，依据及剩余范围保留在`q1-state/MAIN-TAKEOVER.md`；设计/审查由实际`5x/gpt-6-astra`完成。R1同根因三轮未闭合时已暂停局部补丁、核对统一入口设计后实施；没有扩大主代理对其他任务的接手范围。
- 主代理验证：Node26.8.2与最低Node22.19.0分别执行专属无setup Vitest，均60/60、exit0；显式strict/checkJs两文件exit0。13个新增展开内含双故障、来源隔离、外壳/描述符、原引用、满额首错等组合，组合数不与Vitest展开数相加。当前21个变异均成功加载后触发精确ERR_ASSERTION。
- 独立核验：review-04在未改变的helper上执行34+12安全探针，六个旧假PASS已阻断、R2—R5受影响回归通过；发现旧测试21个变异仅20个满足精确异常类型，exit1保留。随后仅两处测试断言增强，review-05核其字节范围、合法迟到正向、60原callbacks、原7变异逐项ERR_ASSERTION与随回调运行的新14变异、strict，全exit0。独立callback执行不是正式Vitest；review-05没有重复安全探针/全排列或Node22。主代理核当前hash、实际模型回执、命令退出与范围后，仅接受Q1纯模型。

### 准确验证入口与证据

证据根`P=/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/pm-unit`。

- 当前源码：helper SHA-256 `a9ec0720df77577674f47e5f1d7317a61ab0bb5b9a573649e5992d8006da96a1`；test `9fac7721790548dacbb9c7392977748d13292c46ce2c43de2e000bde900849fd`。
- 关键证据：`$P/q1-state-review-04/REVIEW.md`、`$P/q1-state-review-05/{REVIEW.md,verification.json,commands.json}`、`$P/q1-state/mutation-assertion-repair/`的两Node日志/严格类型检查/精确diff、`$P/q1-state/main-integration.json`。原失败、错误声明更正与边界偏差保留，不覆写为通过。
- `Q1_CONFIG=$P/q1-state/attempt-02/vitest.pure-state.config.mjs`。它仅include本test，environment=node、pool=forks、isolate=true、fileParallelism=false、testTimeout=5000、setupFiles=[]，root绑定本检出。该临时证据配置不作为仓库产品配置交付；跨检出复现须保存同样的临时配置并绑定实际root。默认仓库setup会分配真实临时目录，不能把默认运行等同本次纯模型环境；未声称干净检出或安装验收已测。

实际验证命令（Node22使用既有toolchain/runtime/node-v22.19.0-darwin-arm64/bin/node绝对入口执行同一Vitest命令）：

```sh
node node_modules/vitest/vitest.mjs run --config "$Q1_CONFIG" tests/pm-sdk-quiescence-state.test.ts --no-cache --bail=1
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --allowJs --checkJs --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node tests/helpers/pm-sdk-quiescence-state.mjs tests/pm-sdk-quiescence-state.test.ts
```

- 验收归属：仅M4-AC8的证据真实性与SDK测试安全装置前置；不签M4-AC12—14真实调度，也不以此宣布M4完成。普通项目typecheck不覆盖这些文件，不能替代上述显式检查。
- 未覆盖：N1真实在途reserve与关门协调、Q2无业务Node/Unix机制实验、OS事实认证、父层未结束访问者、ROOT-B实际逐根回收、SDK/PM/daemon联调、真实网络/安装、Linux及M4完整验收。恶意Proxy、被改写内建对象和任意同步重入也不在Q1保证内。
- 保存范围：本功能本地提交仅两文件及本实施小节；成功提交的实际编号和树/索引核对见`$P/q1-state/commit.json`。其他已有未提交成果保持原状，不push、不发布、不回收旧进程或用户资料。

## M4-PM-Q2-A1：纯同步原型创建守卫独立整合

- 完成文件：`tests/helpers/pm-sdk-quiescence-adapter.mjs`、`tests/pm-sdk-quiescence-adapter.vm.mjs`。helper无模块导入/真实回退；独立测试仅用Node assert/vm及读取helper源码的fs，不依赖生产、SDK、Q1或默认测试setup。仅首次实现交付，实际实现模型`5x/gpt-5.6-sol`，主代理核对后由实际`5x/gpt-6-astra`独立审查。
- 实际契约：原receiver在依赖调用前保存；原this/参数/返回与同步throw保留，reserve完整写入并复查后才调用原方法。native后的bound报告失败锁存整轮失败而不替换原返回；全局首错与nativeOutcome分开，所有falsy值按存在位保留。观察回调不向事件栈抛守卫错误；关门不撤销已进入native的调用，重入与后续创建不能绕过失败锁存。
- 固定预算：8 slots、32普通事实、32次写、单帧256字节、总8192字节。实际合法帧仅ASCII R/B；更强slot/pid门槛使正常上界为16次写、21字节单帧、200总字节，未篡改常量时部分次级超限不可达，未将源码推导冒称运行覆盖。原receiver、native结果和首错不因日志超额丢失，snapshot/owned只冻结视图壳。
- 明确边界：该守卫仅记录本地创建尝试；原receiver引用不证明native句柄仍有效，不提供kill权或结束/删除候选。spawn返回0不是整体通过，唯一PASS出口须核assertHealthy和snapshot。A2接收解码/Q1接线、preload、真实Node/FD/EventEmitter、SDK/daemon、ROOT-B、N1/唯一creator死亡及整个Q2/M4均未完成。

### 验证、审查与证据

证据根`A1=/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/pm-unit/q2-a1`。

- 当前SHA-256：helper `cd98fc23d9215e6ab4d0133290086e643bbdca7b999e2a56a672d26d71f1a347`；VM测试 `79674365cb09686ce6e5d46f6e2f19454e7b9bbefe52a8185dc50582b937b038`。
- 实现与主代理均执行原VM 21组及显式strict/checkJs，exit0；独立审查再执行同两命令，并在真实ESM导入/严格VM各执行141案例（共282次，不是282种不同场景）。六个变异均在原实现不变量通过、变异成功加载后，由真实AssertionError/ERR_ASSERTION命中；没有以加载/语法错误冒充反证。
- 主代理完整读取`review-01/independent.mjs`，核原日志/退出/hash并在最低Node22.19.0执行原21组及同一独立脚本282案例/六变异，exit0。Node26.8.2与Node22是本机纯内存执行，不是Linux或真实Node进程机制验证。
- 原21组与独立补测分开：bound写回执完整矩阵、缓冲区分离/byteLength遮蔽、更多falsy值及各阶段组合由独立脚本补测；不追溯扩大仓库原测试覆盖。Promise只作为非法回执/原值样本，不保证撤销任意异步依赖副作用。
- 必要证据：`attempt-01/DELIVERY.md`及`attempt-failures.log`，`review-01/{REVIEW.md,independent.mjs,independent.log,start.json,end.json}`，`main-check/`两Node日志，`main-integration.json`。早期帧长度误算、TS缩窄、VM严格模式装置错误原记录保留，未降低校验参数。

精确纯验证入口：

```sh
node tests/pm-sdk-quiescence-adapter.vm.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --allowJs --checkJs --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node tests/helpers/pm-sdk-quiescence-adapter.mjs tests/pm-sdk-quiescence-adapter.vm.mjs
```

主代理Node22使用既有toolchain/runtime/node-v22.19.0-darwin-arm64/bin/node绝对入口执行VM和`$A1/review-01/independent.mjs`。未运行默认Vitest、整仓测试、安装或真实资源；不对恶意Proxy/内建对象篡改、内存耗尽及任意依赖无限阻塞作保证。

- 验收归属：M4-AC8证据真实性及§7.7/§13.4/§14.4测试装置子范围；主代理仅接受A1。本地提交仅两文件和本实施小节，实际编号与树/索引核对记录在`$A1/commit.json`，其他已有未提交成果保持。

## M4-PM-Q2-A2A-BRIDGE：纯内存发送桥独立整合

- 完成文件：`tests/helpers/pm-sdk-quiescence-bridge.mjs`、`tests/pm-sdk-quiescence-bridge.vm.mjs`。静态复用已审A1，不替换其工厂、不修改A1/Q1；没有接收器、Q1调用、preload或真实模块回退。首次实现由实际`5x/gpt-5.6-sol`完成，独立安全审查为实际`5x/gpt-6-astra`，主代理已核对源码、脚本、模型回执及证据。
- 当前行为：将A1原R/B帧转换为带独立wire序号的R/B，只有完整新包回执及写后健康核对成功才返回旧A1帧长；C必须在B后，G是关门排空屏障但不等close齐备，T须全部B/C/G已报告且健康。G/T不是EOF。公开spawn直接使用A1函数，flush/finish失败不向finally抛错、不替换原native异常；失败不回滚q或重试，T后迟到A1错误仍导致失败。
- 状态边界：桥首错与A1首错按存在位分别保留，诊断只冻壳，不深冻原receiver/异常/结果。槽/包/字节/诊断有界；正常最多26包，最大24字节单包。独立实测末次T失败可达27条桥诊断；更宽的32次/256字节/8192字节等不可达上限保留源码推导，未改常量假造覆盖。
- 保证仅限纯发送契约：成功长度不证明实际OS写入，T不证明EOF/来源或资源结束。保存本地receiver不等跨进程ChildProcess；assertHealthy是当前守卫/桥健康检查，不是kill、reclaim或cleanup授权。A2B、Q1接线、OS独占流、最后健康传播、B1/SDK/ROOT-B及完整Q2/M4均未完成。

### 验证与审查证据

证据根`A2A=/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/pm-unit/q2-a2a`。

- 源码SHA-256：bridge `08b46f06698f8d64749bd59521a3cb13e19b4e6e6054e040314162b1812c3ea7`；VM测试 `45de469ba073588b5239f5c91ee2f2693b48aac62d2265f0693ad3d8083d023a`；A1静态依赖保持 `cd98fc23d9215e6ab4d0133290086e643bbdca7b999e2a56a672d26d71f1a347`。
- 原21组与显式strict/checkJs：实现者、主代理、独立审查均实际执行成功。独立审查另跑184个纯内存场景：每种包的回执/throw/缓冲变化，逐包重入/观察，多槽迟到排列、缓存快照、未报告A1槽、首错与预算边界；当前原测试只测到的组合不追溯扩大。
- 七个变异逐项确认正确ESM与正确strict VM基线通过、mutant成功加载、再由真实AssertionError/ERR_ASSERTION命中。VM绑定同一个真实A1工厂及指定共享内建引用，不宣称完整loader/跨realm/跨进程等价。
- 主代理完整读取`review-01/audit.mjs`与`mutations.mjs`，核Node26.8.2审查日志及起止hash，并以最低Node22.19.0绝对入口重跑原21组、同一184场景及七项逐项变异，均exit0。没有合并不同来源/版本的数量冒称更多独立用例，也不是Linux/真实Node机制验证。
- 失败证据：实现代理的11次历史验证tool回执由主代理补档于`main-check/agent-validation-tool-receipts.json`，5次明确exit1，其余未单列数字的回执保持null，不伪填0。独立审查的一次realm比较装置失败单独保留，未计变异命中/实现失败；最终实际重跑退出码另存。
- 关键证据：`review-01/{REVIEW.md,audit.mjs,mutations.mjs,start.json,end.json}`及对应.stdout.log/.exit.txt，`main-check/`主代理两Node日志，`main-integration.json`。必要诊断/失败记录保留，未创建需清理的被测资源。

精确纯验证入口：

```sh
node tests/pm-sdk-quiescence-bridge.vm.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --allowJs --checkJs --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node tests/helpers/pm-sdk-quiescence-bridge.mjs tests/pm-sdk-quiescence-bridge.vm.mjs
```

主代理Node22使用既有`toolchain/runtime/node-v22.19.0-darwin-arm64/bin/node`执行原VM及`$A2A/review-01/{audit.mjs,mutations.mjs}`，均只操作内存替身和读取源码，不运行默认setup/生产/安装或真实资源。任意恶意Proxy、内建对象篡改、无限阻塞等不在本项保证内。

- 验收归属：仅M4-AC8证据真实性及测试装置前置。主代理只接受A2A；本地提交限两新文件和本小节，实际提交号/树/空暂存区核对在`$A2A/commit.json`。其他未提交成果保持原状，不push或发布。

## M4-PM-Q2-A2B-RECEIVER：纯内存接收器与Q1接线限定整合

- 完成文件：`tests/helpers/pm-sdk-quiescence-receiver.mjs`、`tests/pm-sdk-quiescence-receiver.vm.mjs`。静态复用已提交真实Q1；正向测试使用真实A1/发送桥及内存队列，不改已审依赖、不引入生产/SDK/真实模块回退。来源固定1—2个、单case、显式slotKinds、原owner/readStream本地关联；关联键不是远端ChildProcess或OS身份。
- 当前行为：严格R/B/C/G/T字节流、wire和Q1事实序号分开，全G和排空请求后关闭Q1并提交浅缓存case；正常end须完整尾部，无marker替代EOF。父层detached组观察独立于子帧；全局成功R顺序关联Q1资源，T后同chunk任意尾字节立即保全。运行失败不可恢复，不重试可能部分生效的Q1调用。
- conclude为唯一纯诊断出口：先核原桥健康/有界快照，健康inFlight仅允许已登记但尚未R回写的唯一末槽过渡；已报告前缀身份仍对应。双方传输终结就先核q/字节/槽/Q1关联，case或group缺项不掩盖明确矛盾；无矛盾的业务/物理缺项为incomplete。业务结果和物理候选分开，不提供stop/reclaim/cleanupAllowed或Q1凭据。
- 信任前提：正常夹具现场创建真实原bridge并直接传原对象/方法，这是受控接线前提，不是receiver具备品牌鉴别。schema与有限双轮读取不认证任意恶意checker/closure、Proxy、内建篡改或跨OS来源。成功模型候选不授删除/kill权。
- 已披露非阻塞限制：C1人为伪checker重复使用前缀receiver作为尾槽可得到incomplete但不能得到候选，不能声称完整状态可达性认证；A1 errorObservations真实可超过32，receiver故障快照schema仍限32，但原桥健康检查先失败、原guard保留首错。本项不宣传完全故障快照诊断或全部恶意快照拒绝。

### 尝试、验证与证据

证据根`A2B=/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/pm-unit/q2-a2b`。

- 两次实现均实际`5x/gpt-5.6-sol`。attempt01先经额度中断恢复（不计失败），最终27组/strict通过但主代理发现全局R顺序误拒与T尾字节漏判，实际交付未通过。attempt02修该两项、31组通过后，独立审查复现F1合法R过渡误拒、F2终结矛盾被无关缺项掩盖；第二次交付未通过。依据`MAIN-TAKEOVER.md`，主代理仅接手本A2B剩余F1/F2，未扩大到其他任务。
- 主代理限定修复后36组VM、strict及原独立24组重放通过。实际`5x/gpt-6-astra` review-02复核F1/F2通过，重跑36组、strict、原24组、14变异；补充7组契约检查及1组C1边界观察，包括136次真实桥过渡、19个固定负向快照及32个缺项/传输错误组合。组内观察数不与测试组数相加，C1仅是无候选观察而不是伪快照被拒证据。
- 主代理完整核对源码/差异及两份独立脚本，最低Node22.19.0实际重跑原36组、24组原审脚本、8组补充及14变异，全部exit0；Node26.8.2与Node22证据分列。14个mutant均成功加载后由真实AssertionError命中；“第二轮检查”原变异仅次数证据，额外负向迟到错误探针只证明特定场景，不扩为任意checker当前性认证。
- 当前SHA-256：receiver `2c96278205c5fd68c25f69e03bff2a088413cdf7aaa29024de3c9a5609f4d87a`；VM `d773e84b386ac307de80998610d8da319e0091c5d73c38fc5f1ebcd53b9d0ef6`。真实Q1/A1/bridge字节保持原已审提交内容。证据：`attempt-01/`、`attempt-02/`、`main-check/`、`main-repair/`、`review-01/`、`review-02/`及`main-integration.json`。旧review01 exit1、开发期类型/装置错误、额度恢复和过期验证记录均保留，没有反写历史PASS。

准确验证入口：

```sh
node tests/pm-sdk-quiescence-receiver.vm.mjs
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --allowJs --checkJs --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node tests/helpers/pm-sdk-quiescence-receiver.mjs tests/pm-sdk-quiescence-receiver.vm.mjs
```

Node22使用既有`toolchain/runtime/node-v22.19.0-darwin-arm64/bin/node`，另执行`$A2B/review-01/independent.mjs`和`$A2B/review-02/{supplement.mjs,mutation-audit.mjs}`；未执行默认setup、整仓/安装/生产、SDK或真实资源。

- 验收范围：仅M4-AC8测试装置/证据真实性前置；接受受控原桥前提下的纯A2B，不签A2整体、完整Q2或M4。真实fd/OS EOF、跨进程健康终结、进程退出与收尾、B阶段、SDK/daemon/ROOT-B尚未验证。
- 本地保存仅两新文件及本实施小节，实际提交号、树/hash与暂存区核验见`$A2B/commit.json`；不夹带其他未提交成果，不push/发布或操作用户数据。所有临时输出为必要诊断证据保留，没有被测资源待清理。

## M4-PM-Q2-B1-FD-MINIMAL：探针实现与纯VM限定整合，live未执行

- 文件：`tests/pm-sdk-quiescence-node-probe.mjs`、`tests/fixtures/pm-sdk-quiescence-child.cjs`。默认无gate只拒绝，不spawn/操作fd3；准确gate和case仅是防误触发开关，不替代运行授权。固定macOS arm64 Node26.8.2/22.19.0及子路径，O→A单一无后代源码、stdio fd3、最小环境；不接Q1/A1/A2或SDK，不实现信号/kill/unref/监督者。**本功能只验收实现和VM，没有真实gate运行。**
- 当前协议：2字节prefix、整帧≤256、payload≤254，固定META:1枚举/DATA:2:probe/ACK:3:14；normal、partial残帧及closed-fd预期错误分类分开。父原CP exit/close、读端end/close/error分别记录，不以写回执/exit/marker代真实end或close。5/10秒仅锁存期限失败，未close保持原CP、读流和ref keeper，close后清自建timer。
- 失败安全：129次普通事件即预算失效，停止后续载荷积累仍保留读取和固定终态；原spawn/child/stream错误先私有存在位与原引用保存，公开结果只固定元数据，不读取opaque getter/转换/正文。stdout同步/异步故障非递归锁存、停重试且非零退出，不释放未close owner。最终JSON可能先打印ok再发生stdout错，观察者必须同时核对完整输出与最终退出状态。
- 首轮实际sol交付经主代理反例和独立astra审查确认R1—R5/V1未通过；第二次由实际`5x/gpt-5.6-sol`限定返修，主代理核diff/脚本/证据后由实际`5x/gpt-6-astra`复审通过。旧失败与事件覆盖错误表述保留，更正以review01/02及本节为准；句柄不可用/回合上限未当作实施失败。

### 验证及证据

`B1=/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/pm-unit/q2-b1`。

- 父SHA-256 `b901445c509a587b09b694c066f602a7add6a69da455885cd948e85d689cd1df`；子 `c6096879ee60538e2075219f8614787ea20b32d5719ebb5f00f59b32332ef403`；纯VM验证器 `$B1/attempt-02/vm-validate.mjs` 为 `4e9214d7bfc7925bc9c3873659dea450fc461b4108e4d6de1167eb6357fde0a6`。该验证器在证据目录保留，不是仓库默认测试入口；不得把带gate真实运行当作复现VM的方式。
- Node26.8.2原VM12个命名组通过，其中含9变异汇总；独立另7个分组覆盖R1—R5和C1观察，九变异逐项正确基线先过、mutant加载后真实AssertionError命中。计数不相加为更多变异。主代理已完整读VM与独立脚本，并在最低Node22.19.0实际重跑同12组/7独立分组/9变异，均exit0；没有真实被测子进程/fd。
- `node --check`父子、显式strict/checkJs父子及VM均exit0。无gate父精确NOT_AUTHORIZED、父子退出64为预期拒绝，不能称三case真实协议通过；主代理/审查未用gate运行。
- 必要证据：`attempt-01/`原失败，`attempt-02/DELIVERY.md`及final-*与精确diff，`review-01/REVIEW.md`，`review-02/{REVIEW.md,review-validator.mjs,final-audit.stdout}`及原输出/exit，`main-check/node22-*`与`main-integration.json`。证据权限0700/0600，未覆盖旧错误或原日志。

安全复现命令仅为：

```sh
node --check tests/pm-sdk-quiescence-node-probe.mjs
node --check tests/fixtures/pm-sdk-quiescence-child.cjs
node "$B1/attempt-02/vm-validate.mjs"
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --allowJs --checkJs --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node tests/pm-sdk-quiescence-node-probe.mjs tests/fixtures/pm-sdk-quiescence-child.cjs "$B1/attempt-02/vm-validate.mjs"
```

- 保留限制C1：固定信号枚举遗漏SIGINFO，注入(null,SIGINFO)公开信息折叠但最终失败；不合Node自然终态的(0,unknown signal)合成输入可归一化成通过，不冒称它是真实固定拓扑事件，也不宣传任意信号精确保真。未来增加信号或完整异常终态目标前需另行对齐枚举/null未知分类，不静默扩权。
- **真实B1仍阻塞**：宿主timeout/cancel是否保留owner未核实，延长timeout不是证明；未执行真实fd类型、字节送达、EOF排序、短写/EAGAIN/EPIPE/背压或资源收尾。未验SDK/ROOT-B/安装/完整Q2或M4，本节只支持M4-AC8测试装置证据真实性前置。
- 本地提交仅两个probe和本实施小节，实际编号与树/hash/空暂存区核对见`$B1/commit.json`。其他未提交成果保留，不push/发布。必要诊断全部保留，无被测资源待清理。

## M4-PM-B1-NODE22-CANONICAL：固定可执行文件路径修复

- 实际自然验证进度：Node26三case分别有父exit0、原CP exit/close及fd end/close、准确帧和无错误/期限证据；normal 39字节/code0，partial18字节/code20、closed-fd15字节/code21为预期故障匹配，fd类型均socket。原路径查验的一次禁止Python使用和normal后处理字段定位错误均保留；主代理另以准确字段独立核验原输出，没有重跑normal。
- Node22首次normal父exit1，仅configuration-rejected输出，实际process.execPath是/private/var/...而固定白名单是/var/...；源码未进入runProbe，无本例child，批次已停。不是结束未确认或超时，更不是协议通过；原失败位于`q2-b1/live-natural/n22-normal.*`，未覆盖。
- B1两次实际实现产物缺陷及主代理接手依据见`q2-b1/MAIN-TAKEOVER.md`。此次仅将`tests/pm-sdk-quiescence-node-probe.mjs`中固定Node22路径改为同一已冻结二进制的canonical绝对路径；版本不变，不动态择Node、不新增任意路径fallback，不改协议/预算/其他模块。
- 主代理Node只读realpath/dev/ino/hash核对后，独立astra窄复核确认父唯一字符串还原后精确等于原已审hash，Node22与原清单同文件、实际版本和execPath吻合。主代理从宿主运行回执核实际`5x/gpt-6-astra`；审查者环境只有model没有provider的限制另列，不以环境缺项否定已核宿主回执或伪造环境字段。
- 新`canonical-repair/vm-validate.mjs`仅修改原VM的固定Node22正向字面并增加旧/var mock拒绝，12组/9变异及三文件显式strict/checkJs均exit0。原Node26真实三例对应旧父hash；此一行适用性静态确认其Node26路径/行为未变，但未把旧运行改写为新hash实测。真实Node22后续仍须另行授权，不由本窄修签通过。
- 当前父SHA-256 `be0d218a7d09cb69800fb54c9327d79c6498254128f58ad88cc37d5b711bbed9`，子仍`c6096879ee60538e2075219f8614787ea20b32d5719ebb5f00f59b32332ef403`。证据根为`/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/pm-unit/`下`q2-b1/canonical-review/{REVIEW.md,checks.json,start.json,end.json}`和各命令/退出、`canonical-repair/`主代理VM/strict、`live-natural/`原始结果。
- 验证命令：`node "$B1/canonical-repair/vm-validate.mjs"`；显式`node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --allowJs --checkJs --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node tests/pm-sdk-quiescence-node-probe.mjs tests/fixtures/pm-sdk-quiescence-child.cjs "$B1/canonical-repair/vm-validate.mjs"`，其中B1为上述q2-b1证据目录。未运行真实gate做本修复验证。
- 仅提交该父文件一行与本实施小节，提交树/hash证据见`q2-b1/canonical-repair/commit.json`。主代理原自然路径缩小裁定及中断停批限制继续有效，不签SDK资源收尾、取消保O、真实Node22协议或M4整体完成；其他未提交成果不夹带。

## M4-PM-B1-NATURAL-VERIFY：两Node六例自然fd机制验证

- 在用户自主推进M4授权内，主代理经独立取消边界裁定和当前工具静态加载链核验，仅批准固定无后代O→A自然结束实验。原“任意取消必须保O”的额外前置仅对此零业务持久资源命题收窄，历史禁止记录不倒改；中断/异常立即失败停批、不猜测回收/扫描补杀/重试，不能推广SDK或业务根。相关决定：`q2-b1/NATURAL-PATH-DECISION.md`、`b1-cancel-boundary-review/{REVIEW.md,BINDING-ADDENDUM.md}`及`live-natural/`逐批授权。
- 实际sol执行并由主代理核原stdout/stderr/exit和工具回执：Node26.8.2、Node22.19.0各normal/partial/closed-fd三例自然完成。每例父exit0、原CP exit/close码对应0/20/21且signal=null、读端end/close、无失败/期限/输出错误，fd3 fstat均为socket。normal收到39字节，DATA写回执14；partial18字节/精确残帧000858、closed-fd15字节分别为expected-failure-matched，不改称正常协议通过。
- Node26三例使用父hash b901445c509a587b09b694c066f602a7add6a69da455885cd948e85d689cd1df；Node22三例使用固定canonical修复后的父be0d218a7d09cb69800fb54c9327d79c6498254128f58ad88cc37d5b711bbed9，子同c6096879ee60538e2075219f8614787ea20b32d5719ebb5f00f59b32332ef403。旧Node26结果不改绑新hash，一行修复的无影响范围仅静态核对；不声称两个版本都在同父hash重跑。
- 独立实际astra只读核验六原日志及工具回执，见`q2-b1/live-review/{REVIEW.md,ADDENDUM.md,checks.json,checks-addendum.json}`。首次报告缺两回执的缺口由主代理归档既有原tool记录补齐，没有重跑/覆盖日志；补充结论为六例限定范围证据闭合。模型provider由主代理宿主回执核对，审查者环境缺provider的说明保留。
- 历史异常保留：首次静态前置违规调用Python只读realpath，未启动probe；主代理随后Node重核并记录偏差。Node26 normal后处理错误字段定位导致unconfirmed/校验器exit2，主代理据准确原字段重核通过而不重跑。Node22旧normal配置拒绝exit1未进入runProbe，修复固定canonical并独立复审后用新prefix再授权，旧失败文件不覆盖。
- 精确命令及环境在`live-natural/{n26-normal-command.json,remaining-cases.json,canonical-cases-authorization.json}`：每条`/usr/bin/env -i LANG=C LC_ALL=C <固定Node绝对路径> tests/pm-sdk-quiescence-node-probe.mjs --authorize=M4-PM-Q2-B1-FD-MINIMAL --case=<normal|partial|closed-fd>`，cwd固定本工作区、每例工具观察30秒、不并行。Node26绝对入口/opt/homebrew/Cellar/node/26.8.2/bin/node，Node22为原toolchain中/private/var canonical入口。gate只是防误运行，不能据本小节对其他现场/版本任意重跑。
- 证据根`/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/pm-unit/q2-b1/`；原始结果在live-natural的n26-*、n22-normal-canonical/n22-partial/n22-closed-fd前缀，主代理汇总/真实工具记录及准确verify脚本同目录，全部必要证据保留。未创建业务根、SDK、网络或目录删除；成功各例均有原自然close与父退出，不以PID扫描推断结束。
- 本结果只证明固定版本/平台/源码下的六个自然机制观察，不证明任意取消保O、有限终止、PIPE_BUF或多writer原子性、背压/短写、独立组收尾、SDK清理/ROOT-B及M4完整验收。B2创建入口、fork/spawnSync/Jiti/Vite等仍按范围继续，不由socket类型推导保证。
- 本次提交仅本实施记录以保存已核验证据结论；实际提交号见`q2-b1/live-natural/commit.json`，不夹带在途B2代码或其它未提交成果。

## M4-PM-Q2-B2-CREATION-ENTRY：受控创建入口探针实施/VM整合

- 文件：`tests/pm-sdk-quiescence-creation-entry.cjs`、`.mjs`、`.vm.mjs`。CJS共用runner与入口、真实ESM named-import入口、零进程VM验证；复用已审A1，不改其接口。仅精确gate与固定case/runtime可能进入创建，普通导入与无gate零创建；本节尚无任何B2 live证据。
- 行为：保存/恢复完整ChildProcess.prototype.spawn descriptor，安装值为原A1 guard.spawn，完整原方法this/args/err与公共CP及原Promise.child身份分别记录。pre-native必需errorMonitor/close注册独立尝试后首错原样抛给A1阻创建；post-native各流注册异常仍保留原receiver/keeper，不把公共CP缺失或native throw当未创建。
- 原CP及三路原流close与验收事实分开：未知任一资源结束只在5/10秒失效保全；全部资源close但验收结果缺失可明确失败完成。child仅errorMonitor保原未处理语义，未加普通error/uncaughtException吞错、kill/detach/unref/监督者。父stdout持续安全通道、两入口progress和失败订阅、stdin callback error/成功存在位、分流4KiB超限后只排空均接线；不读/序列化opaque原错。
- 两次实际sol交付失败（attempt01 R1—R7、attempt02 F1—F5），主代理仅接手本三文件剩余，依据`q2-b2/MAIN-TAKEOVER.md`；实际`5x/gpt-6-astra` review03复核通过。回合/句柄/装置锚点错误不计实施失败，原日志均保留。主代理检查当前源码、精确diff、独立脚本/结果及实际模型回执后限定接受。

### 验证与证据

证据根`B2=/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/pm-unit/q2-b2`。

- 当前SHA：CJS `82e14614a462e82d5b3a18e955020b91bf16d072d8b99d754d741cfef31b41d2`；ESM `70c30364c871ef4b0a4ce37b359b1526f2e88eb10c1757974b125a872eb6fd86`；VM `90c3c42747fd23ea2c06937a2bd8d3ec1204ca85332f3b21a6c78cd791281b7a`。A1与已提交hash完全一致，不包含在本功能提交。
- Node26.8.2：三项语法、显式strict/checkJs、31组VM（16行为+15变异）通过；每变异正常基线先过、mutant成功加载、实际AssertionError/ERR_ASSERTION命中。独立复审另核F1三API真实ESM入口、F2共21个注册失败/原错组合、post-native资源保全、stdin opaque及progress迟到回执；正常模型依赖真实A1，CP/stream/clock皆内存。
- 主代理最低Node22.19.0实际重跑同31组/15变异及review03独立脚本，exit0。没有把mock child版本或VM结果说成真实Node22 --version子进程/stdio完成；B2两版本live仍待逐例授权。
- 保留快照边界：progress失败若发生在runner final生成之后不会回写旧JSON，持续通道仍锁存并保持外层非零；该时序旧报告本已因期限失败、全部资源close，不能用旧快照单独签成功。正式判断必须最终输出回调/通道状态及O实际退出组合，不能声称任意未来错误已包含在旧报告。
- 命令：三个`node --check`；`node tests/pm-sdk-quiescence-creation-entry.vm.mjs`；`node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --allowJs --checkJs --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node tests/pm-sdk-quiescence-creation-entry.cjs tests/pm-sdk-quiescence-creation-entry.mjs tests/pm-sdk-quiescence-creation-entry.vm.mjs`。Node22为既有toolchain canonical绝对入口，仅运行同VM和`$B2/review-03/{independent.mjs,mutation-audit.mjs}`。
- 证据：`attempt-01/`、`attempt-02/`全部失败与最终日志；`main-check/owner-counterexample.*`和ESM遗漏反例；`main-repair/`当前diff/hash/主代理结果；`review-01/02/03/`及`main-integration.json`。旧开发期日志缺失处由宿主tool回执补档，补档身份和装置错误均如实保留，不追溯重写通过。
- 未覆盖：B2真实CJS/ESM创建入口、真实child/stdin/stdio终态、fork/IPC、spawnSync、Jiti/Vite、跨进程不可丢记录、SDK/业务资源收尾；不将内存R/B记录或B1六自然fd结果替代这些证据。不签完整Q2/M4、取消保O/删除权限。
- 本功能提交只三新文件及本节，实际提交号/树/hash/空暂存区核对见`$B2/commit.json`；其余未提交成果保持，不push/发布或回收旧进程/目录。

## M4-PM-B2-NATURAL-VERIFY：十二例真实自然创建入口验证

- 固定Node26.8.2及最低Node22.19.0，各CJS/ESM×spawn/execFile/promisify(execFile)共12例，实际sol按首例及后续条件manifest串行执行，每例live和准确validator均exit0，stderr空。主代理逐例核原stdout/exit及12条唯一正常工具回执，随后实际astra独立190项只读核验通过；唯一性限提供的原回执，不冒称全宿主历史扫描。
- 每例唯一原prototype调用、原return0、native this=公共CP=A1 owned receiver、R在native前且B对应原pid，guard健康closed、descriptor完整恢复；原child spawn/exit/close 0/null，三stdio end/finish/close按成功条件齐备，精确版本输出及空stderr，无期限/失败/输出错。execFile回调一次null，promisify原Promise.child匹配且fulfilled；跨流实际顺序记录，不以sleep推定。
- 当前受验三源码SHA为CJS82e14614a462e82d5b3a18e955020b91bf16d072d8b99d754d741cfef31b41d2、ESM70c30364c871ef4b0a4ce37b359b1526f2e88eb10c1757974b125a872eb6fd86、VM90c3c42747fd23ea2c06937a2bd8d3ec1204ca85332f3b21a6c78cd791281b7a，A1cd98fc23…与已审提交一致。全部自然case对应同一B2代码基线；输入前后hash不作不可变文件系统证明。
- 精确命令与条件授权在`q2-b2/live-natural/n26-cjs-spawn-command.json`、`remaining-authorization.json`：白名单env下固定Node绝对路径执行对应.cjs/.mjs，gate `--authorize=M4-PM-Q2-B2-CREATION-ENTRY`、固定case，单个non-detached无后代Node --version，无业务根/网络/SDK/信号/删除；每例工具30秒仅观察窗口，异常/取消/缺证据停批不重试。主代理原对象结束核验后才允许下一例，不以JSON单独ok代替父实际退出。
- 原始日志/准确验证/工具回执及主代理结论：`q2-b2/live-natural/`各prefix文件、`main-twelve-case-integration.json`、`final-integration.json`；独立报告和hash：`q2-b2/live-review/{REVIEW.md,checks.json}`。证据根仍`/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/pm-unit/`。补核只读日志，无重新运行或清理；主代理一次摘要打印空数组TypeError属于日志显示装置，未改证据，后续结构化断言全通过。
- 已证实仅本地固定自然API创建/结束及进程内A1 R/B；不是跨进程不可丢记录、任意取消保O、fork/IPC、spawnSync、Jiti/Vite、SDK/ROOT-B或M4验收。主代理接收该限定结果，保留所有已知边界。
- 本次提交仅本实施记录，实际编号见`q2-b2/live-natural/commit.json`；不夹带后续fork计划或其它未提交成果，未push/发布或回收用户资料。

## M4-PM-Q2-B3-FORK：固定fork/IPC探针代码及VM整合

- 四文件范围：在`tests/pm-sdk-quiescence-creation-entry.cjs/.mjs/.vm.mjs`增加fork，新增`tests/fixtures/pm-sdk-quiescence-fork-child.cjs`；真实A1不改。CJS与ESM各自原fork导入，独立B3 gate不借B2旧授权；固定child绝对路径/空args、原Node execPath、execArgv=[]、json序列化、三stdio pipe+IPC槽3、最小env、不shell/detached，不开放任意程序。
- child正常stdout version callback→一次固定ready send callback→一次disconnect自然结束；错误收尾共用disconnectAttempted，调用前锁存，不因同步throw/重复error/迟到callback再试，失败保持非零。原生Node先置connected=false的源码/VM与保持true的故障注入分列，不把契约反例称原生漏洞。
- 父message/disconnect普通函数核原this=owned/publicCP、严格own-data固定schema且无sendHandle、单次计数/顺序，不保正文；ready/disconnect不代原CP close，成功仍需原CP及三stdio完整终态、guard健康/descriptor恢复/精确版本/父输出最终状态。IPC仅本次关联事实，不授关闭/清理权限。
- 两次实际sol交付：首轮41组/strict通过但“不重试”证据缺口被主代理/独立astra复现，第二轮只child和VM修正，父两文件hash保持；独立review02补齐原审因假时钟不足exit13未完成的范围，原错误不覆盖。主代理核实际差异/脚本/hash/命令后限定接受代码/VM，不计live。

### 验证与边界

证据根`B3=/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/completion-03/git-prerequisite/task-02e/pm-unit/q2-b3`。

- 当前SHA：CJSdbb270923c8a0e478ed680faa932d217dbeef2d6a2f9913e1a220ef145e065ef，ESM3c784053f64789f3783f64e4492752abaa5dbfcee91976b712d53bc5c2af9658，VMcf71e7141f604575bd8b8b75c942ce650491b22f0bad1e045e52cf0dc5bda408，child1eee5d05fba390ccb0bc6149e271d4fac85aa3a3f09d06996db8ca91cc59ff4e。
- Node26四语法检查、显式strict/checkJs、42组VM通过；原31组/15变异语义保留，最终20个变异逐项正常基线先过、mutant实际加载后AssertionError命中。独立review02另完成25条补测输出，覆盖child初错/迟回执、两入口gate、错this/schema、晚IPC、四路缺close、注册失败+未知CP、IPC洪泛；内存重复emit不算真实事件证明。
- 主代理完整读review02与supplement，最低Node22.19.0实际重跑42组及独立supplement（内含20变异、25补测输出），exit0；两版内嵌fork/IPC及disconnect函数只读/内存执行证据不是原生fork已实跑。前后hash只说明两端相同，不排除未观测外部变化。
- 保留限制：CP/stdio已结束之后人为emit额外IPC不会追溯撤销已返回报告或改原退出码；实测披露，但未证明固定child原生结束后可达。最终快照不是通用防伪事件认证；不能把此边界扩成任意未受信creator系统。
- 命令：四文件`node --check`；`node tests/pm-sdk-quiescence-creation-entry.vm.mjs`；`node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --allowJs --checkJs --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node tests/pm-sdk-quiescence-creation-entry.cjs tests/pm-sdk-quiescence-creation-entry.mjs tests/pm-sdk-quiescence-creation-entry.vm.mjs tests/fixtures/pm-sdk-quiescence-fork-child.cjs`。补测入口`$B3/review-02/supplement.mjs`；均内存依赖，无授权gate实际运行。
- 证据：`attempt-01/02/`原类型/锚点/交付/精确diff，`review-01/02/`原失败及完整新结果，`main-check/`两Node验证，`main-integration.json`。目录0700文件0600，必要诊断保留，无被测系统资源待清理。
- 未覆盖：两Node×两入口真实自然fork四例、spawnSync/Jiti/Vite、跨进程不可丢登记、SDK/ROOT-B/任意取消保O与M4整体。后续须独立单case授权，不能用B1/B2自然证据顶替fork。
- 本功能提交只上述四文件及本节，实际提交号/树/hash/空暂存区核对见`$B3/commit.json`，其他未提交成果保持，无push/发布或用户数据操作。
