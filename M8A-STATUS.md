# M8A 状态

阶段目标：永久移除 docs/spec 规则体系，项目当前行为以代码、测试与已完成需求的归档为准；产品托管项目中 worker 新增或修改的函数、方法、类、类型/接口与导出常量写说明注释（参照 Go 官方库写法），代理用 grep 等命令搜索注释与代码；注释不入库。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 产品中无 spec 工具、模块、表、指纹字段与流程；核心工具 10 个；角色与主会话规则不提 spec；已有 docs/spec 文件按普通文件对待 | 通过 | a86df70（工具与流程层）、8a63e09（索引层）；tests/core-permissions.test.ts（10 个工具、schema 与权限表双向一致、docs/spec 可写）、tests/role-catalog.test.ts（定义不提 spec）、tests/verification-run.test.ts（调试命令可写 docs/spec）、tests/project-index-policy.test.ts 与 tests/project-index-service.test.ts（docs/spec 按 config 建索引）；产品代码中已无 spec 相关引用 | 无 |
| AC2 检查轮、正式验证、审查、QA、完成报告、关闭与交付在无规则集指纹时按原门槛工作；四套测试全绿 | 通过 | 最终基线 1dcdcee：typecheck 通过；单元 2314、集成 79、安装 11 全部通过（.bb-spec/.cache/m8a/final-1dcdcee.txt）；旧 data.db 被拒用例在 tests/database-storage.test.ts | 无 |
| AC3 worker/reviewer 定义含说明注释规则；新基线上真实模型零自定义闭环通过，新定义带说明，审查覆盖此项 | 通过 | 定义与测试：4ad1fc5、463c818、18abe67、32ac879（tests/role-catalog.test.ts）；真实模型闭环第 45 轮（55515aa）与第 46 轮（1dcdcee）均以完成关闭：worker 先红后绿、新定义带 Go 写法说明注释，reviewer 先看 git diff、按引用编号核验红绿，结论写明注释核对结果（证据 .bb-spec/.cache/m9/acceptance/zero-custom-2026-09-28T02-55-26-895Z、…T03-07-09-586Z） | 无 |
| AC4 计划正文与 M9 验收项去除 spec 内容 | 通过 | 1ea1a60 | 无 |
| AC5 worker/PM/reviewer 定义含先红后绿规则；reviewer 只读被审尝试引用的验证记录 | 通过 | 37f3e1b 及本次（reviewer 任务说明列出 worker 引用的验证编号，tests/task-dispatch.test.ts）；tests/role-catalog.test.ts（三处规则）、tests/verification-run.test.ts（reviewer 读引用记录、读不到未引用和别的尝试、不能停止、QA 不能读） | 无 |
| AC6 PM 用 escalate 把等待其处置的任务交用户裁决；主代理与不在等待处置的任务不能上报 | 通过 | 55515aa；tests/adjudication.test.ts（escalate 端到端：转待裁决、事项标明 PM 上报、说明标为模型说法、用户再给机会按用户轮数派出、主代理与非等待任务被拒）、tests/core-permissions.test.ts、tests/role-catalog.test.ts | 无 |
| AC7 无工作区的草稿可批准生效；草稿阶段建工作区被拒；已生效无工作区派 PM 被拒、建好后可派；已生效无工作区可取消；主会话规则先批准再建工作区 | 通过 | 0c6fb56；tests/requirement-state.test.ts、tests/requirement-service.test.ts、tests/requirement-approval-manifest.test.ts（无工作区批准生效，无工作区取不到 PM 租约）、tests/workspace-manage.test.ts（草稿建工作区被拒且不弹确认；无工作区取消）、tests/pm-dispatch.test.ts（已生效无工作区派 PM 被拒）、tests/rules-extension.test.ts（规则顺序）；typecheck、单元 2317、集成 79、安装 11 全部通过（.bb-spec/.cache/m8a-ac7/final.txt；集成里 network-and-sleep 计时用例并行时偶发失败，单独重跑通过，见同目录 nas.txt） | 无 |
| AC8 completed 归档保留批准版正文每个字节，验收板块末尾插入程序生成的验收记录（检查轮、代码提交、正式测试命令/结果/退出码/用时/性能说明、QA 结论、标明模型撰写的 QA 说明与问题）；模型文字不能冒充程序内容；归档与 Git 交付按归档整体 hash 核对 | 通过 | 605aefb，本次改为插入验收板块末尾（2026-09-28 用户同意修改措辞）；tests/workflow-close.test.ts（M8A-AC8 用例：正文原样开头、验收记录各项、QA 说明里伪造的标题与条目只出现在引用块内、状态里的 archiveHash 等于归档文件 hash 且不回显 QA 说明；M6-AC10 用例：幂等与内容不同阻塞）、tests/git-delivery.test.ts（按 archiveHash 核对暂存归档）；typecheck、单元 2325、集成 80、安装 11 全部通过（.bb-spec/.cache/m8a-ac7/final-ac8.txt） | 无 |
| AC9 需求正文分五大板块（背景、需求、功能、实现、验收），主会话批准时程序核对，不符合即拒绝、不调用模型、不激活并写明期望与实际；completed 归档在实现板块末尾带程序生成的实现记录（worker 任务、提交列表、标明模型撰写的 PM 说明），模型文字不能冒充程序内容 | 通过 | df2f1a6，本次改为插入实现板块末尾；tests/workflow-close.test.ts 核对插入位置与正文字节保留，tests/zero-custom-loop.test.ts 核对两段记录各在所属板块内；本次 typecheck、单元 2328、集成 80、安装 11 全部通过（.bb-spec/.cache/m8a-ac7/final-rec.txt）；tests/prod-view.test.ts（五板块核对）、tests/main-requirement-interaction.test.ts（不符合即拒、不调用模型、不激活）、tests/rules-extension.test.ts（规则写明五板块）、tests/workflow-close.test.ts（实现记录、PM 说明伪造标题只在引用块内）、tests/zero-custom-loop.test.ts（实现记录在验收记录前，含 worker 任务、可写范围与 PM 说明）；typecheck、单元 2328（1 个 daemon-lifecycle 计时用例并行时失败，单独重跑 35/35 通过）、集成 80、安装 11（.bb-spec/.cache/m8a-ac7/final-ac9.txt、ac9-daemon-lifecycle.txt）；第 54 轮真实模型：主代理首次就按五板块写出草稿，批准通过、未被误拒，PM 任务按 features.*、acceptance.* 编号引用（证据 .bb-spec/.cache/m9/acceptance/zero-custom-2026-09-28T09-51-05-696Z）；第 55 轮真实模型以完成关闭，归档含五大板块、实现记录与验收记录（证据 .bb-spec/.cache/m9/acceptance/zero-custom-2026-09-28T10-17-43-278Z/archive.md） | 无 |
| AC10 返修后的审查能读到同一任务更早尝试引用的红绿记录，读不到别的任务的、不能停止；审查任务说明按每次尝试列出提交说明与引用；reviewer 定义写明两条规则；以测试为证据，真实模型出现返修时再补 | 通过 | c71fa02；tests/verification-run.test.ts（返修审查读到第一次的红绿与返修的绿，别的任务读不到，不能停止，QA 读不到）、tests/task-dispatch.test.ts（审查任务说明按每次尝试分行，返修标明、本次被审标明）、tests/role-catalog.test.ts（reviewer 两条规则）；typecheck、单元 2328、集成 80、安装 11 全部通过（.bb-spec/.cache/m8a-ac7/final-ac10.txt）；第 55 轮真实模型以完成关闭，但该轮没有发生审查打回与返修 | 无（2026-09-28 用户认可测试证据；真实模型出现返修时再补真实证据） |

## 当前阻塞

无。M8A 全部 AC（含 2026-09-28 用户追加的 AC7—AC10）已通过，阶段收口。用户已决定另起 M8C：需求文档规范改为可自定义的 skill，程序固定质量底线（每个标题有唯一编号、必须标出验收板块与两段记录的插入板块、批准时按 skill 的板块清单核对），批准时保存规范快照、之后修改只影响新需求；M8C 已写入计划并建 M8C-STATUS.md。M4 遗留的 executionEnabled 与 scheduling 字段已按用户决定清理。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（§4 与 §12 的 M8A、M9），再读 M8A-STATUS.md 与 M9-STATUS.md，核对 git status 与最近提交。M0–M8、M8A、M8B 已收口；下一阶段是用户决定插在 M9 之前的 M8C（需求文档规范可自定义 skill），先请用户批准 M8C 的计划正文与 AC 表再动手。
M8A 用户已定：需求工作区在用户批准之后建立，草稿阶段程序拒绝建工作区（§12 M8A 要做第 6 条）；completed 归档保留批准版正文每个字节，在验收板块末尾插入程序生成的验收记录，模型文字进引用块（要做第 7 条）；需求正文固定背景、需求、功能、实现、验收五大板块，批准时程序核对，实现板块只写用户明确的实现要求或"由 PM 规划"，归档在实现板块末尾插入程序生成的实现记录（要做第 8 条）；返修后的审查可读同一任务各次尝试引用的记录，红绿可在任意一次尝试里，返修改动可测行为须有新的红（要做第 9 条）；PM 用 workflow_manage escalate 把等待其处置的任务交用户裁决（§10.2.1 第 4 条）；change_apply 的 apply 可省略 baseHash；reviewer 任务说明给出基线提交与 git diff 命令；worker 按 TDD 先红后绿，测试与实现同一任务，reviewer 只读被审尝试引用的验证记录核对红绿（§8.9 第 8 条）；spec 整个拆掉（工具、模块、规则表、规则集指纹、候选与发布、初始化校验、知识查询规则事实、开检查轮的机械冲突检查、独立校验脚本与 resources/spec）；已有 docs/spec 文件按普通文件；注释规则只管产品托管项目，覆盖函数、方法、类、类型/接口、导出常量，Go 官方库写法；注释不入库，靠 grep；审查把关，程序不设注释门槛。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation；真实模型闭环 pnpm run test:acceptance（见 M9-STATUS.md 的运行方式）。
```
