# M8 状态

阶段目标：共享最终资料、保留人工历史、其他人无需本产品；业务 Git 写入外置为可选交付工具，PM 在验收前同步目标分支，本机需求 Git 仅作核心内部版本存储。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 他人无本机数据可读 spec 与归档，自有扫描排除归档，需求工具不导入 | 通过 | tests/team-clone.test.ts「M8-AC1/AC3/AC7」：B 克隆 A 后用普通文件读取当前 spec 与已完成归档；tests/integration/knowledge-query.test.ts：全新数据根下知识查询对账时归档（权限设为不可读）零读取；tests/project-index-requirements.test.ts「无本机data.db的接入不因外来归档创建空需求库或授权」；tests/requirement-service.test.ts「create 分配到已有完整 UUID 归档时持久降权」。不保证 B 的任意通用工具读不到归档 | 无 |
| AC2 活动 prod 与本机 .git 在工作区外；提交推送拒绝未完成正文、私有版本库与伪装归档 | 通过 | tests/project-index-policy.test.ts「M2-AC1：dataRoot 必须与 worktree 分离」、tests/project-manage-tool.test.ts「dataRoot 位于仓库内时在服务打开前拒绝」；tests/prod-storage.test.ts「恶意本地与全局 Git 配置、hook、filter、textconv、签名和远端探针均不执行」「额外暂存路径明确拒绝」；tests/git-delivery.test.ts「M8-AC2/AC5」：未完成、归档未写入、归档不符、工作区有其他改动、分支夹带别的 docs/prod 文件均拒绝交付；交付只提交归档文件本身 | 无 |
| AC3 未安装产品也能读文件、跑业务；安装不要求额外 Git 扩展 | 通过 | tests/team-clone.test.ts「M8-AC1/AC3/AC7」：克隆 B 在空 HOME 下用 node 直接运行示例业务、跑规则检查，不产生任何本产品数据；包内已删除默认 git-commit 技能（tests/package-skeleton.test.ts）；安装只依赖 Git 本身（tests/git-prerequisite.test.ts） | 无 |
| AC4 关闭可选 Git 集成后核心仍能完成、关闭、归档 | 通过 | tests/git-delivery-extension.test.ts：交付工具默认关闭且不出现；tests/zero-custom-loop.test.ts：交付工具关闭时走完验收、完成关闭与归档；tests/git-prerequisite.test.ts：本机 Git 缺失时按存储前置条件报错 | 无 |
| AC5 适配器只拿无正文凭据；暂存归档字节须匹配凭据，工作区与暂存区不一致不漏检 | 通过 | tests/workflow-close.test.ts「M7B-AC1/AC5」：关闭状态给出工作区、分支、最终检查代码提交与归档 hash，不含 prod 正文；tests/git-delivery.test.ts「M8-AC2/AC5」：归档字节与凭据不符拒绝且撤回暂存，交付时先按工作区内容暂存再核对暂存字节与工作区一致；「M8-AC5/AC6」：PR 描述与全部 gh 调用不含 prod 正文。实现 runtime/git-delivery.ts | 无 |
| AC6 本地远端与 gh/glab 替身：准确 SHA、无授权停止、非快进拒绝、结果不明先查询、PR 复用、自动合并由用户选 | 通过 | tests/git-delivery.test.ts：推送的正是核对后的提交号、只多一个归档提交；用户不确认不提交不推送；远端非快进拒绝且不强推；创建结果不明先查询后复用、重跑不重复创建；选自动合并时 gh 用 --auto --squash --match-head-commit，仓库不允许 squash 时按允许方式，glab 不允许 squash 时退为普通合并；选自己 review 不触发合并。tests/git-delivery-extension.test.ts：工具默认隐藏、命令开关、参数不接受合并方式 | 无 |
| AC7 独立 CI 检查只查当前 spec，不启动 PM/模型/数据库，不读关闭 prod | 通过 | tests/spec-check.test.ts：`pi-company-spec-check`（bin/spec-check.mjs → runtime/spec-check.ts）只读 docs/spec，通过退出 0；格式错误、机械冲突、重复规则退出 1 并列出规则；docs/prod 下的损坏文件不影响结果；空 HOME 运行后不产生任何文件 | 无 |
| AC8 关闭后新反馈建新需求，不重开或复制旧 prod | 通过 | tests/requirement-state.test.ts「仅归档线索或未知历史只阻塞，不猜测completed或恢复执行」；tests/requirement-service.test.ts「缺授权、异步授权、伪字段和 closing/closed 正文读取均拒绝」「create 分配到已有完整 UUID 归档时持久降权，归档删除后也不自动恢复」；tests/explore-session.test.ts「M6-AC5/AC7」：已关闭需求的 PM/子会话不续接 | 无 |
| AC9 两个 PM 分别发布同规则候选互不串用；未同步不能开检查，同步冲突交 PM，机械规则冲突阻止检查，交付时目标前进须重新同步 | 通过 | tests/spec-change.test.ts「M8-AC9」：同一仓库两个需求在各自 worktree 为同一规则发布不同候选，对方证据不能用于本方发布，互不覆盖；tests/pm-sync.test.ts：同步 rebase、冲突时合成一份重新应用并列出冲突文件、原提交可找回、有 origin 时拉取远端默认分支；tests/workflow-close.test.ts「M8-AC9」：未同步开检查被拒（sync_required）、机械规则冲突被拒（spec_conflict）；tests/git-delivery.test.ts「M8-AC9」：验收后目标前进能干净 rebase 才继续并在 PR 注明，冲突即停止不推送。门槛口径：需求分支须包含目标分支最近一次拉取到的提交，拉取由 git_sync 与交付工具触发 | 无 |
| AC10 两个克隆同标题需求归档用不同 UUID，合并不撞名；同 UUID 冲突照常报告 | 通过 | tests/team-clone.test.ts「M8-AC10」：两个克隆同标题归档文件名描述相同、UUID 不同，合并无冲突；tests/requirement-identity.test.ts「同标题的两个完整 UUID 保持不同身份」「归档枚举只按完整 UUID 返回路径元数据；同 UUID 多描述报告冲突且零正文读取」 | 无 |

## 当前阻塞

无。

已知限制：仓库没有 origin 且主仓库处于分离 HEAD 时无法确定目标分支，PM 不能开始最终检查，需要先在主仓库检出分支。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（§11.7 与 M8 章节），再核对 git status 与最近提交。M0–M7、M7A、M7B 已收口不重做。
下一步：按 M8-STATUS.md 的 AC 表续做 M8。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
