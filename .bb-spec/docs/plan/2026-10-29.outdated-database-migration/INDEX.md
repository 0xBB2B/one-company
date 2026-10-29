# 2026-10-29.outdated-database-migration 实施计划
## 阶段 1：存储层
- [migration-runner](01-migration-runner.md) — 读库版本、加维护标记、备份 data.db、事务内跑转换步骤、删旧 index.db
- [prototype-v8-step](02-prototype-v8-step.md) — 原型记录 8 → 9 的转换步骤 [依赖: migration-runner]
- [unmigratable-errors](04-unmigratable-errors.md) — 旧库报错区分能迁移和太旧 [依赖: migration-runner]
## 阶段 2：窗口
- [window-prompt](03-window-prompt.md) — spawn 前弹迁移框、按选择迁移或停下 [依赖: migration-runner, prototype-v8-step]
