---
name: unmigratable-errors
description: 打开旧库的报错区分"能迁移，去 pi 窗口选迁移"和"太旧了没法迁移，删数据目录"，项目索引的报错同步
---
# 不能迁移时的报错

## 目标
守护进程或任何地方用 `LocalDatabase` 打开旧版本库时，报错写清当前版本、能不能迁移和下一步；项目索引工具给模型的报错同样写清。

## 业务规则（来源：PRD unmigratable-errors）
- 库是可迁移的旧版本（`data.db` 8、`index.db` 1，读 plan 01 的 `MIGRATABLE_VERSIONS`）：`DatabaseStorageError("outdated_database", ...)` 的说明写 `<库名> 是版本 <旧>，当前版本是 <新>；打开 pi 窗口，在提示框里选「迁移」`。完整报错（含已有前缀）就是 `本机数据库访问被阻止：outdated_database，data.db 是版本 8，当前版本是 9；打开 pi 窗口，在提示框里选「迁移」`。
- `data.db` 1–7：说明写 `data.db 是版本 <旧>，太旧了没法迁移；请备份后删除本机数据目录并重新初始化`。
- 这两种情况都不改库。
- 项目索引工具遇到 `index.db` 旧版本时，给模型的 why 写 `项目索引库 index.db 是版本 1，当前版本是 2`（取自底层报错的版本号），next 写 `请用户打开 pi 窗口，在提示框里选「迁移」`。
- 版本号比当前代码还新的库不在本需求内，照旧报"不支持的数据库版本"。

## 涉及文件
- 修改 `src/core/storage/database.ts`（`OUTDATED_VERSIONS`、`assertSupportedVersion`）
- 修改 `src/modules/project-index/project-index-service.ts`（`outdated_database` 的 why / next）
- 修改 `tests/database-storage.test.ts`、`tests/project-index-service.test.ts` 中断言旧文字的用例

## 函数清单
### src/core/storage/database.ts
| 函数名 | 职责 |
|---|---|
| `assertSupportedVersion` | 按 `MIGRATABLE_VERSIONS` 区分可迁移和太旧，写出上面两种说明；`OUTDATED_VERSIONS` 保留"哪些旧版本认得"的作用 |

### src/modules/project-index/project-index-service.ts
| 函数名 | 职责 |
|---|---|
| `serviceError` | 遇到 `outdated_database` 时把底层报错里的版本信息带进 `ProjectIndexServiceError` |
| `ProjectIndexServiceError` / `INDEX_NEXT` | `outdated_database` 的 why 用带版本号的文字，next 改成去 pi 窗口选迁移 |

## 协作关系
- `assertSupportedVersion` 读 `src/core/storage/database-migration.ts` 的 `MIGRATABLE_VERSIONS`（同层引用）。
- 守护进程启动失败时窗口拿到的 `daemon_unreachable` 原因来自这里的报错文字，链路不改。

## 验证方式
- 测试入口：`new LocalDatabase(path)`；`ProjectIndexService` 对旧 `index.db` 的操作（沿用 `tests/project-index-service.test.ts` 的现有做法）。
- 测试输入：`user_version` 分别为 8、5 的 data.db；`user_version` 为 1 的 index.db。
- 预期结果：
- [ ] data.db 8：抛 `DatabaseStorageError`，code `outdated_database`，message 等于 `本机数据库访问被阻止：outdated_database，data.db 是版本 8，当前版本是 9；打开 pi 窗口，在提示框里选「迁移」`；库的 `user_version` 仍是 8
- [ ] data.db 5：message 等于 `本机数据库访问被阻止：outdated_database，data.db 是版本 5，太旧了没法迁移；请备份后删除本机数据目录并重新初始化`
- [ ] index.db 1：`LocalDatabase` 报 `index.db 是版本 1，当前版本是 2；打开 pi 窗口，在提示框里选「迁移」`；项目索引服务的 advice why 含 `index.db 是版本 1，当前版本是 2`，next 是 `请用户打开 pi 窗口，在提示框里选「迁移」`；`index.db` 没被删
