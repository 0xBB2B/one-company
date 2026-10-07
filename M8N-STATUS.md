# M8N 状态

阶段目标：需求的每个段落只认最近一次确认（整段替换），取代关系由程序判断，不再依赖解读模型声明；交给解读模型的旧依据、有效旧决定和批准清单引用的决定不再随批准次数增长。

范围与非目标：按计划 M8N 一节。不改存储结构；不改 20 条、48KB、40 个这些上限；不改待答问题与待修订事项的判断。

验证方法：AC1 到 AC4 有对应测试，先失败后通过；改动提交前由独立代理审查；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 通过；AC5 由 M9-AC2、AC3、AC12、AC13 在新基线上按 3 轮规则重跑取证。

性能指标：不新增指标。

停止条件：出现 AGENTS.md「停止规则」任一情况；缩小有效旧决定的范围若牵涉单题短答引用旧约束等路径、需要超出计划的改动，停下报告用户。

起因（用户 2026-10-05 决定）：真实验收数据里解读模型从未声明取代（已取代 0 条），按数据库粗算，一个需求解读 3 次后未被取代的旧决定已有 22 条，超过交给解读模型的 20 条上限；旧依据每份约 1.1KB，按记录推算二十多段的需求批准两次后最多累计 43–60KB（录到的实际下限 12.7KB），第 3 版前后会超过 48KB。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 整段替换：后一次确认整体替换前一次 | 通过 | tests/interaction-continuity.test.ts「M8N-AC1、AC4：同一段落后一次确认…」「M8N-AC1：同一段落先被排除、后被确认为目标…」，旧代码下失败、新代码下通过（7a01829） | 无 |
| AC2 25 段草稿批准 5 版后解读与批准仍成功，依据与决定不随版本增长 | 通过 | 「M8N-AC2、AC3：25 段草稿连续批准 5 个版本…」：5 版的旧决定数、依据来源数、清单决定数完全不变；最后一轮沿用旧依据时逐段只来自一次确认、清单引用决定数不超过段落数（7a01829） | 无 |
| AC3 解读模型不写取代时 AC2 照样成立 | 通过 | 同上用例全程不写取代 | 无 |
| AC4 引用已被替换的旧确认去批准被拒绝 | 通过 | 「M8N-AC1、AC4」引用最早那次报 retained_source_missing；「M8N-AC4：段落的当前确认被取代…不退回更早那次」（独立审查发现后补，7a01829） | 无 |
| AC5 真实模型验收并入 M9-AC2、3、12、13 按 3 轮规则重跑 | 通过 | 2026-10-07 基线 3536dc9 上四项各连续 3 轮通过（证据 .bb-spec/.cache/m9/acceptance-m8n/ 下 progressive、code-error、zero-custom、ui-worker 开头的 2026-10-07T06 至 T09 目录） | 无 |

## 当前阻塞

无。AC1 到 AC5 全部通过。基线 7a01829 上 typecheck、单元 2487 条全过，集成 56 条全过，安装 11 条通过（1 条需 Docker 跳过）。改动经独立审查，审查提出的 1 处代码问题与 2 处测试缺口已修并复核为全部解决。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8K 到 M8N、M9 章节与 §13），再读本文件、M8M-STATUS.md 与 M9-STATUS.md，核对 git status 与最近提交，从 AC 状态表第一条未通过的 AC 继续。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
