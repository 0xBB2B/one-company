# M8O 状态

阶段目标：需求实施到一半时用户批准了新版本，按"先停、再重排、再继续"处理；要做的范围由批准的正文决定，不由解读模型逐段判定。

范围与非目标：按计划 M8O 一节。不改批准与核验流程本身；不改同一版本内的重试与返修次数；不改分析等其他动作的范围判定；不支持只批准实施"功能"里的一部分。

验证方法：AC1 到 AC4 有对应测试，先失败后通过；改动提交前由独立代理审查；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 通过；AC5 由 M9-AC2、AC3、AC12、AC13 在新基线上按 3 轮规则重跑取证。

性能指标：不新增指标。

停止条件：出现 AGENTS.md「停止规则」任一情况。

起因（用户 2026-10-06 决定）：M9-AC2 在 c7ba500、25a6642、7d5c7b3 三个基线上各有一轮失败，都发生在追加需求之后：解读模型在新版本批准时把原来要做的功能段或验收段改判为约束，做到一半的任务失去实施授权，而做过尝试的任务不能取消、原目标不能拿走，PM 计划两头被拒；批准新版本时正在运行的子代理也不暂停。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 批准即暂停，计划确认后恢复或停止 | 未开始 | 无 | 全部 |
| AC2 实施目标由正文实施目标板块决定 | 未开始 | 无 | 全部 |
| AC3 上一版本下的尝试被判受影响后可重排 | 未开始 | 无 | 全部 |
| AC4 任务 1 完成、2 进行中时追加需求的两种情况 | 未开始 | 无 | 全部 |
| AC5 真实模型验收并入 M9-AC2、3、12、13 按 3 轮规则重跑 | 未开始 | 无 | 待 AC1 到 AC4 完成 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8L 到 M8O、M9 章节、§5.5 影响复核协议与 §13），再读本文件与 M9-STATUS.md，核对 git status 与最近提交，从 AC 状态表第一条未通过的 AC 继续。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
