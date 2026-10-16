# rename-prod-to-prd 实施计划
## 阶段 1：改名
- [01-rename-to-prd](01-rename-to-prd.md) — 代码、测试、提示词、文档、素材里的 prod 全部换成 prd / PRD
## 阶段 2：旧库报错
- [02-reject-old-database](02-reject-old-database.md) — data.db 升到 3、index.db 升到 2，旧库报 outdated_database [依赖: 01-rename-to-prd]
