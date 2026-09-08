---
name: user-documentation
description: README 全文重写：安装卸载、五命令与 /ps、守护进程、面板与查看页、设置页与 MCP、Shell 管理、数据布局与迁移、工作区、常见问题
---
# 使用说明

## 目标
完成后，README 能让新用户独立完成安装、发起需求、观察与控制需求代理、配置角色、管理 Shell、理解本机数据与迁移，且内容与实际行为一致。

## 业务规则（来源：spec）
- namespaced-entrypoints：五个入口 `/pi-company:new|resume|revise|sync|setting` 与独立 `/ps`，不提供其他别名。
- daemon-host：每仓库一个守护进程，由窗口按需自动拉起，无活动需求代理且无窗口连接一段时间后自动退出；崩溃标记中断；睡眠不计入超时。
- requirement-agent / workflow-shape / user-relay：主会话确认需求后派出需求代理；需求代理提议任务集与形状，用户在主会话确认；提问与通知经主会话，无窗口时排队。
- cross-window-panel / transcript-view：工作区内任意窗口面板显示全部需求代理与角色，可控制，Enter 查看实时记录；结束条目与提示保留 20 秒。
- role-catalog / settings-page / mcp-selection：角色来自包内默认与用户目录；设置页配置模型、思考、MCP；MCP 候选来自用户自行安装的 MCP 适配器扩展。
- managed-execution / status-entry / process-list：主会话与角色的 bash、`!`、`!!` 统一登记；仅 agent 可显式后台；汇总行与 `/ps`。
- local-ownership / safe-migration / workspace-coordination：流程数据在本机按仓库与需求归属；旧格式经预检与停写迁移；工作区按启动目录划分。

## 涉及文件
- 修改 `README.md` — 全文重写
- 新建 `tests/user-documentation.test.ts` — 章节与必需句断言

## 函数清单
必需章节清单（二级标题顺序固定）：
| 章节 | 必须表达的内容 |
|---|---|
| 这是什么 | 三层模型一句话：主会话澄清确认 → 需求代理规划执行 → 角色子代理；守护进程内运行、跨窗口可见可控 |
| 安装 | `pi install git:github.com/0xBB2B/pi-company`；本地开发用绝对路径并自行 `npm install`；宿主 Node ≥ 22.19；不再需要安装其他子代理系统或符号链接 |
| 卸载 | `pi remove <source>`；守护进程会在空闲后退出，或按说明手动停止；本机数据目录保留，说明其位置 |
| 快速开始 | 五命令与 `/ps` 表；一次完整流程：`/pi-company:new` → 确认 → 面板出现需求代理 → 作答提议 → 完成通知 |
| 守护进程 | 自动拉起、每仓库一个、空闲退出时限、崩溃与重启后"中断"与续接、合盖睡眠不算超时、断网自动续接 |
| 面板与查看页 | 布局位置、空输入 ↓ 进入、按钮与状态、20 秒保留、Enter 查看实时记录（只读） |
| 角色与设置 | 角色目录三层来源与包内默认五角色；`/pi-company:setting` 主页与三种候选；MCP 需自行安装适配器扩展，未安装时候选为空 |
| Shell 管理 | 统一登记、`background: true` 仅 agent 可用且仍受超时、汇总行、`/ps` 列表与 K 停止 |
| 本机数据 | 目录布局（仓库身份、需求、运行、会话记录、中继）、不随 Git 同步、旧 `.pi-spec` 数据的迁移预检与停写迁移步骤 |
| 多窗口与工作区 | 按启动目录划分、同仓库 worktree 共享、多仓库时契约先行由主会话裁定 |
| 常见问题 | 守护进程不可达怎么办；问题为什么出现在另一个窗口；为什么面板看不到别的项目；如何添加自定义角色 |
| 开发 | `bun install`、`bun test tests`、`pi install /abs/path` |

## 协作关系
- 内容以 31、33、34、13、36、08、42 的实际行为为准；文案中的命令名、状态名与 20 秒、空闲退出时限等常量须与代码一致。

## 验证方式
- 测试入口：读取 `README.md` 原文
- 测试输入：文件全文
- 预期结果：
  - 二级标题按上表顺序全部存在
  - 必需句逐字存在：`/pi-company:new`、`/pi-company:setting`、`/ps`、`每个仓库一个守护进程`、`自动拉起`、`空闲后自动退出`、`标记为中断`、`合盖睡眠`、`20 秒`、`background: true`、`.pi-company/`、`不随 Git 同步`、`按启动目录`、`pi install git:github.com/0xBB2B/pi-company`
  - 禁止句不存在：`pi-subagents`、`符号链接`、`/spec-new`、`/pi-spec:`、`.pi-spec/`（迁移章节允许出现在"旧数据"语境，测试用正则排除 `旧` 前缀的行）
- [ ] 章节顺序断言
- [ ] 必需句全部命中
- [ ] 禁止句全部缺席
