# 2026-10-19.program-generated-ids 实施计划

## 阶段 1：各模块独立改动（可并行，文件互不重叠）
- [01-requirement-resume](01-requirement-resume.md) — 需求保存的续做报错带原编号，新增按编号查可续做的保存
- [03-workflow-close](03-workflow-close.md) — 关闭需求的编号由程序生成，在办时给出原编号
- [04-project-manage](04-project-manage.md) — 工作区、备份、恢复的编号由程序生成，中断时给出原编号
- [05-change-apply](05-change-apply.md) — worker 写入的编号由程序生成，续写时照抄结果编号

## 阶段 2：主代理交互工具
- [02-interaction-tools](02-interaction-tools.md) — 需求管理与提问工具由程序生成编号，删除按编号缓存结果的逻辑 [依赖: 01-requirement-resume]

## 阶段 3：批准一次写完（执行时新增，用户 2026-10-19 决定）
- [06-approval-atomic](06-approval-atomic.md) — 批准先做只读检查再在一个事务里写完，不建操作记录、不接受 operationId，data.db 升到 4 [依赖: 02-interaction-tools]

## 阶段 4：续做由程序按内容认出（真实模型验收后改，用户 2026-10-19 决定）
- [07-requirement-auto-resume](07-requirement-auto-resume.md) — 需求保存去掉 operationId，按内容认出没做完的保存 [依赖: 06-approval-atomic]
- [09-change-apply-auto-resume](09-change-apply-auto-resume.md) — worker 写入去掉 operationId，按同一批文件续写
- [08-close-workspace-backup](08-close-workspace-backup.md) — 关闭、工作区准备自动续办，备份恢复从头来 [依赖: 07-requirement-auto-resume]
