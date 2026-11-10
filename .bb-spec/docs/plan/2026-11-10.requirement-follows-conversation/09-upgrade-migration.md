---
name: 09-upgrade-migration
description: data.db 从版本 10 迁到 11：原型看板转成按锚点记的变动，草稿里已通过的原型文件搬进需求文件仓库，其余记录原样保留
---
# 升级迁移

## 目标
升级后第一次打开 pi，迁移框里选「迁移」，现有草稿的正文、短决定、提问、批准清单、原型都和升级前一样，并按新办法存放。

## 业务规则（来源：PRD 04-upgrade-migration 全部约束；AGENTS.md「写代码」里关于迁移的规矩）
- data.db 版本 10 → 11。旧版本库照现有机制在守护进程启动前弹迁移框，用户不选「迁移」时守护进程不启动。
- 迁移前先备份 data.db（现有 `migrateRepositoryDatabases` 已做），在一次事务里转换，失败时库保持迁移前的样子，迁移框写明哪一步、为什么失败。
- 短决定、提问、连续性事实、批准清单、需求记录、操作记录：内容和版本号都不动（批准依据链比对记录版本号，改了会失效）。它们没有 `line_anchor_members` 记录，按 01 的规则算作所有对话线共同的起点，在每条线上都算数。
- 原型看板：每个需求的 `requirement_prototypes` 记录转成 05 定义的变动记录，转换后在任意对话线上叠加出来的看板和转换前逐项相同；然后删掉旧看板记录。`requirement_prototype_revisions`（批准快照）不动。
- 草稿需求里已通过、未移除的原型（看板 entry.draft），把 HTML 文件从 `repos/<仓库>/prototypes/<需求>/<名>.v<N>.html` 搬进这个需求的文件仓库：在 `main` 上加一个 kind 为 migration 的提交，`main` 前移到它（02 的规则已写明这个例外）。原文件保留。DESIGN.md 已在升级前写进主仓库根目录，不进文件状态。
- 已批准、正在关闭、已关闭的需求，迁移不改它们的任何记录和文件。
- 主仓库根目录的 DESIGN.md、AGENTS.md 迁移不碰。
- 升级前的对话里没有锚点记录，回退到升级前的保存点时线尖就是最近一次保存，不插"已恢复"消息（01、07 的规则自然满足，迁移不用为此做事）。
- 迁移框里"会丢掉的数据"这一项，这一步写"这次迁移不会丢数据。"
- 文件搬运在数据库事务之前做，可重复执行：已经有迁移提交的需求跳过。数据库事务失败时，已搬进文件仓库的提交留着，下次迁移认出后跳过。
- `OUTDATED_VERSIONS` 里补上 9、10，旧版本库打开时报"请迁移"而不是"不支持的版本"。

## 涉及文件
- 修改 `src/core/storage/database-paths.ts`（`DATABASE_SCHEMA_VERSIONS`）
- 修改 `src/core/storage/database.ts`（`OUTDATED_VERSIONS`）
- 修改 `src/core/storage/database-migration.ts`（`MIGRATABLE_VERSIONS`、`MigrationRecords`、`DataMigrationStep`、`migrateRepositoryDatabases`、`runSteps`）
- 新建 `src/modules/requirement/line-migration.ts`
- 修改 `src/modules/requirement/prd-storage.ts`（迁移提交用的入口）
- 修改 `src/app/extension/index.ts`（注入新步骤）
- 新建 `tests/line-migration.test.ts`；修改 `tests/database-migration.test.ts`、`tests/database-migration-prompt.test.ts`

## 成品定义

`src/core/storage/database-paths.ts`：
```ts
export const DATABASE_SCHEMA_VERSIONS = { data: 11, global: 1, index: 2 } as const;
```

`src/core/storage/database-migration.ts` 里的版本表和接口：
```ts
export const MIGRATABLE_VERSIONS: Readonly<Record<"data" | "index", readonly number[]>> = Object.freeze({ data: [8, 9, 10], index: [/* 保持现值 */] });

export interface MigrationRecords {
  list(namespace: string): MigrationRecord[];
  replace(namespace: string, key: string, data: unknown): void;
  /** 新建一条记录，版本号为 1；键已存在时抛错。 */
  create(namespace: string, key: string, data: unknown): void;
  /** 删除一条记录；不存在时抛错。 */
  remove(namespace: string, key: string): void;
}

/** 由上层注入的 data.db 转换步骤：from → from + 1。转换失败时抛 Error，message 写清哪条记录、为什么。 */
export interface DataMigrationStep {
  from: number;
  /** 迁移会丢掉的数据，每项一句话，显示在迁移框里。 */
  losses: string[];
  /** 数据库事务之前执行的文件搬运；必须可重复执行。 */
  prepareFiles?(context: { dataRoot: string; repoId: string; records: Pick<MigrationRecords, "list"> }): Promise<void>;
  migrate(records: MigrationRecords): void;
}
```

`src/modules/requirement/line-migration.ts` 导出的步骤：
```ts
export const lineRecordsV10Step: DataMigrationStep = {
  from: 10,
  losses: ["这次迁移不会丢数据。"],
  prepareFiles: /* moveDraftPrototypesIntoRepos */,
  migrate: /* convertPrototypeBoards */,
};
```

## 函数清单
### src/core/storage/database-migration.ts
| 函数名 | 职责 |
|---|---|
| `runSteps` | 改：给步骤的 records 加上 `create`、`remove` |
| `migrateRepositoryDatabases` | 改：备份之后、事务之前依次调各步骤的 `prepareFiles` |

### src/modules/requirement/line-migration.ts
| 函数名 | 职责 |
|---|---|
| `moveDraftPrototypesIntoRepos` | 对每个草稿需求，把 entry.draft 的原型 HTML 作为一个迁移提交加进文件仓库；已有迁移提交时跳过 |
| `convertPrototypeBoards` | 把每个 `requirement_prototypes` 记录转成等价的变动记录，删掉旧记录；转换失败写清哪个需求、哪份原型、为什么 |
| `lineRecordsV10Step` | 组装上面两步的迁移步骤 |

### src/modules/requirement/prd-storage.ts
| 函数名 | 职责 |
|---|---|
| `commitMigrationFiles` | 新：在 main 上加 kind 为 migration 的提交并前移 main（Operation-Id 用新生成的 UUIDv7）；历史里已有 migration 提交时认出已做过、直接返回 |

### src/app/extension/index.ts
| 函数名 | 职责 |
|---|---|
| `lifecycleExtension` 的 `databaseMigrationSteps` | 改：加上 `lineRecordsV10Step` |

## 协作关系
- 主窗口 `createBeforeSpawn` → 迁移框 → `migrateRepositoryDatabases` → 备份 → `prepareFiles`（`moveDraftPrototypesIntoRepos` → `commitMigrationFiles`）→ 事务内 `migrate`（`convertPrototypeBoards`）→ 版本号设为 11。
- 依赖 01、02、05（变动记录格式）。

## 验证方式
- 测试入口：`migrateRepositoryDatabases`（真实临时 data.db 和需求仓库）；`lineRecordsV10Step`；迁移框内容 `migrationWindowContent`。
- 测试输入：版本 10 的库里有一个草稿需求（版本 7、4 条短决定、1 个未答提问、1 份已通过原型）和一个已批准需求。
- 预期结果与验证项：
  - [ ] 迁移后版本号 11；草稿需求在新开对话里读取，正文、版本号、4 条决定、1 个提问、1 份原型都和迁移前一样。
  - [ ] 短决定、提问、事实、清单记录的 data 和 version 列迁移前后逐字节相同。
  - [ ] 草稿需求的文件仓库 main 多了一个迁移提交，里面有那份原型 HTML。
  - [ ] 已批准需求的所有记录、文件迁移前后相同。
  - [ ] 主仓库根目录 DESIGN.md、AGENTS.md 字节不变。
  - [ ] 让 `convertPrototypeBoards` 中途抛错：库和迁移前字节相同，错误写明需求和原型；再迁移一次成功，迁移提交没有重复。
  - [ ] 迁移框里列出"这次迁移不会丢数据。"
  - [ ] 打开版本 9、10 的库时提示需要迁移。
