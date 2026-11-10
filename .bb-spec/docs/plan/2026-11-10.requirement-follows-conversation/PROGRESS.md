# 执行进度
| 序号 | Plan | 状态 | 完成时间 |
|---|---|---|---|
| 01 | 01-line-anchor-foundation | done | 2026-11-10 |
| 02 | 02-requirement-file-repo | done | 2026-11-10 |
| 03 | 03-line-draft-save-read | pending | — |
| 04 | 04-line-process-records | pending | — |
| 05 | 05-line-prototype-board | pending | — |
| 06 | 06-conventions-draft | pending | — |
| 07 | 07-switch-restore-message | pending | — |
| 08 | 08-approved-files-into-branch | pending | — |
| 09 | 09-upgrade-migration | pending | — |
## 当前
准备执行 `03-line-draft-save-read.md`。
01 自修记录：审查发现 5 处实现偏差（重新批准丢内容、kind 类型推成 never、按时间戳判先后、全表扫描、首锚点非保存时版本号），自修 1 次后复审通过；锚点记录新增 sequence 字段。下游注意：createLineAnchorIn、attachRecordIn 必须在 db.transaction 里调用；批量判断用 lineViewIn + memberAnchorIn。
02 自修记录：实现先加了"没传 anchor 就用 operationId 顶上"的兼容兜底，已删掉并让旧测试补传 UUIDv7 锚点；审查发现旧仓库分叉丢版本、逐引用起子进程变慢、重放拨回 main、草稿文件重试不比内容、底稿单独存在、分叉空提交 6 处，自修 1 次后复审通过。`verifyWorkingCopy` 的批准核对挪到计划 04；旧仓库 main 补 refs/lines 挪到计划 09。未补的低风险测试：历史里出现可执行位/软链接/子模块条目、保存时 main 被别的进程抢先挪动（审查已用临时脚本实测通过）。
## 阻塞
（无）
