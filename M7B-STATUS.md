# M7B 状态

阶段目标：PM 完成任务后不自行关闭，而是提交完成报告等待用户验收；用户读完确认通过后才由主窗口以 completed 关闭，返工则意见交回原 PM 继续。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 检查通过且交付核对无阻塞后 PM 能提交报告，事实由程序生成 | 未开始 | — | 全部 |
| AC2 报告进 PM 面板待办，关窗仍保留，决策包展示全文 | 未开始 | — | 全部 |
| AC3 无用户通过决定时 completed 关闭一律被拒 | 未开始 | — | 全部 |
| AC4 用户通过后主窗口关闭成功、PM 停止、完成归档 | 未开始 | — | 全部 |
| AC5 返工作废报告、意见交回 PM、须重新审查与检查 | 未开始 | — | 全部 |
| AC6 批准清单不再接受 close，旧预授权不产生关闭权限 | 未开始 | — | 全部 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（§8.10 与 M7B 章节），再核对 git status 与最近提交。M0–M7、M7A 已收口不重做。
下一步：按 M7B-STATUS.md 的 AC 表续做 M7B。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
