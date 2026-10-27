# prototype-accept-with-note 实施计划
## 阶段 1：底层（可并行）
- [window-writable-choice](01-window-writable-choice.md) — 程序窗口支持可输入的选项和 Esc 指定答案
- [note-storage](02-note-storage.md) — 补充说明存进草稿和批准快照，数据库版本号升到 8
## 阶段 2：功能（可并行）
- [confirm-flow](03-confirm-flow.md) — 确认原型窗口新选项、Esc 放弃、下一轮告诉主代理 [依赖: window-writable-choice, note-storage]
- [note-downstream](04-note-downstream.md) — 批准窗口、PM 和子代理的原型清单带补充说明 [依赖: note-storage]
