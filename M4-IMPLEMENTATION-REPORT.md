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
