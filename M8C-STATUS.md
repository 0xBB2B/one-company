# M8C 状态

阶段目标：需求文档规范改为可自定义的 `requirement-doc` skill，包内默认为背景、需求、功能、实现、验收五大板块，程序守住每个标题有唯一编号、标出两段记录的插入板块、批准时按板块清单核对的底线；批准时保存规范快照。另外各停止路径写明停止原因。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 零自定义用包内默认 skill，行为与 M8A 一致 | 通过 | ad1a392；tests/requirement-doc.test.ts（包内默认即五大板块，记录插在实现、验收）、tests/rules-extension.test.ts（注入默认规范，五板块按序）、tests/prod-view.test.ts 与 tests/main-requirement-interaction.test.ts 的 M8A-AC9 用例原样通过；typecheck、单元 2339、集成 80、安装 11 全部通过（.bb-spec/.cache/m8c/unit-ac8.txt、integration.txt、installation.txt） | 无 |
| AC2 查找顺序项目 > 用户 > 包内，未受信任项目的 skill 不生效 | 通过 | ad1a392；tests/requirement-doc.test.ts（三层顺序、未受信任跳过项目层）、tests/main-requirement-interaction.test.ts（未受信任时按默认五板块拒绝且不调用模型，受信任后按项目规范批准）、tests/rules-extension.test.ts（注入来源随信任切换） | 无 |
| AC3 自定义规范下批准核对、PM 接手、归档记录插入位置都正确 | 通过 | ad1a392；tests/main-requirement-interaction.test.ts（三板块规范批准）、tests/workflow-close.test.ts（验收记录板块在前、另有风险板块时两段记录各在所标板块末尾）、tests/prod-view.test.ts（按清单核对、每个标题唯一编号）；AC7 真实模型：PM 接手后按自定义编号 scenarios.*、check.*、approach 登记任务，归档里验收记录在「检验」末尾、实现记录在「做法」末尾（证据 .bb-spec/.cache/m8c/acceptance/custom-doc-2026-09-28T13-08-27-333Z/archive.md） | 无 |
| AC4 skill 无效时批准报错并写明原因，不退回默认 | 通过 | ad1a392；tests/requirement-doc.test.ts（YAML 错、缺清单、记录板块缺失或重复、编号重复或非法、标题空、未知字段、record 值非法共 10 种，报错含文件路径与原因，不退回用户层或包内）、tests/main-requirement-interaction.test.ts（批准报 requirement_doc_invalid、不调用模型、仍为草稿、无快照）、tests/rules-extension.test.ts（主会话看到无效原因） | 无 |
| AC5 批准后修改 skill，已批准需求按快照归档，新需求按新规范 | 通过 | ad1a392；tests/main-requirement-interaction.test.ts（首次批准存板块清单与 skill hash；改 skill 后同一需求再批准仍按快照、快照不变，新解析得到新规范）、tests/workflow-close.test.ts（归档只按记录里的快照插入）；M8C 之前批准的需求没有快照，按当时的五大板块归档 | 无 |
| AC6 调试沙箱与 change_apply 都不能写 .pi/skills | 通过 | 12ba9de；tests/change-apply.test.ts、tests/core-permissions.test.ts、tests/verification-run.test.ts | 无 |
| AC7 真实模型用自定义规范完整跑通一次 | 通过 | ecb3a99（tests/acceptance/zero-custom-loop.test.ts 的 M8C-AC7 用例：受信任项目规范目标、场景、检验、做法四板块，检验在做法之前）；第 1 轮 pnpm run test:acceptance -t "M8C-AC7" 通过（1/1），12.9 分钟以完成关闭，2 个 worker、2 个 reviewer、1 个 QA 均完成，需求记录快照为 goal、scenarios、check、approach，归档无默认板块（证据 .bb-spec/.cache/m8c/acceptance/custom-doc-2026-09-28T13-08-27-333Z/report.json、archive.md） | 无 |
| AC8 各停止路径写明原因，续租失败记错误码，只记录不改行为 | 通过 | 2d6fa90；运行记录新增 stopCause：主代理停止、PM 停止子运行、随父运行停止、被新 PM 取代、需求关闭、续租失败（带错误码）、配置变化、重新规划、全部停止；tests/pm-dispatch.test.ts（主代理、需求关闭、被取代、续租失败带错误码）、tests/run-manager.test.ts（随父停止、全部停止）、tests/explore-dispatch.test.ts（PM 停止时 explore 随父停止、PM 用 agent_manage 停止 explore）、tests/agent-selection.test.ts（配置变化）、tests/adjudication.test.ts（重新规划）；去掉记录后 6 条断言失败，证明断言有效 | 无（AC7 那轮 PM 只在关闭时停止，stopCause 为 requirement_closing，第 56 轮的中途中止没有复现；再出现时据 report.json 里各运行的 stopCause 定位） |

## 当前阻塞

无。M8C 全部 AC 通过，阶段收口；下一阶段恢复 M9。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M9 章节与 §13），再读 M9-STATUS.md 与 M8C-STATUS.md，核对 git status 与最近提交。M0–M8、M8A、M8B、M8C 已收口不重做，恢复执行 M9。
M8C 带给 M9 的变化：需求文档规范由 requirement-doc skill 定义（包内默认五大板块，项目 .pi/skills 受信任时优先），批准时存规范快照，归档按快照插入两段记录；运行记录 stopCause 写明停止原因，真实模型卡点可从 report.json 的 runs[].stopCause 查。
真实模型运行命令：ONE_COMPANY_ACCEPTANCE_MODEL=5x/gpt-6-luna ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance（-t 选用例；后台运行，证据目录 events.jsonl 10 分钟无更新就在该目录放 STOP 文件）。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
