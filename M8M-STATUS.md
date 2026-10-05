# M8M 状态

阶段目标：按需求累计的提问、连续性记录、接手记录与任务记录不再因条数上限把流程卡死；清理没有任何引用的上限常量与选项；给没有超时的 git 调用补上超时。

范围与非目标：按计划 M8M 一节。不改与累计无关的上限（待答问题 20 条、决定条数、单次提交条数、各类大小上限）；不归档或删除旧记录；不改索引预算。

验证方法：AC1 到 AC5 有对应测试，先失败后通过；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 通过；AC6 由 M9-AC2、AC3、AC12、AC13 在新基线上按 3 轮规则重跑取证。

性能指标：不新增指标。

停止条件：出现 AGENTS.md「停止规则」任一情况。

起因（用户 2026-10-05 决定）：逐处盘点上限后发现，有几处数的是需求有史以来的全部记录，需求用久了迟早到数，到数后整次拒绝；其中累计提问超过 20 条后主代理改不了草稿、面板裁决登记不上。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 任务尝试与审查记录、计划累计任务数不设上限 | 未开始 | 无 | 全部 |
| AC2 累计提问不设上限；改草稿只把待答问题交给核验器 | 未开始 | 无 | 全部 |
| AC3 连续性扫描不设条数与每类字节上限，结果 48KB 不变 | 未开始 | 无 | 全部 |
| AC4 出处目录编号与接手记录读取不设条数上限 | 未开始 | 无 | 全部 |
| AC5 清理无引用常量与选项；三处 git 调用补超时 | 未开始 | 无 | 全部 |
| AC6 真实模型验收并入 M9-AC2、3、12、13 按 3 轮规则重跑 | 未开始 | 无 | 待 AC1 到 AC5 完成 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8K 到 M8M、M9 章节与 §13），再读本文件与 M9-STATUS.md，核对 git status 与最近提交，从 AC 状态表第一条未通过的 AC 继续。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
