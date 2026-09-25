# M8 状态

阶段目标：共享最终资料、保留人工历史、其他人无需本产品；业务 Git 写入外置为可选交付工具，PM 在验收前同步目标分支，本机需求 Git 仅作核心内部版本存储。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 他人无本机数据可读 spec 与归档，自有扫描排除归档，需求工具不导入 | 未开始 | — | 全部 |
| AC2 活动 prod 与本机 .git 在工作区外；提交推送拒绝未完成正文、私有版本库与伪装归档 | 未开始 | — | 全部 |
| AC3 未安装产品也能读文件、跑业务；安装不要求额外 Git 扩展 | 未开始 | — | 全部 |
| AC4 关闭可选 Git 集成后核心仍能完成、关闭、归档 | 未开始 | — | 全部 |
| AC5 适配器只拿无正文凭据；暂存归档字节须匹配凭据，工作区与暂存区不一致不漏检 | 未开始 | — | 全部 |
| AC6 本地远端与 gh/glab 替身：准确 SHA、无授权停止、非快进拒绝、结果不明先查询、PR 复用、自动合并由用户选 | 未开始 | — | 全部 |
| AC7 独立 CI 检查只查当前 spec，不启动 PM/模型/数据库，不读关闭 prod | 通过 | tests/spec-check.test.ts：`pi-company-spec-check`（bin/spec-check.mjs → runtime/spec-check.ts）只读 docs/spec，通过退出 0；格式错误、机械冲突、重复规则退出 1 并列出规则；docs/prod 下的损坏文件不影响结果；空 HOME 运行后不产生任何文件 | 无 |
| AC8 关闭后新反馈建新需求，不重开或复制旧 prod | 未开始 | — | 全部 |
| AC9 两个 PM 分别发布同规则候选互不串用；未同步不能开检查，同步冲突交 PM，机械规则冲突阻止检查，交付时目标前进须重新同步 | 未开始 | — | 全部 |
| AC10 两个克隆同标题需求归档用不同 UUID，合并不撞名；同 UUID 冲突照常报告 | 未开始 | — | 全部 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（§11.7 与 M8 章节），再核对 git status 与最近提交。M0–M7、M7A、M7B 已收口不重做。
下一步：按 M8-STATUS.md 的 AC 表续做 M8。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
