# requirement-follows-conversation 实施计划
## 阶段 1：基础
- [01-line-anchor-foundation](01-line-anchor-foundation.md) — 锚点存储与对话线解析
- [02-requirement-file-repo](02-requirement-file-repo.md) — 需求文件仓库可分叉、放草稿全部文件
## 阶段 2：草稿跟线
- [03-line-draft-save-read](03-line-draft-save-read.md) — 草稿按对话线保存和读取 [依赖: 01-line-anchor-foundation, 02-requirement-file-repo]
- [04-line-process-records](04-line-process-records.md) — 短决定、提问、事实、批准清单按对话线算数 [依赖: 03-line-draft-save-read]
## 阶段 3：原型与规范
- [05-line-prototype-board](05-line-prototype-board.md) — 原型看板按对话线叠加，协议升到 9 [依赖: 04-line-process-records]
- [06-conventions-draft](06-conventions-draft.md) — AGENTS.md 写进需求草稿 [依赖: 03-line-draft-save-read]
## 阶段 4：换线提示
- [07-switch-restore-message](07-switch-restore-message.md) — 换线后在对话里插消息、弹等确认的原型 [依赖: 05-line-prototype-board]
## 阶段 5：批准后进需求分支
- [08-approved-files-into-branch](08-approved-files-into-branch.md) — 批准的文件三方合并进需求分支，子代理从分支读规范 [依赖: 05-line-prototype-board, 06-conventions-draft]
## 阶段 6：升级迁移
- [09-upgrade-migration](09-upgrade-migration.md) — data.db 10 → 11，看板转换、原型文件搬进需求仓库 [依赖: 05-line-prototype-board]
