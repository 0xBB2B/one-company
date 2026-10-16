# 代码按功能模块拆进 src/ 实施计划
## 阶段 1：搬家
- [move-into-src](01-move-into-src.md) — 按对照表把 155 个源文件搬进 src/，改写路径，包照常运行
## 阶段 2：规则
- [dependency-rule](02-dependency-rule.md) — 架构测试守住单向依赖，挪走剩下两处逆向引用 [依赖: move-into-src]
