---
name: shell-page
description: Shell 状态与列表：汇总文本写入宿主状态栏（不可聚焦、不拦按键）；/ps 管理页在输入栏位置列出本窗口与工作区守护进程的每条 Shell，只读详情、K 停止确认、不确定任务的用户裁定
---
# Shell 状态与列表

## 目标
用户在原状态栏随时看到当前有多少 Shell 在跑、分别属于谁；通过 /ps 在输入栏位置查看每一条 Shell，看清归属，精确停止选定任务，并对清理无法确认的任务作出裁定。

## 业务规则（来源：spec）
- status-entry：当前有活动 Shell 时在原状态栏显示汇总，统计本窗口主会话与本工作区守护进程内全部等待结果及后台运行任务，按主 agent 与角色汇总；一个命令及其后代只计一个 Shell，工作区外和已确认结束的任务不计入；格式为"shell：总数 · 主 agent：数量 · 角色：数量"，同角色子运行合计。
- status-entry：状态读取失败或停止无法确认时显示具体读取错误或单独的不确定数量，不显示为零活动或已清理；数量不受滚动、分组或重复刷新影响。汇总是宿主状态栏的纯文本，不可聚焦、不拦截任何按键。
- process-list：`/ps` 打开管理页，临时替换输入栏，保持原状态栏与 Agents 的相对顺序；关闭后恢复输入栏焦点。
- process-list：一行一个任务，显示编号、具体宿主（本窗口主会话，或守护进程内需求代理、角色及其运行身份）、状态、耗时、命令；选中行蓝色无箭头；↑↓ 选择、Enter 详情、K 停止、Esc 关闭；按键不同时操作 Agents。
- process-list：详情只展示任务身份、宿主、状态、完整命令、目录、进程号和耗时，仅提示 Esc 返回；不提供查看输出或停止按钮。
- process-list：K 请求确认，确认页显示编号、宿主、命令，默认取消；确认只停止该 Shell 及后代；先显示正在停止，清理确认后才报告停止；目标身份固定，不转移到同一行的新任务；无法核对或清理失败时保留任务并显示原因；不确定任务可由用户显式裁定为已停止，裁定先写决策记录再登记。
- process-list：列表限高滚动；空列表明示无活动 Shell；读取失败显示错误，目标结束显示真实结束状态。

## 涉及文件
- 新建 `runtime/shell-summary.ts`
- 新建 `runtime/shell-page.ts`
- 新建 `extensions/shell-ui.ts`
- 新建 `tests/shell-summary.test.ts`
- 新建 `tests/shell-page.test.ts`

## 函数清单
### runtime/shell-summary.ts
| 函数名 | 职责 |
|---|---|
| `summarizeShells` | 合并本窗口注册表与各守护进程 `shells.list` 结果，只计本工作区且未结束的任务，按宿主类型与角色计数；不确定任务单列、不计入总数与角色数；读取失败按仓库记录 |
| `formatShellSummary` | 生成"shell：N · 主 agent：N · worker：N · 不确定：N"文本（N 为真实运行数，不确定另列），读取失败时改为错误文本；文本经净化（剥控制序列/换行，与中继同源的码点上限）；宽度截断交由宿主状态栏自行处理，本函数不算宽度；无活动、无不确定且无错误时返回空 |
| `publishShellStatus` | 用宿主状态栏接口写入或清空汇总文本；只写文本，不注册组件、不监听按键；读取失败文本带仓库归属 |
| `startShellStatusRefresh` | 按注入的睡眠感知时钟周期重算并 `publishShellStatus`（本窗口注册表与各守护进程 `shells.list` 每次重取，无事件订阅）；上一轮未完成则跳过本轮，单次守护进程调用带超时、超时按该仓库读取失败呈现；返回停止函数 |
### runtime/shell-page.ts
| 函数名 | 职责 |
|---|---|
| `ShellPage` | 三态组件（列表 / 详情 / 停止确认），维护选中任务身份与视口 |
| `ShellPage.load` | 合并本窗口注册表与各守护进程列表，只列本工作区任务，已结束任务仅保留结束后 20 秒内的（显示真实结束状态）；记录读取失败（带仓库归属，含载荷字段异常）；整个刷新周期不抛出，异常落入错误行；刷新按任务身份合并在途停止/裁定状态，不整表覆盖，并回收已离开列表的在途/结束记录；有读取错误时空列表只显示错误，不显示"无活动 Shell" |
| `ShellPage.handleInput` | 列表：↑↓ Enter K Esc；详情：Esc；确认：←→ 切换取消/停止、Enter 执行、Esc 取消；对 uncertain 任务确认页多一项"视为已停止" |
| `ShellPage.requestStop` | 按固定任务身份发起停止：本窗口走注册表，守护进程走 `shells.stop`；先置正在停止，按回执更新；回执 ok:false、调用抛错或守护进程不可达都把原因写到该行并保持不确定态，不回落为运行中、不产生未处理拒绝；在途去重 |
| `ShellPage.markStoppedByUser` | 对 uncertain 任务：先经决策记录写用户决定（守护进程宿主的任务记到其需求身份下，主会话任务记到固定的主会话桶），成功后调用注册表 / `shells.markStopped` 登记；决策写入失败则不登记并显示原因；登记失败同样显示原因；在途去重，处理中显示提示 |
| `ShellPage.renderList` / `renderDetail` / `renderConfirm` | 各态渲染：列表行含编号、宿主、状态、耗时、命令；详情与确认页按进入时固定的任务身份查找，找不到即显示目标已结束/无法核对而不冒充他任务；外来文本（命令、目录、原因、角色名、错误消息）渲染前统一净化并按宽度截断；限高按宿主终端行数（经 `resize`），原因行与错误行计入预算 |
| `openShellPage` | 用 `ctx.ui.custom` 替换输入栏打开，主题取自宿主 `ctx.ui.theme`（选中行与确认页默认项按主题着色），工厂接住宿主 `tui`（按终端尺寸 resize、状态变化经 `tui.requestRender()`、按注入时钟每秒刷新）；使用与 Agents 面板同一个 `BottomDock` 实例（经 `extensions/lifecycle.ts` 登记/取用）调用 `markPageOpen`，关闭时 `markPageClosed`、停止刷新并恢复输入栏焦点 |
| `hostLabel` | 生成宿主标签：`主 agent`、`需求代理 <需求标题>`、`worker#<运行身份短码>` |
### extensions/shell-ui.ts
| 函数名 | 职责 |
|---|---|
| `shellUiExtension` | 默认导出：在扩展初始化时（不在 session_start 内）注册一次主会话 bash 覆盖与 `user_bash` 接管，二者经可变引用指向当前会话的 ShellRegistry，与是否有 UI 无关；session_start 起状态栏刷新（仅有 UI 时），session_shutdown/切换时停刷新、清状态栏、`clock.stopGapWatcher()`、收敛上一会话注册表（closeOwner）；主会话 edit/write/bash 的写入守卫接线待 write-guard 提供不绑定运行记录的主会话令牌后再接（见 PROGRESS 待解决）；提供 `openShellPage` 给命令模块 |

## 协作关系
- 依赖 `runtime/shell-registry.ts`、`runtime/shell-bash.ts`（主会话 bash 覆盖）、`runtime/daemon-client.ts`（`shells.list`、`shells.stop`、`shells.markStopped`、`shells.changed` 事件）、`runtime/dock.ts`（页面占用标志）、`runtime/decisions.ts`（用户裁定）、`runtime/write-guard.ts`（主会话写入钩子）。
- 宿主状态栏接口为 `ctx.ui.setStatus`（或宿主提供的等价状态栏文本槽位），汇总不进入 `BottomDock` 的焦点序列。
- 底部 dock 唯一实例：`extensions/lifecycle.ts` 提供 `registerDock(dock)` / `currentDock()`，`extensions/agents-ui.ts` 挂载后登记、teardown 时注销，本单元取用（33/30 交界的小改动，在本单元完成）。
- `user_bash` 在窗口未就绪或已关停时返回宿主认可的结果形状（`{ result: { output: 原因, exitCode: 1, cancelled: false, truncated: false } }`），宿主据此不执行命令并记入会话；不抛错也不返回其它真值——前者回落未托管执行，后者短路其他扩展且照常执行。
- 确认页 Esc 只取消确认回到列表（与详情页 Esc 同构），列表 Esc 才关闭页面。
- 外来文本净化复用中继收件箱的净化逻辑：从 `extensions/relay.ts` 抽到 `runtime/text-sanitize.ts`（OSC→CSI→Fe→C0/C1→BiDi/零宽），relay.ts 改为导入（29 交界的小改动，在本单元完成）。
- 死参数不保留：接口只声明有读取点的字段（去掉未使用的 mainHost、fg、repoId 等）。
- `extensions/commands.ts` 的 `/ps` 调用 `openShellPage`；管理页是进入 Shell 列表的唯一入口。

## 验证方式
- 测试入口：`summarizeShells`、`formatShellSummary`、`publishShellStatus`（假状态栏接口）；`ShellPage`（虚拟终端渲染，注入本窗口注册表夹具与假守护进程客户端）、`openShellPage`（假 `ctx.ui.custom` 与假 `BottomDock`）
- 测试输入：本窗口一个后台 Shell（含多个后代）；两个守护进程各返回 worker 任务一个、其中一个标不确定；一个已结束任务；一个仓库读取失败；工作区外仓库任务；两个 worker 任务（不同运行身份）与一个需求代理任务；停止确认打开后让目标自然结束并刷新；假客户端返回清理不确定；对不确定任务选择"视为已停止"（决策写入成功与失败各一次）；空列表；读取失败；30 行任务与 24 行终端；状态栏文本存在时向终端输入 ↓ 与 Enter
- 预期结果：
  - 汇总文本为"shell：2 · 主 agent：1 · worker：1 · 不确定：1"（不确定不计入总数与角色数），已结束与工作区外不计；读取失败时显示具体错误而非零；重复刷新与分组不改变总数；无活动且无错误时状态栏被清空；状态栏接口只收到文本，↓ 与 Enter 未被任何 Shell 组件消费。
  - 每任务恰一行，两个 worker 标签含不同运行身份短码；选中行蓝色无箭头。
  - Enter 详情只含身份、宿主、状态、命令、目录、进程号、耗时与"Esc 返回"，无输出或停止按钮。
  - K 打开确认页默认取消；取消后进程仍在；确认后先显示正在停止，本窗口目标及后代实际停止后显示已停止，其他任务不受影响。
  - 目标自然结束后确认显示已结束而非停止新占位任务；不确定回执保留任务并显示原因；"视为已停止"在决策写入成功时任务变为已停止且决策记录含任务身份，写入失败时任务保持不确定并显示原因。
  - 空列表显示无活动 Shell；读取失败显示错误；30 行任务时限高且末项可达；打开时 `markPageOpen` 被调用，关闭后 done 与 `markPageClosed` 被调用且焦点回输入栏。
- [ ] 计数口径与状态栏纯文本
- [ ] 不确定与读取失败
- [ ] 行归属与选中样式
- [ ] 详情只读
- [ ] 停止确认、精确范围与用户裁定
- [ ] 刷新与不确定不误报
- [ ] 空态、错误、限高、焦点恢复
