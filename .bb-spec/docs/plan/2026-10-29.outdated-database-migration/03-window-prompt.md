---
name: window-prompt
description: 窗口在拉起新守护进程前检查本机库版本，能迁移就弹迁移框，按用户选择迁移或停下，并给模型写清报错
---
# 窗口迁移框

## 目标
pi 窗口要为某个仓库拉起新守护进程之前，先检查这个仓库的本机库；有可迁移的旧版本时弹迁移框，用户选「迁移」就迁移后照常拉起，选「暂不迁移」或迁移失败就不拉起，这个窗口里调这个仓库的工具时给模型写清原因和下一步。

## 业务规则（来源：PRD migration-prompt）
- 检查时机：只在"要拉起新守护进程"时检查，即连不上套接字、准备 spawn 之前。旧守护进程还在忙时，现有逻辑先等它让位，退出后才走到 spawn，所以等待期间不会弹框。
- 不弹框、直接照常拉起的情况：两个库都是当前版本或不存在；`data.db` 太旧（1–7）；没有 pi 界面（`ctx.hasUI === false`，如 `pi -p`）。这几种情况由守护进程打开库时按 plan 04 的文字报错。
- 同一仓库同一时间只有一个窗口在弹框或迁移：先加维护标记再弹框，弹框和迁移期间一直持有。拿不到（`migration_busy`）就每 1 秒重试一次，拿到后重新读版本：已是当前版本就直接拉起、不弹框；仍旧就弹自己的框。
- 多仓库工作区：每个仓库各弹一次；程序窗口已有的先进先出队列保证一次只显示一个。一个仓库停下不影响其他仓库。
- 迁移框（警告样式程序窗口，黄色边框和标题）：
  - 标题：`仓库 <仓库显示名> 的本机数据库是旧版本，要迁移吗？`（仓库显示名用 `repoDisplayName(commonDir)`，和状态面板一致）
  - 内容按顺序：`data.db` 可迁移时 `data.db（需求、运行记录）：版本 8 → 9`，接着每条迁移步骤的 `losses` 各一行（前面两个空格），再一行 `  迁移前先把 data.db 备份到本机数据目录的 backups/ 下`；`index.db` 可迁移时 `index.db（项目索引）：版本 1 → 2，删掉旧索引后重新建`；最后一行 `不迁移，这个窗口里的需求和后台代理功能用不了`。版本号按实际值填。
  - 选项只有「迁移」「暂不迁移」，默认选中「迁移」；底部提示 `↑↓ 选择 · 回车确认 · Esc 暂不迁移`；Esc 等同「暂不迁移」。
- 窗口底部通知（`ctx.ui.notify`）：
  - 开始迁移（info）：迁 `data.db` 时 `正在迁移仓库 <名> 的本机数据库，先备份 data.db…`；只迁 `index.db` 时 `正在迁移仓库 <名> 的本机数据库…`。
  - 成功（info）：`仓库 <名> 的本机数据库已迁移到当前版本。`，迁过 `data.db` 时接 `旧 data.db 备份在 <完整路径>。`，删过 `index.db` 时接 `索引会在后台重新建。`。随后照常拉起守护进程。
  - 失败（error）：`仓库 <名> 的本机数据库迁移失败：<失败步骤> 时，<原因>。数据库没有改动，还是版本 <旧版本>`，已备份时接 `；迁移前的备份在 <完整路径>`，最后 `。这个窗口里的需求和后台代理功能用不了，重开 pi 窗口可以再试一次。`
  - 暂不迁移（warning）：`仓库 <名> 的本机数据库是旧版本，这次没有迁移，这个窗口里的需求和后台代理功能用不了。重开 pi 窗口可以再次选择迁移。`
- 停下后（暂不迁移或失败）这个仓库的客户端不再自动重连、不拉起守护进程；调用时给模型的报错（AdvisedError，只写原因、不给错误码以外的东西）：
  - 暂不迁移：code `database_migration_declined`，why `守护进程不可达：仓库 <名> 的本机数据库是旧版本，用户这次选了暂不迁移`，next `请用户重开 pi 窗口，在提示框里选「迁移」`。
  - 失败：code `database_migration_failed`，why `守护进程不可达：仓库 <名> 的本机数据库迁移失败：<原因>`，next `请用户重开 pi 窗口再试一次迁移；仍然失败就把原因告诉用户`。
- 重开 pi 窗口时库仍旧，就再次弹框。
- `data.db` 的转换步骤由 `src/app/extension` 注入（requirement 模块的 `prototypeRecordsV8Step`），`src/core` 不引用 `src/modules`。

## 涉及文件
- 新建 `src/core/host/database-migration-prompt.ts`
- 修改 `src/core/host/question-window.ts`（`chooseWindow` 支持自定义底部 Esc 提示）
- 修改 `src/core/host/daemon-client.ts`（spawn 前调用注入的检查；停下状态的报错）
- 修改 `src/core/host/extension-lifecycle.ts`（把窗口界面和迁移步骤接到检查上）
- 修改 `src/app/extension/index.ts`（注入 `prototypeRecordsV8Step`）
- 新建 `tests/database-migration-prompt.test.ts`；修改 `tests/daemon-client.test.ts` 或新建 `tests/daemon-client-migration.test.ts`

## 成品定义
迁移检查和客户端之间的契约（放在 `src/core/host/database-migration-prompt.ts`，exec 原样落盘）：

```ts
/** spawn 前检查的结果：proceed 为 false 时客户端停下，不拉起守护进程。 */
export type BeforeSpawnResult =
  | { proceed: true }
  | { proceed: false; code: "database_migration_declined" | "database_migration_failed"; why: string; next: string };

export type BeforeSpawn = (repo: { repoId: string; commonDir: string }) => Promise<BeforeSpawnResult>;
```

## 函数清单
### src/core/host/database-migration-prompt.ts
| 函数名 | 职责 |
|---|---|
| `migrationWindowContent` | 由仓库显示名、`MigrationPlan`、步骤的 `losses` 拼出迁移框的标题和各行（纯函数） |
| `migrationNoticeText` | 拼开始、成功、失败、暂不迁移四种通知文字（纯函数） |
| `createBeforeSpawn` | 用窗口界面（`hasUI`、`ui.custom`、`ui.notify`）、数据根目录、迁移步骤造出一个 `BeforeSpawn`：读版本 → 判断要不要弹 → 加锁（忙就每秒重试）→ 锁内重读 → 弹框 → 迁移或停下 → 发通知 → 返回结果 |

### src/core/host/question-window.ts
| 函数名 | 职责 |
|---|---|
| `chooseWindow` | 增加可选的 `escapeHint`，传给窗口底部提示 |

### src/core/host/daemon-client.ts
| 函数名 | 职责 |
|---|---|
| `ConnectDaemonOptions` / `WorkspaceClientsOptions` / `resolveContext` | 增加可选 `beforeSpawn` 并放进上下文 |
| `attemptConnect` | 连不上要 spawn 前先调 `beforeSpawn`；不 proceed 时抛带 code 的停下错误 |
| `isTerminalHandshakeFailure` | 把两种迁移停下 code 算作终止，不再重连 |
| `call` | 客户端因迁移停下时抛 `AdvisedError(code, { why, next })` |

### src/core/host/extension-lifecycle.ts
| 函数名 | 职责 |
|---|---|
| `LifecycleDeps` | 增加 `databaseMigrationSteps` |
| `startWindow` / `defaultConnectWorkspaceClients` | 把 session_start 的 `ctx`（`hasUI`、`ui`）和迁移步骤交给 `createBeforeSpawn`，结果作为 `beforeSpawn` 传给 `WorkspaceClients.create` |

### src/app/extension/index.ts
| 函数名 | 职责 |
|---|---|
| 默认导出的扩展入口 | `lifecycleExtension(pi, { databaseMigrationSteps: [prototypeRecordsV8Step] })` |

## 协作关系
- `createBeforeSpawn` 调 plan 01 的 `readMigrationPlan`、`needsMigrationPrompt`、`withMigrationLock`、`migrateRepositoryDatabases`，弹框用 `chooseWindow`（`openProgramWindow` 队列）。
- `attemptConnect` 在 `beginSpawnDaemon` 之前调用 `beforeSpawn`（`launchDaemon` 里的 `repoDataDir` 会打开 `data.db`，必须在它之前）。
- pi 交互模式先启动界面再触发 session_start，所以 session_start 里等待用户选择不会卡住界面。

## 验证方式
- 测试入口：`migrationWindowContent`、`migrationNoticeText`、`createBeforeSpawn`（假 `ui.custom` 按脚本选中某项或返回 undefined 表示 Esc，假 `notify` 记录调用）；`connectDaemon` / `WorkspaceClients.create` 传入 `beforeSpawn` 并用样例项目的套接字目录。
- 测试输入：临时数据根下手工建的 data.db 8 + index.db 1、仅 index.db 1、data.db 5、都是当前版本；`hasUI: false`；预先占用维护标记后再释放；一个必定抛错的转换步骤。
- 预期结果：
- [ ] data 8 + index 1：框标题、五行内容与规则逐字一致；选项「迁移」「暂不迁移」，默认第一项；底部提示含 `Esc 暂不迁移`
- [ ] 仅 index 1：框里只有 index 行和"不迁移"行，没有备份行
- [ ] 都是当前版本 / data 5 / `hasUI: false`：没有调用 `ui.custom`，结果 proceed
- [ ] 选「迁移」成功：通知依次为开始、成功（含备份完整路径、"索引会在后台重新建"），结果 proceed，库已是当前版本
- [ ] 选「暂不迁移」和 Esc：库不变，warning 通知文字一致，结果是 declined 及规则里的 why / next
- [ ] 迁移失败：error 通知含失败步骤、原因、"数据库没有改动，还是版本 8"、备份路径，结果是 failed；库不变
- [ ] 维护标记被占时不弹框，释放后若库已是当前版本则直接 proceed、仍旧则弹框
- [ ] 客户端拿到 declined：不 spawn 守护进程、不再重连；`call` 抛 `database_migration_declined`，advice 的 why / next 与规则一致
- [ ] 两个仓库同时需要弹框：`ui.custom` 一次只被打开一个，答完第一个才打开第二个；一个 declined 另一个 proceed 互不影响
