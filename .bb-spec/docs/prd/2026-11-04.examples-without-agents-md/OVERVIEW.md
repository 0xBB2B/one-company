---
name: examples-without-agents-md
description: 设计规范样例不带 AGENTS.md，/one:examples 只复制 skills 和角色定义；和内置 skill 冲突的条目写进样例定义正文
date: 2026-11-04
features: [spec-examples, role-definitions]
---

# 设计规范样例只复制 skills 和角色定义

## 背景与问题
- 设计规范样例（仓库 `examples/<栈>/` 下的一套团队规范，用户用 `/one:examples` 复制到用户层或项目层）现在有三类文件：一段写进 `AGENTS.md` 的关键设计决定、几份详细规范 skill、和内置专项定义同名的角色定义。
- 用户级和仓库根目录的 `AGENTS.md` 会整份发给每个代理：主代理、PM、worker、reviewer、qa、explore、原型设计师都会收到。Go 样例那一段 4837 字节，Vue 样例那一段 2334 字节。
- 这段内容只有对应技术栈的专项 worker 和专项审查用得上。vue-worker、explore、原型设计师每次都会收到 Go 后端的分层、主键、错误码规范，这些对它们是无关内容，白占上下文。
- 这段内容和样例 skill 基本重复，例如错误码 `A-BBB-CCCC`、token 存 localStorage 在样例 skill 里都写了。go-worker、go-reviewer 加载这些 skill 的全文，同样的规范读了两遍。
- 两段合计 7171 字节，占了规范 16 KB 上限的 44%，挤掉了用户自己写规范的空间。
- 这段内容里只有一条是 skill 替代不了的：样例规定 token 存 localStorage，这和内置 skill auth-session 第 15 条"登录 token 存在 localStorage 或 sessionStorage 里"冲突。现在职责规矩只写了"skill 和 AGENTS.md 冲突时按 AGENTS.md"，样例靠 AGENTS.md 推翻这一条。职责规矩是程序按角色固定加进提示词的流程规矩，用户改不到。

## 目标
- 复制样例后，用户级和仓库根目录的 `AGENTS.md` 一个字都不变；只有用到样例定义的专项代理拿到样例规范。
- 样例定义正文里写明"某条内置 skill 在本团队不适用"后，worker 照着写、审查不因这条打回。
- `/one:examples` 的确认窗口正常情况只说几份，有特殊情况才逐条说明。

## 非目标
- 处理用户以前复制进 `AGENTS.md` 的那一段：程序不识别、不提示、不删除，用户自己删。
- 改程序把 `AGENTS.md` 发给哪些代理的规则。
- 改 PM、主代理的提示词。
- 规定定义正文和 `AGENTS.md` 冲突时听谁的。
- 改选层窗口。

## 子需求清单
| 序号 | 子需求 | 解决的子问题 | 优先级 |
|---|---|---|---|
| 01 | [复制样例不碰 AGENTS.md](01-copy-without-agents-md.md) | 样例去掉 AGENTS.md，`/one:examples` 只复制 skills 和角色定义，确认窗口改成只说几份 | P0 |
| 02 | [定义正文写明不适用的 skill 条目](02-definition-body-overrides-skill.md) | 冲突条目改写在样例定义正文里，worker、审查按定义正文执行 | P0 |

## 依赖与交付顺序
02 → 01。先让定义正文能推翻 skill 条目，再去掉样例里的 AGENTS.md；反过来的话，中间那段时间里 localStorage 那一条没有地方能推翻。

## 整体验证路径
1. 在仓库根目录执行 `ls examples/golang examples/vue` → 两个目录下都只有 `skills/`、`agents/`，没有 `AGENTS.md`。
2. 在 `~/.pi/agent/AGENTS.md` 写两行个人规范，运行 `/one:examples`，选 golang、用户层 → 确认窗口第一行是「复制 12 份到 ~/.pi/agent/：10 份 skill、2 份角色定义。」，没有任何关于 AGENTS.md 的内容 → 选「复制」→ 直接显示「✓ Go 后端样例已复制到用户层：新复制 12 个文件。」，中间不弹别的窗口；`~/.pi/agent/AGENTS.md` 还是原来那两行。
3. 再运行 `/one:examples` → golang 一行显示「用户层：已复制」。
4. 跑 P18 → vue-reviewer 不因 refresh token 存 localStorage 打回，埋好的 token 拼进 URL、v-html 两处问题照样列为阻塞。
5. `pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全部通过；P1–P18 和 M9-AC12 按 2 次都过、或一过一不过时第 3 次过的规则判定通过。

## 决策记录
- 样例不带 `AGENTS.md`，`/one:examples` 只复制 skills 和角色定义；冲突条目写进样例定义正文，并在 worker、专项审查、通用审查的职责规矩里加"定义正文写明某条 skill 不适用时，按定义正文"。原因：`AGENTS.md` 会发给所有代理（`src/app/daemon/run-manager.ts:379` PM、`:573` worker/reviewer/qa、`:842` explore、`:920` 原型设计师），只跟某个技术栈有关的规范放错了地方；skill 只发给定义里点名它的代理，是该放的地方。用户 2026-11-04 决定。
- 否决"保留 AGENTS.md 那一段，缩到几行"：每个代理仍然会收到，只是减轻症状。否决"程序按角色决定发不发 AGENTS.md"：会改变所有用户自己写的 AGENTS.md 怎么生效，范围太大。用户 2026-11-04 决定。
- 这推翻了 2026-10-23.spec-examples 里"样例有三类文件，其中一类是 AGENTS.md 要点"的方案；推翻了 2026-10-23.examples-command 里"选哪一层，三类文件就一起放到哪一层""合并后超过 16 KB 不写 AGENTS.md""一层算已复制要求 AGENTS.md 那一段也一致"几条决定，以及整份 02-agents-md-section 子需求；推翻了 2026-11-02.examples-conventions-summary 里写入窗口只显示摘要的决定，写入窗口整个删掉。
- 以前复制进 `AGENTS.md` 的那一段，程序不管，用户自己删。原因：按仓库"不做向后兼容"的规矩，不为旧数据写识别和删除的代码；不删也不会出错，冲突那一条照样按 `AGENTS.md` 生效，只是继续占上下文。否决"命令发现旧段落时提示删除"：属于兼容旧数据的代码。用户 2026-11-04 决定。
- 新增一条真实模型验收 P18，证明专项审查会按定义正文放过 localStorage 那一条。原因：风险就在于模型照不照做，只有真调模型才能证明。否决"只检查职责规矩和样例定义里有这句话"：证明不了模型照做。用户 2026-11-04 决定。
- 确认窗口正常情况只说几份，有特殊情况才逐条说明；替换的是包里内置的定义时不写说明。原因：用户看原型时觉得现在逐个列名字的写法不直观，复制样例本来就是为了替换内置定义，这是预期中的结果。原型第 2 版还试过按"会怎样"分组、按文件类型分组两种写法，用户要求再简化。用户 2026-11-04 决定。这推翻了 2026-10-23.examples-command 确认窗口按类别列出名字、写「复制后替换同名的内置定义。开关按定义名记，…」的约定。
- 冲突条目只找到 auth-session 第 15 条这一条。查法是按分层、主键、软删除、错误码、日志、token 有效期、token 存放、cookie 这些主题，在 go-worker、vue-worker 预设的内置 skill 里搜关键词，没有逐条通读 145 KB 的内置 skill。以后发现别的冲突，照同样的写法加进样例定义正文。
- 新规则写进三份职责规矩：worker（`role-rules/worker.md`）、专项审查（`role-rules/reviewer-specialist.md`）、通用审查（`role-rules/reviewer.md`）。通用审查也要加，原因：专项审查被关掉时，通用审查会拿到 worker 定义加载的 auth-session（`src/app/daemon/run-manager.ts:636-648`），也会按第 15 条打回。这条规则对用户自己写的定义同样生效。
- 改了职责规矩，按仓库规矩要跑全部单点验收和零自定义完整流程；没有改 PM、主代理的提示词，不跑渐进需求完整流程。
- 以下几条是写 PRD 时按确认过的原型和现有代码定的，用户在确认 PRD 时一并认可或推翻：
  - 份数按 skill 目录和定义文件计：一份 skill 是一个目录，一份角色定义是一个文件。结果提示里的"新复制 N 个文件"和现在一样按文件计，所以 skill 目录里有多个文件时，两处数字可能不同。
  - 一层里没有要复制的（全部跳过或被改过）时，第一行写「这一层没有要复制的。」。
  - 被改过的条目写成相对层目录的路径：skill 写 `skills/<名字>`，定义写 `agents/<名字>.md`。
  - P18 用 Vue 样例：按 `/one:examples` 复制到用户层后的 vue-reviewer。对照组有两处：token 拼进 URL（auth-session 第 12 条），证明同一份 skill 的其他条目照常生效；v-html 渲染用户评论（和 P16 埋的问题相同），证明这次审查确实在审代码。另外临时删掉正文那一行跑 2 次，证明不写这一行时审查确实会打回。
  - 仓库 `AGENTS.md` 和 `CONTRIBUTING.md` 里"全部单点测试（P1–P17）"改成 P1–P18。
