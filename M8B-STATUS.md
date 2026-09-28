# M8B 状态

阶段目标：项目长期遵守的编码与文档规范写在仓库根目录 AGENTS.md，只有用户在界面上确认过的版本才生效；宿主派 PM、worker、reviewer 时放入批准版本，reviewer 按它把关。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 主会话专门动作提出修改，界面显示差异，用户确认后写文件并登记批准版本；取消、无界面或伪造确认不写不登记 | 通过 | 806dcbc；tests/project-manage-tool.test.ts（首次全文、再次差异、确认后写文件并登记；取消、无界面、过长、参数伪造确认不写不登记） | 无 |
| AC2 派 PM/worker/reviewer 时放入批准版本并标明来源；绕过专门动作改磁盘仍只送批准版本并提示不一致；无批准版本不送 | 通过 | 806dcbc；tests/pm-dispatch.test.ts（PM 上下文含批准版本与来源、磁盘被改仍只送批准版本并带 conventionsNotice、无批准版本不送）、tests/task-dispatch.test.ts（worker 与 reviewer 上下文）、tests/project-manage-tool.test.ts（conventions-status 显示不一致） | 无 |
| AC3 worker 的 change_apply、验证命令与 PM 提交不能写入或提交 AGENTS.md | 通过 | 806dcbc；tests/core-permissions.test.ts（AGENTS.md 归为项目规范、不可写）、tests/change-apply.test.ts、tests/pm-commit.test.ts、tests/verification-run.test.ts（沙箱拒写，去掉保护时该用例失败） | 无 |
| AC4 主会话规则含规范与需求分流标准；reviewer 定义按批准规范把关；角色定义测试覆盖 | 通过 | 806dcbc；tests/role-catalog.test.ts（主会话分流规则、worker 遵守、reviewer 把关并写明核对结果、PM 不冲突） | 无 |
| AC5 typecheck 与四套测试全绿；真实模型闭环在新基线通过，首条消息里的规范被分流进 AGENTS.md 并经确认，worker 遵守、审查结论写明核对该规范 | 通过 | 代码基线 aa91925：typecheck 通过，单元 2324、集成 80、安装 11 全部通过；5c99c68 只改验收断言。真实模型第 53 轮（5c99c68）pnpm run test:acceptance 通过、需求以完成关闭，证据 .bb-spec/.cache/m9/acceptance/zero-custom-2026-09-28T08-06-40-015Z/：弹窗"确认更新项目规范 AGENTS.md"后登记批准版本，草稿不含规范；worker 新增导出常量 RUN_MULTIPLIER 用大写下划线；reviewer 结论写明"已核对项目规范：导出常量均为 UPPER_SNAKE_CASE" | 无 |

## 当前阻塞

无。M8B 全部 AC 已通过，阶段收口；下一步回到 M9。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8B 一节），再读 M8B-STATUS.md，核对 git status 与最近提交。M0–M8、M8A、M8B 已收口；当前执行 M9（读 M9-STATUS.md 续接）。
M8B 用户已定：只有用户在界面确认过的 AGENTS.md 版本才生效；主会话用专门动作提出完整新内容，宿主弹窗显示差异，确认后写文件并在 data.db 登记批准版本；派 PM/worker/reviewer 时只送批准版本；子代理与 PM 提交不能写 AGENTS.md；主会话按"长期规范 → AGENTS.md，这次要做的行为 → 需求文档"分流；真实模型验收首条消息加一条规范实测分流。
同一 worktree 还有其他会话在干活：改计划正文与 rules/01-main-session.md 前先发消息排先后。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation；真实模型闭环见 M9-STATUS.md 的运行方式。
```
