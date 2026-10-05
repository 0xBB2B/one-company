# M8N 状态

阶段目标：需求的每个段落只认最近一次确认（整段替换），取代关系由程序判断，不再依赖解读模型声明；交给解读模型的旧依据、有效旧决定和批准清单引用的决定不再随批准次数增长。

范围与非目标：按计划 M8N 一节。不改存储结构；不改 20 条、48KB、40 个这些上限；不改待答问题与待修订事项的判断。

验证方法：AC1 到 AC4 有对应测试，先失败后通过；改动提交前由独立代理审查；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 通过；AC5 由 M9-AC2、AC3、AC12、AC13 在新基线上按 3 轮规则重跑取证。

性能指标：不新增指标。

停止条件：出现 AGENTS.md「停止规则」任一情况；缩小有效旧决定的范围若牵涉单题短答引用旧约束等路径、需要超出计划的改动，停下报告用户。

起因（用户 2026-10-05 决定）：真实验收数据里解读模型从未声明取代（已取代 0 条），一个需求解读 3 次后有效旧决定已有 22 条，超过交给解读模型的 20 条上限；旧依据每份约 1.1KB，二十多段的需求批准两次后累计 43–60KB，第 3 版前后会超过 48KB。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 整段替换：后一次确认整体替换前一次 | 未开始 | 无 | 全部 |
| AC2 25 段草稿批准 5 版后解读与批准仍成功，依据与决定不随版本增长 | 未开始 | 无 | 全部 |
| AC3 解读模型不写取代时 AC2 照样成立 | 未开始 | 无 | 全部 |
| AC4 引用已被替换的旧确认去批准被拒绝 | 未开始 | 无 | 全部 |
| AC5 真实模型验收并入 M9-AC2、3、12、13 按 3 轮规则重跑 | 未开始 | 无 | 待 AC1 到 AC4 完成 |

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M8K 到 M8N、M9 章节与 §13），再读本文件、M8M-STATUS.md 与 M9-STATUS.md，核对 git status 与最近提交，从 AC 状态表第一条未通过的 AC 继续。
可参考的先前补丁：.bb-spec/.cache/m8m/dedupe-by-unit.patch（旧依据按段落只留最新一次确认）。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
