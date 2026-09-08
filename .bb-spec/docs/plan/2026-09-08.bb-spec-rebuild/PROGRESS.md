# 执行进度
| 序号 | Plan | 状态 | 完成时间 |
|---|---|---|---|
| 01 | package-skeleton | done | 2026-09-08 |
| 02 | local-identity | done | 2026-09-08 |
| 03 | versioned-store | done | 2026-09-09 |
| 04 | sleep-aware-clock | done | 2026-09-08 |
| 05 | decision-ledger | done | 2026-09-09 |
| 06 | workflow-state | pending | — |
| 07 | workflow-tool | pending | — |
| 08 | migration | pending | — |
| 09 | role-catalog | done | 2026-09-08 |
| 10 | role-settings | done | 2026-09-09 |
| 11 | mcp-discovery | done | 2026-09-09 |
| 12 | settings-controller | pending | — |
| 14 | daemon-protocol | done | 2026-09-09 |
| 15 | daemon-lifecycle | pending | — |
| 16 | structured-verdict | done | 2026-09-08 |
| 17 | error-details | done | 2026-09-09 |
| 18 | run-store | done | 2026-09-09 |
| 19 | session-records | pending | — |
| 20 | shell-registry | pending | — |
| 21 | shell-bash-tool | pending | — |
| 22 | network-pause | done | 2026-09-09 |
| 23 | role-session | pending | — |
| 24 | requirement-agent-session | pending | — |
| 25 | run-manager | pending | — |
| 26 | relay-queue | pending | — |
| 27 | daemon-client | pending | — |
| 28 | dispatch-tools | pending | — |
| 29 | relay-inbox | pending | — |
| 30 | window-lifecycle | pending | — |
| 31 | commands | pending | — |
| 32 | agents-activity | pending | — |
| 33 | agents-panel | pending | — |
| 34 | transcript-view | pending | — |
| 35 | shell-page | pending | — |
| 38 | window-registry | pending | — |
| 39 | range-claims | pending | — |
| 40 | write-guard | pending | — |
| 42 | workspace-coordination | pending | — |
| 43 | spec-docs-format | pending | — |
| 45 | role-prompts | pending | — |
| 46 | planner-role | pending | — |
| 49 | main-session-skills | pending | — |
| 51 | integration-verification | pending | — |
## 当前
规范与计划经设计审查重排（spec 52→42 份，plan 51→43 份，2026-09-09），暂停解除。返修 09/14/18 已完成（各两轮复审，2026-09-09）。已完成 01–05、09–11、14、16–18、22 共 13 个单元；先按新规范返修 09 role-catalog（项目层定义随宿主信任、删除按 kind 的派工判定）、14 daemon-protocol（新增 dispatch.review 与 shells.markStopped，删除 uncertain）、18 run-store（删除 uncertain 状态，stop 直接终态），再进入下一波：06 workflow-state（依赖 03、05）、12 settings-controller（依赖 10、11）、15 daemon-lifecycle（依赖 03、04、14）、20 shell-registry（依赖 04）、38 window-registry（依赖 02、03、04）。02 local-identity 的守护进程路径断言随 15 一起改。

已完成单元的自修记录：local-identity（两轮）、sleep-aware-clock（两轮）、role-catalog（两轮）、structured-verdict（两轮）、versioned-store（五轮：锁回收最终为两次观察 + inode 核对，可重入持有集带 active 标记）、role-settings（三轮）、error-details（规范变更后重做 + 五轮）、network-pause（四轮）、daemon-protocol（三轮）、decision-ledger（三轮）、run-store（三轮，含新版 shellToken）、mcp-discovery（五轮）。

已记录：package-skeleton 首轮 Review 指出验证口径缺陷与 8 条 impl-defect，plan 验证方式改为 stripTypeScriptTypes，其余自修一次后复审全部解决；enum/namespace 全文正则可能对注释误报，留待出现时收窄。
## 阻塞
（无）

## 待解决（不阻塞）
- role-settings：未知角色名条目按 plan 明文整层抛错（审查认为爆炸半径偏大，留设置页处理）；保存后未 fsync 目录。
- network-pause：强制门户下任意 HTTP 响应被视为可达；网络续接无次数上限（归 run-manager）。
- versioned-store：可重入锁在同一持锁上下文内的并发写者之间不互斥（契约：持锁上下文内不得并发写）。
- decision-ledger：工具执行期间的中止信号只在开工前检查，飞行中中止需把 signal 透传进 withDirLock 等待循环；台账文件被外部删除后编号会从头复用（需编号水位文档，规范未定）；工具参数 cwd 由模型给出，可写入本机其他仓库的数据区（plan 明定，是否限制为本会话仓库待裁定）。
- mcp-discovery：守护进程用 Node 运行时无法直接 import .ts 入口，loadMcpForRole 的 importer 须由 daemon-lifecycle 注入 SDK 的 jiti；只读角色写参数判定为键名白名单，单数 path 按既有用例拒绝。
- run-store：list 与启动标记全量遍历运行目录无上限，保留策略与索引未在规范定义；记录文件中不在当前状态集合内的状态串（如旧版写下的 uncertain）不会被拒读，会被启动标记改为可续接的 interrupted——按预发布期不存在旧数据处理，未加校验，是否需要 fail-close 待裁定。
- daemon-protocol：decodeFrames 的 rest 无长度上限（交 daemon-lifecycle）；仓库无 typecheck 脚本，类型层不变量对测试不可见，补 typescript 依赖需用户批准。
- local-identity：工作区扫描不跟随符号链接目录，规范未界定，未处理。
- role-catalog：prompt_mode 取值域未在 plan 定义，暂宽松直通，待角色提示词单元定义后收紧。
- sleep-aware-clock：单一墙钟来源下事件循环长阻塞或 NTP 步进会被判为睡眠（设计取舍，未处理）；周期定时器唤醒即触发一次的语义未在规范界定。
- role-catalog Review 指出：reviewer 与 acceptance 默认工具含 bash，"审查只读 / 验收不读源码"边界当前只由提示词承载；归因 plan/spec 层，留待 shell 与角色提示词单元处理。
