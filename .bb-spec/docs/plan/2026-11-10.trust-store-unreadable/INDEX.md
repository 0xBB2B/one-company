# trust-store-unreadable 实施计划
## 阶段 1：读授信记录
- [trust-read-fail-closed](01-trust-read-fail-closed.md) — 读授信记录挪到 core/host，读不了时各处按不信任照常运行，Git 交付停下
## 阶段 2：启动授信
- [startup-trust-gate](02-startup-trust-gate.md) — 会话开始按授信记录启用或停用 OneCompany [依赖: trust-read-fail-closed]
## 阶段 3：清理
- [remove-partial-trust](03-remove-partial-trust.md) — 删掉设置页和 /one:examples 的授信分支 [依赖: startup-trust-gate]
