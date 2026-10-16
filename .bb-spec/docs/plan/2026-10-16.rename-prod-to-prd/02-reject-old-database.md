---
name: 02-reject-old-database
description: data.db 升到版本 3、index.db 升到版本 2，改名前的旧库打开时报 outdated_database 并写明处理办法
---
# 旧版本本机数据库直接报错

## 目标
改名前留下的 `data.db`、`index.db` 一打开就报出明确原因和处理办法，文件本身不动；新建的库用新版本号。

## 业务规则（来源：PRD 02-reject-old-database）
- 01 号 plan 把存进数据库的事件名、格式标记、项目索引的命名空间从 `prod` 换成了 `prd`，改名前的旧库读出来会在任意位置报格式错误。用户 2026-10-16 决定：不写迁移，沿用移除 spec 时的做法，升数据库版本号让旧库直接报错。
- 新建的 `data.db` 版本号是 3，新建的 `index.db` 版本号是 2；全局库 `global.db` 版本号仍是 1。
- 打开版本号是 1 或 2 的 `data.db`、版本号是 1 的 `index.db`：报 `outdated_database`，说明里写明是哪个文件，并写"请备份后删除本机数据目录并重新初始化"。例如 `data.db 来自旧版本，和当前版本不兼容；请备份后删除本机数据目录并重新初始化`。
- 报错时不改动这个数据库文件：文件内容前后一致，不生成 `-wal` 文件。
- 其他情况的打开结果和现在一样：版本号对上的正常打开；版本号是 0 但已有表的报 `wrong_database_kind`；比当前版本号还大的报"不支持的数据库版本"。

## 涉及文件
- 修改：`src/core/storage/database-paths.ts`（`DATABASE_SCHEMA_VERSIONS` 改为 `{ data: 3, global: 1, index: 2 }`）
- 修改：`src/core/storage/database.ts`（`assertSupportedVersion`）
- 修改：`src/modules/project-index/index-store.ts`（只读查询处写死的 `user_version !== 1` 改为比对 `DATABASE_SCHEMA_VERSIONS.index`）
- 修改：`tests/database-storage.test.ts`

## 函数清单
### src/core/storage/database.ts
| 函数名 | 职责 |
|---|---|
| `assertSupportedVersion` | 版本号是 0 或等于当前版本时放行；`data` 的 1、2 和 `index` 的 1 报 `outdated_database`，说明写"<文件名> 来自旧版本，和当前版本不兼容；请备份后删除本机数据目录并重新初始化"；其余报"不支持的数据库版本"。原来只针对 data 版本 1、写着"移除 spec 之前"的那条分支由这条规则取代 |

### src/modules/project-index/index-store.ts
| 函数名 | 职责 |
|---|---|
| 只读打开当前索引的那段校验（约 681 行，`invalid_index_state` 判断） | `user_version` 改为和 `DATABASE_SCHEMA_VERSIONS.index` 比对；`index_schema_metadata` 里的 `schema_version` 保持 1 不动 |

## 协作关系
`LocalDatabase` 构造时调用 `assertSupportedVersion`，打开前不切 WAL、不写文件，所以报错时文件保持原样。`src/modules/agents/run-metadata.ts`、`src/modules/requirement/requirement-backup.ts`、`src/modules/requirement/host-authorization.ts` 已经和 `DATABASE_SCHEMA_VERSIONS.data` 比对，跟着常量自动变，不用改。

## 验证方式
- 测试入口：`pnpm test`（`tests/database-storage.test.ts` 等数据库存储测试），用 `new LocalDatabase(<路径>)` 打开、用 `node:sqlite` 的 `DatabaseSync` 预先造库。
- 测试输入：
  - 在 `/tmp/pi-t-XXXXXX` 单层临时目录里，用 `DatabaseSync` 造 `data.db`：`PRAGMA application_id=<DATABASE_APPLICATION_IDS.data>; PRAGMA user_version=<版本号>; CREATE TABLE sentinel(value TEXT);`，版本号分别取 1、2、99；再造版本号 0 但已有表的库。
  - 同样造 `index.db`：`application_id` 用 `DATABASE_APPLICATION_IDS.index`，版本号取 1、99。
  - 新建空目录，直接 `new LocalDatabase` 建 `data.db`、`index.db`、`global.db`。
- 预期结果：
  - data 1、data 2、index 1：抛出的错误含 `outdated_database`、对应文件名和"请备份后删除本机数据目录并重新初始化"；打开前后文件内容的哈希一致，没有 `-wal` 文件。
  - data 99、index 99：报"不支持的数据库版本"；版本号 0 且已有表：报 `wrong_database_kind`。
  - 新建的库读 `PRAGMA user_version`：data 是 3、index 是 2、global 是 1。
- [ ] 上述用例全部通过
- [ ] 四项纯代码测试全部通过
