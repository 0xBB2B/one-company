---
name: acceptance-default-pi-model
description: 真实模型验收默认用 pi 配置里的默认模型和思考等级，环境变量只在临时换模型时才写
date: 2026-11-05
features: [acceptance-tests]
---

# 真实模型验收默认用 pi 配置的模型

## 背景与问题
- 真实模型验收是 `tests/acceptance/` 下让真实模型参与的测试，开发者改了产品代码或提示词后要跑。现在每次跑都必须在命令前写 `ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型>`，不写就报错或整组跳过。
- 开发者平时用 pi（一个终端里的编码代理）时，模型已经在 pi 的配置文件 `~/.pi/agent/settings.json` 里配好了（`defaultProvider`、`defaultModel`、`defaultThinkingLevel` 三项）。验收还要再手写一遍，两处容易对不上：2026-11-05 查看时，开发者记下的验收模型是 `5x/gpt-6.1-sol`，pi 里配的是 `5x-test/gpt-6.1-sol`。
- 思考等级（模型回答前想得多深）也一样：验收脚本不看 pi 配置，自己默认用 `high`。

## 目标
- 不写模型环境变量时，验收用 pi 配置里的默认模型和思考等级。
- 临时想换模型或思考等级时，仍可用环境变量覆盖一次，不用改 pi 配置。
- 跑完能从汇总文件里看出这次实际用的是哪个模型、哪个思考等级。

## 非目标
- 读 pi 项目目录里的 `.pi/settings.json`：验收只读放凭据的那个目录里的 `settings.json`。
- 改验收里各角色、内部调用跟随主会话模型的做法。
- 改"每条先跑 2 次、一过一不过跑第 3 次"的判定规则。
- 改产品代码和提示词。

## 子需求清单
| 序号 | 子需求 | 解决的子问题 | 优先级 |
|---|---|---|---|
| 01 | [验收默认读 pi 配置的模型](01-default-from-pi-settings.md) | 不写环境变量时用 pi 的默认模型和思考等级，并在汇总里写明 | P0 |

## 依赖与交付顺序
单一子需求，无依赖。

## 整体验证路径
1. `pnpm test` → 检查验收配置怎么选模型、思考等级、什么时候跳过、什么时候报错的单元测试全部通过。
2. 不写 `ONE_COMPANY_ACCEPTANCE_MODEL`，只写 `ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel --only P11` → `summary.txt` 里"同时跑开始"那一行写着 pi 配置里的模型和思考等级，P11 按 2 次判定规则通过。
3. `pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全部通过。

## 决策记录
- 不写环境变量时，模型和思考等级都从 pi 配置读。原因：开发者在 pi 里已经配好了模型，验收再手写一遍会和实际在用的对不上。用户 2026-11-05 决定。
- `ONE_COMPANY_ACCEPTANCE_MODEL`、`ONE_COMPANY_ACCEPTANCE_THINKING` 保留，写了就以它为准。原因：判断失败是模型输出波动时，要临时换一个模型重跑，改 pi 配置会连带影响平时用的 pi。否决"只认 pi 配置"：每次临时换模型都要改再改回来。用户 2026-11-05 决定。
- pi 配置里没写思考等级、也没写环境变量时，用 pi 自己的默认值 `medium`，不用验收原来的 `high`。原因：和直接打开 pi 时的表现一致。代价：比原来低一档，模型可能想得浅一些；想要 `high` 就在 pi 里配 `defaultThinkingLevel`。用户 2026-11-05 决定。
- 跑不跑真实模型验收只看 `ONE_COMPANY_ACCEPTANCE_OUTPUT`。原因：模型变量是可选的，用它当开关的话，不写它就跑不了验收；证据目录每次都必须给，适合当开关。
- 代价：从命令上看不出用的是哪个模型，所以在 `summary.txt` 开始那一行写上实际的模型和思考等级。
- 当初为什么要求手写模型，git 记录里只有 `f9bfa61` 重构那次，没有写原因，PRD 里也没有记录。
- 新功能名 `acceptance-tests`：已有功能名里没有讲验收脚本的。
- 只改验收脚本和文档，按仓库规矩不要求重跑全部真实模型验收；验证路径里只跑一条 P11，确认不写环境变量时能真的跑起来。P11 起一个真实主会话，能同时验证主会话和角色都用上了 pi 配置的模型。
