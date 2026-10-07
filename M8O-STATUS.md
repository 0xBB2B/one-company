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
| AC1 批准即暂停，计划确认后恢复或停止 | 通过 | tests/approval-hold.test.ts「M8O-AC1」三条（不受影响恢复、受影响改写后停止并记为被取代、用户先暂停 PM 再批准），tests/plan-manage.test.ts「M8O-AC1：…是否恢复」；c14c6e1、5f7f015、f1613c9，旧代码下先失败 | 无 |
| AC2 实施目标由正文实施目标板块决定 | 通过 | tests/plan-manage.test.ts「M8O-AC2」、tests/requirement-doc.test.ts、tests/main-requirement-interaction.test.ts「M8O-AC2」、tests/prod-view.test.ts「M8O-AC2」（编号前缀核对，用户 2026-10-07 选甲）；2d6ca44、88a77c7 | 无 |
| AC3 上一版本下的尝试被判受影响后可重排 | 通过 | tests/plan-assess.test.ts「M8O-AC3」；403e501 | 无 |
| AC4 任务 1 完成、2 进行中时追加需求的两种情况 | 通过 | tests/approval-hold.test.ts「M8O-AC4」两条；1b59007 | 无 |
| AC5 真实模型验收并入 M9-AC2、3、12、13 按 3 轮规则重跑 | 通过 | 2026-10-07 基线 3536dc9 上四项各连续 3 轮通过（证据 .bb-spec/.cache/m9/acceptance-m8n/ 下 progressive、code-error、zero-custom、ui-worker 开头的 2026-10-07T06 至 T09 目录） | 无 |

## 当前阻塞

无。AC1 到 AC5 全部通过。基线 f1613c9 上 typecheck 通过、单元 2499 条全过，集成 56 条全过，安装 11 条通过（1 条需 Docker 跳过）。改动经独立审查，提出的 3 个问题（批准前已暂停的子代理漏进名单、原型运行被误停、段落归属与编号不一致）与复核发现的结算竞态均已修复并复核。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8L 到 M8O、M9 章节、§5.5 影响复核协议与 §13），再读本文件与 M9-STATUS.md，核对 git status 与最近提交，从 AC 状态表第一条未通过的 AC 继续。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
