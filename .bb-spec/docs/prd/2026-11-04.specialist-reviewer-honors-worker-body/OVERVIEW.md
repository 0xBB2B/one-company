---
name: specialist-reviewer-honors-worker-body
description: 专项审查的职责规矩写明：被审 worker 定义的正文写明某条 skill 不适用时，同样按定义正文处理
date: 2026-11-04
features: [stack-agents, role-definitions]
---

# 专项审查按被审 worker 的定义正文放过不适用的 skill 条目

## 背景与问题
- 专项审查是按技术栈 skill 审代码的审查代理，例如 vue-reviewer。它的职责规矩（程序按职责固定加进提示词的流程规矩，用户改不到）现在写的是：「你的定义正文写明某份 skill 的某一条在本团队不适用时，违反那一条但符合定义正文的不算问题」。规矩只认专项审查自己的定义正文。
- 每个审查的任务说明里都附有被审 worker 定义的正文。通用审查的职责规矩写明按这份正文放过不适用的条目，专项审查的没有写。README 和 2026-11-04.examples-without-agents-md 的决策记录都说专项审查也按 worker 正文对齐。
- 现在专项审查按不按 worker 正文放过，全靠模型自己推断。实测只删掉 vue-reviewer 正文里那一行，P18 跑 2 次都通过，说明眼下的模型会推断，但规矩里没有保证。
- 用户只在自己写的 worker 定义里写团队例外、审查定义用包里内置那份时，专项审查可能照 skill 打回符合团队决定的代码。例：vue-worker 正文写明 auth-session 第 15 条在本团队不适用，refresh token 存 localStorage；内置 vue-reviewer 正文没有这句，可能因 token 存 localStorage 列阻塞。

## 目标
- 专项审查的职责规矩写明：自己的定义正文或被审 worker 定义的正文写明某条 skill 不适用时，违反那一条但符合定义正文的不算问题。
- 用真实模型证明：只有 worker 正文写明不适用时，专项审查也不因这一条打回。

## 非目标
- 规定 worker 正文说某条不适用、专项审查自己的正文又说这条适用时听谁的。
- 改程序把 worker 正文放进审查任务说明的做法。
- 改 worker、通用审查的职责规矩。
- 改 P18。

## 子需求清单
| 序号 | 子需求 | 解决的子问题 | 优先级 |
|---|---|---|---|
| 01 | [专项审查按 worker 定义正文放过](01-specialist-honors-worker-body.md) | 规矩写明这条，并用真实模型验收证明 | P0 |

## 依赖与交付顺序
单一子需求，无依赖。

## 整体验证路径
1. `pnpm test` → 检查专项审查职责规矩原文的单元测试通过。
2. 跑 P20 → vue-reviewer 正文没有 auth-session 那一行、只有 vue-worker 正文有时，vue-reviewer 不因 refresh token 存 localStorage 打回，token 拼进 URL、v-html 两处照样列为阻塞。
3. `pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全部通过；P1–P20 和 M9-AC12 按 2 次都过、或一过一不过时第 3 次过的规则判定通过。

## 决策记录
- 在专项审查的职责规矩里补上"被审 worker 定义的正文"，和通用审查的规矩、README、2026-11-04.examples-without-agents-md 里"所有审查都按 worker 正文对齐"的决定一致。原因：只靠模型推断，换模型或换写法时可能不推断。否决"让用户在专项审查定义里也抄一遍"：一个团队决定要写两处，漏一处就会被打回。用户 2026-11-04 决定。
- 新增真实模型验收 P20，P18 保持不变。原因：只检查规矩原文证明不了模型照做；P18 验的是专项审查按自己正文放过，P20 验的是只按 worker 正文放过，两条路径都要保住。否决"只加单元测试"：证明不了模型照做；否决"改造 P18"：会丢掉按自己正文放过那条路径的验证。代价是每次验收多跑一条，约多 2 分钟。用户 2026-11-04 决定。
- 新验收编号用 P20，不用 P19。原因：tech-approval 分支已把 P19 用作另一条验收，两边都叫 P19 时后合并的一方会在编号表上冲突，`--only P19` 也会选中两条不相干的验收；本分支还没推送，改号代价最小。代价：对方合并之前，本分支文档写 P1–P20 但没有 P19。用户 2026-11-04 决定。
- worker 正文和专项审查自己的正文对同一条说法相反时听谁的，这次不规定，和上一份 PRD 不规定"定义正文和 AGENTS.md 冲突时听谁的"一致；目前没有这样的定义。
- 改了专项审查的提示词，按仓库规矩要跑全部单点验收和零自定义完整流程；没有改 PM、主代理的提示词，不跑渐进需求完整流程。仓库 `AGENTS.md` 和 `CONTRIBUTING.md` 里"全部单点测试（P1–P18）"改成 P1–P20。
