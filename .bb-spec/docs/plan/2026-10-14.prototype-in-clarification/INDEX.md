# prototype-in-clarification 实施计划
## 阶段 1：新职责与看板
- [prototype-role](01-prototype-role.md) — 新增 prototype 职责、内置定义、职责规矩、权限与 /one:agents 栏
- [prototype-board](02-prototype-board.md) — 每个需求一份原型看板，交稿校验、决定与移除 [依赖: prototype-role]
## 阶段 2：去掉旧流程
- [remove-pm-flow](03-remove-pm-flow.md) — 删掉 PM 原型流程，README 写升级须知 [依赖: prototype-board]
## 阶段 3：主窗口出原型
- [designer-dispatch](04-designer-dispatch.md) — 守护进程派出设计师、事件、面板列表 [依赖: remove-pm-flow]
- [main-window-prototype](05-main-window-prototype.md) — 主窗口工具、确认与移除窗口、面板显示、主代理提示词 [依赖: designer-dispatch]
## 阶段 4：批准与下游
- [approval-integration](06-approval-integration.md) — 在途拦截、批准窗口原型清单、版本快照、PM 通知 [依赖: main-window-prototype]
- [downstream-context](07-downstream-context.md) — worker、reviewer、qa 拿原型，四份职责规矩 [依赖: approval-integration]
## 阶段 5：备份、归档与验收
- [backup](08-backup.md) — 备份与恢复带上原型 [依赖: approval-integration]
- [archive](09-archive.md) — 完成归档写原型 html 并随交付提交 [依赖: approval-integration]
- [acceptance-scripts](10-acceptance-scripts.md) — P10、P4 与自动点窗口改写，全量真实模型验收 [依赖: downstream-context, backup, archive]
