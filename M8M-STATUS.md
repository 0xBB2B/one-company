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
| AC1 任务尝试与审查记录不设上限；计划累计任务数仍限 256 | 通过 | tests/plan-assess.test.ts「M8M-AC1」先失败后通过（a2d2aac）；累计任务数按用户决定不改（7283a6a） | 无 |
| AC2 累计提问不设上限；改草稿交给核验器的问题从新到旧放满 64KB | 通过 | tests/adjudication.test.ts「M8M-AC2」20 条通过、21 条失败对照后修复（1887540）；tests/main-requirement-interaction.test.ts「M8M-AC2」先失败后通过（724d504） | 无 |
| AC3 连续性记录 | 移交 M8N | 实测每个需求 2–4 条连续性记录，扫描条数上限不动；同一段落旧依据重复堆积由 M8N 处理 | 无 |
| AC4 出处目录编号与接手记录读取不设条数上限 | 通过 | tests/pm-intake-runtime.test.ts 两条「M8M-AC4」先失败后通过（1f5a678、a2e6d2e） | 无 |
| AC5 清理无引用常量与选项；三处 git 调用补超时 | 通过 | 3813f63；tests/git-timeouts.test.ts（7aa4701） | 无 |
| AC6 真实模型验收并入 M9-AC2、3、12、13 按 3 轮规则重跑 | 通过 | 2026-10-07 基线 3536dc9 上四项各连续 3 轮通过（证据 .bb-spec/.cache/m9/acceptance-m8n/ 下 progressive、code-error、zero-custom、ui-worker 开头的 2026-10-07T06 至 T09 目录） | 无 |

## 当前阻塞

无。AC1 到 AC6 全部通过（AC3 移交 M8N）；基线 724d504 上集成 56 条、安装 11 条通过（1 条需 Docker 跳过）。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8K 到 M8M、M9 章节与 §13），再读本文件与 M9-STATUS.md，核对 git status 与最近提交，从 AC 状态表第一条未通过的 AC 继续。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
