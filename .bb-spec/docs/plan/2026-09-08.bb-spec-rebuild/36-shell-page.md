---
name: shell-page
description: /ps 管理页：输入栏位置的单行列表、只读详情与 K 停止确认，宿主标签含运行身份，跨宿主停止经守护进程回执
---
# Shell 管理页

## 目标
用户在输入栏位置查看本窗口与工作区内守护进程的每一条 Shell，看清归属，并能精确停止选定任务。

## 业务规则（来源：spec）
- process-list：`/ps` 与汇总行回车打开同一管理页，临时替换输入栏，保持原状态栏、汇总行与 Agents 的相对顺序；关闭后恢复输入栏，从汇总行进入时恢复该入口焦点。
- process-list：一行一个任务，显示编号、具体宿主（本窗口主会话，或守护进程内需求代理、角色及其运行身份）、状态、耗时、命令；选中行蓝色无箭头；↑↓ 选择、Enter 详情、K 停止、Esc 关闭；按键不同时操作 Agents。
- process-list：详情只展示任务身份、宿主、状态、完整命令、目录、进程号和耗时，仅提示 Esc 返回；不提供查看输出或停止按钮。
- process-control：K 请求确认，确认页显示编号、宿主、命令，默认取消；确认只停止该 Shell 及后代；先显示正在停止，清理确认后才报告停止；目标身份固定，不转移到同一行的新任务；无法核对或清理失败时保留任务并显示原因。
- process-list：列表限高滚动；空列表明示无活动 Shell；读取失败显示错误，目标结束显示真实结束状态。

## 涉及文件
- 新建 `runtime/shell-page.ts`
- 新建 `extensions/shell-ui.ts`
- 新建 `tests/shell-page.test.ts`

## 函数清单
### runtime/shell-page.ts
| 函数名 | 职责 |
|---|---|
| `ShellPage` | 三态组件（列表 / 详情 / 停止确认），维护选中任务身份与视口 |
| `ShellPage.load` | 合并本窗口注册表与各守护进程列表，记录读取失败 |
| `ShellPage.handleInput` | 列表：↑↓ Enter K Esc；详情：Esc；确认：←→ 切换取消/停止、Enter 执行、Esc 取消 |
| `ShellPage.requestStop` | 按固定任务身份发起停止：本窗口走注册表，守护进程走 `shells.stop`；先置正在停止，按回执更新 |
| `ShellPage.renderList` / `renderDetail` / `renderConfirm` | 各态渲染，限高与行宽约束 |
| `openShellPage` | 用 `ctx.ui.custom` 替换输入栏打开，记录来源（命令或汇总行），关闭时恢复对应焦点 |
| `hostLabel` | 生成宿主标签：`主 agent`、`需求代理 <需求标题>`、`worker#<运行身份短码>` |
### extensions/shell-ui.ts
| 函数名 | 职责 |
|---|---|
| `shellUiExtension` | 默认导出：注册主会话 bash 覆盖与 `user_bash` 接管，挂载汇总行，提供 `openShellPage` 给命令模块 |

## 协作关系
- 依赖 `runtime/shell-registry.ts`、`runtime/shell-bash.ts`（主会话 bash 覆盖）、`runtime/daemon-client.ts`（`shells.list`、`shells.stop`）、`runtime/shell-summary.ts`、`runtime/dock.ts`。
- `extensions/commands.ts` 的 `/ps` 调用 `openShellPage`。

## 验证方式
- 测试入口：`ShellPage`（虚拟终端渲染，注入本窗口注册表夹具与假守护进程客户端）、`openShellPage`（假 `ctx.ui.custom`）。
- 测试输入：本窗口一个真实后台 Shell（含后代）、两个 worker 任务（不同运行身份）、一个需求代理任务；停止确认打开后让目标自然结束并刷新；假客户端返回清理不确定；空列表；读取失败；30 行任务与 24 行终端。
- 预期结果：
  - 每任务恰一行，两个 worker 标签含不同运行身份短码；选中行蓝色无箭头。
  - Enter 详情只含身份、宿主、状态、命令、目录、进程号、耗时与"Esc 返回"，无输出或停止按钮。
  - K 打开确认页默认取消；取消后进程仍在；确认后先显示正在停止，本窗口目标及后代实际停止后显示已停止，其他任务不受影响。
  - 目标自然结束后确认显示已结束而非停止新占位任务；不确定回执保留任务并显示原因。
  - 空列表显示无活动 Shell；读取失败显示错误；30 行任务时限高且末项可达；关闭后 done 被调用并按来源恢复焦点。
- [ ] 行归属与选中样式
- [ ] 详情只读
- [ ] 停止确认与精确范围
- [ ] 刷新与不确定不误报
- [ ] 空态、错误、限高、焦点恢复
