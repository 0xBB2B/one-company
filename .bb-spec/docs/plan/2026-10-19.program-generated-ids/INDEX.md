# 2026-10-19.program-generated-ids 实施计划

## 阶段 1：各模块独立改动（可并行，文件互不重叠）
- [01-requirement-resume](01-requirement-resume.md) — 需求保存的续做报错带原编号，新增按编号查可续做的保存
- [03-workflow-close](03-workflow-close.md) — 关闭需求的编号由程序生成，在办时给出原编号
- [04-project-manage](04-project-manage.md) — 工作区、备份、恢复的编号由程序生成，中断时给出原编号
- [05-change-apply](05-change-apply.md) — worker 写入的编号由程序生成，续写时照抄结果编号

## 阶段 2：主代理交互工具
- [02-interaction-tools](02-interaction-tools.md) — 需求管理与提问工具由程序生成编号，删除按编号缓存结果的逻辑 [依赖: 01-requirement-resume]
