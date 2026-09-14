# M4 实施记录

## 当前状态

**已按用户要求暂停：本波8个在途子代理均已结束，自有测试与写入进程已收尾；没有新派工、后续修复或新一轮验收。需求将变化，等待用户新说明。M4 尚未通过整体验收，不进入 M5。** 用户已明确旧工作流永久淘汰、不考虑兼容，并写入 AGENTS；此前“等待临时停用确认”不再作为阻塞。已核验四项内核及其返修，既有统一 10 文件 288/288 与类型检查通过；本次续接逐项复算17项内核指纹，全部一致。当前推进旧授权/执行入口永久移除和真实产品接线，具体新任务及证据见下方续接记录。旧 PID 52973/53030 保留。本文件仅记录实施与核验事实，权威依据仍为当前 `SQLITE-KNOWLEDGE-REBUILD-PLAN.md`。

## 开工现场与授权

- 工作区：`/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild`；分支 `bb-spec-rebuild`。
- 开工 HEAD：`2237d05c81af9b7d02d14b8babde13e3c623c4e5`。
- 交接文字说 M3 尚未提交，但磁盘报告与 Git 已证明后来获准提交：M3 实现为 `74ae5b336e848faee45181f2b3496c793de197c9`，随后报告提交为上述 HEAD。本轮没有提交授权，不暂存、提交、推送或操作真实数据库。
- 原有未跟踪文件：`.pi/agents/{Explore,Plan,general-purpose}.md`、`.pi/npm/.gitignore`、`.pi/settings.json`、`.pi/subagents.json`；全部保留。原有 PID 52973、53030 按 M3 交接保留，不由本轮清理。
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
| M4 | 完整prod、渐进确认和当前知识查询 | **按用户要求暂停；待新需求与结果整合，未通过整体验收** |
| M5 | 代码/spec专用变更和真实权限 | 未开始 |
| M6 | 正式验证、关闭、归档和完成提醒 | 未开始 |
| M7 | 单PM、增量plan/task和资源重构 | 未开始 |
| M8 | 团队历史边界和Git外置 | 未开始 |
| M9 | 真实闭环、性能、安装和总验收 | 未开始 |

当前暂停，先等待用户给出变更后的需求；明确后再核对M4范围及现有成果，不自动恢复旧任务，也不进入M5。旧工作流永久淘汰、不考虑兼容性的方向已经明确，除非用户另行改变，不重复询问。保留全部未提交成果、原`.pi/`与旧两个进程；不得把本次子代理交付直接当成主代理验收通过。

### 可复制的新窗口提示词

```text
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild。
当前M4按用户要求暂停，需求有变化；先取得新的具体说明并核对范围，未获继续授权不得自动实施，不进入M5。
完整读取AGENTS.md和当前SQLITE-KNOWLEDGE-REBUILD-PLAN.md，读取M4-IMPLEMENTATION-REPORT.md及M3报告最终验收段，核对实际源码、HEAD和工作区后续接。
M4证据：/var/folders/rt/s5gnkp6j1nvbty_93wltyk3w0000gn/T/m4-implementation-o_10raez/；重点查看kernel-freeze-before/after、main-kernel-combined、三项repair-review-01报告与coordination.json。
四项内核已做限定返修/主代理核对，Node26统一10文件288/288及typecheck通过；真实工具/daemon/角色接线和全M4验收尚未做。
用户已明确：旧工作流永久淘汰，不考虑兼容，已经写入AGENTS；在当前M4范围直接移除旧机制，不保留回退/开关，不提前做M5—M7兼容映射。后续必须保留交互core的真实revoke通知门槛、查询finalCheck联合门槛及实际宿主封装预算验证。
已完成的spec分析、当前查询、交互/范围内核已有本地提交，见本报告最新提交小节；当前HEAD须执行git rev-parse HEAD核对，不能沿用暂停前2237d05。其余未完成接线等改动仍未提交，保留原.pi/及旧PID52973/53030。用户仅追加授权保存已完成内容，M4实施仍暂停；不读取删除历史、不推送或操作真实数据库。本波代理和自有测试/写入均已结束，最后未完成交付未通过统一整合验收。
主代理和所有子代理必须用gpt-6-astra，显式指定并核验实际运行模型；实现/测试/独立审查子代理优先，规划可由主代理或同模型子代理完成。同一任务两次真实失败后只由主代理接手该任务，其余继续子代理优先。各内核任务目前各有一次首次交付审查失败，第二次已限定通过，没有主代理接手任务；以报告和coordination记录核实，不跨任务累计。
所有子代理结果必须由主代理审查、整合并核对实际验证后才计完成；阶段内自主推进，M4完成后总结、生成交接提示并停止，不自动进入M5。
```

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
