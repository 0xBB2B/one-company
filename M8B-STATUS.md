# M8B 状态

阶段目标：项目长期遵守的编码与文档规范写在仓库根目录 AGENTS.md，只有用户在界面上确认过的版本才生效；宿主派 PM、worker、reviewer 时放入批准版本，reviewer 按它把关。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 主会话专门动作提出修改，界面显示差异，用户确认后写文件并登记批准版本；取消、无界面或伪造确认不写不登记 | 未开始 | — | 全部 |
| AC2 派 PM/worker/reviewer 时放入批准版本并标明来源；绕过专门动作改磁盘仍只送批准版本并提示不一致；无批准版本不送 | 未开始 | — | 全部 |
| AC3 worker 的 change_apply、验证命令与 PM 提交不能写入或提交 AGENTS.md | 未开始 | — | 全部 |
| AC4 主会话规则含规范与需求分流标准；reviewer 定义按批准规范把关；角色定义测试覆盖 | 未开始 | — | 全部 |
| AC5 typecheck 与四套测试全绿；真实模型闭环在新基线通过，首条消息里的规范被分流进 AGENTS.md 并经确认，worker 遵守、审查结论写明核对该规范 | 未开始 | — | 全部 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8B 一节），再读 M8B-STATUS.md，核对 git status 与最近提交。M0–M8、M8A 已收口；M9 暂停，当前执行 M8B。
M8B 用户已定：只有用户在界面确认过的 AGENTS.md 版本才生效；主会话用专门动作提出完整新内容，宿主弹窗显示差异，确认后写文件并在 data.db 登记批准版本；派 PM/worker/reviewer 时只送批准版本；子代理与 PM 提交不能写 AGENTS.md；主会话按"长期规范 → AGENTS.md，这次要做的行为 → 需求文档"分流；真实模型验收首条消息加一条规范实测分流。
同一 worktree 还有其他会话在干活：改计划正文与 rules/01-main-session.md 前先发消息排先后。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation；真实模型闭环见 M9-STATUS.md 的运行方式。
```
