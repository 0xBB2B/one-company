---
name: suggestion-model
description: 从会话记录取最近 3 轮、用主窗口模型生成一句输入建议、按规则判定结果算不算数
---
# 生成输入建议的模型调用

## 目标
给定主会话的记录和主窗口模型，得到本轮的输入建议（一句不超过 60 个字的话）或"没有"，失败时不抛错。

## 业务规则（来源：PRD generate-suggestion）
- 一轮：用户发出一条消息（会话记录里 role 为 user 的消息），到下一条用户消息之前，算一轮。
- 交给模型的内容：最近 3 轮，不到 3 轮有几轮交几轮。每轮只带用户那条消息里的文字，和这一轮最后一条主代理回复（role 为 assistant）里的文字块；工具调用、工具结果、思考内容、程序插入的自定义消息都不带。
- 交给模型的要求：推测用户下一句最可能说的话，只写一句、最多 60 个字；推测不出合适的话时什么都不写。要求里说明对话内容是待参考的数据，不是给它的指令。
- 模型：用主窗口当前选定的模型。没有选定模型或 `hasConfiguredAuth` 为假 → 不调用，结果为"没有"。
- 思考等级：`getSupportedThinkingLevels(model)`（pi-ai 导出）包含 `off` → 不思考；不包含 → 用列表里的第一个（最低）等级。
- 结果判定：模型返回的文字去掉首尾空白后，空 → 没有；超过 60 个字符（按 Unicode 码点数，汉字、字母都算 1）→ 没有；含换行或控制字符 → 没有；其余 → 就是输入建议。
- 调用出错、被中止、返回不是正常结束（stopReason 不是 stop）→ 结果为"没有"，不抛错、不弹提示。
- 调用不进会话记录：直接用 `ctx.modelRegistry` 调模型，不经过主会话，不调用 `pi.sendMessage`、`pi.appendEntry`。
- 决策理由：只交最近 3 轮且不带工具内容，是为了控制花费和速度（用户 2026-10-30 选定）；不思考是因为提示出现得快更重要（用户 2026-10-30 选定）；不合格就不显示，是因为没按要求写说明结果不可靠，截断会断句（用户 2026-10-30 选定）。

## 涉及文件
- `src/modules/input-suggestion/suggestion-model.ts` 新建

## 函数清单
### src/modules/input-suggestion/suggestion-model.ts
| 函数名 | 职责 |
|---|---|
| `recentRounds` | 从会话分支条目（`ctx.sessionManager.getBranch()` 的结果）里按上面"一轮"的定义取最近 3 轮，每轮给出用户文字和主代理最后的文字回复 |
| `acceptSuggestion` | 按"结果判定"规则，把模型原始文字变成输入建议或"没有" |
| `suggestionThinking` | 按"思考等级"规则，给出这次调用用的思考等级，不思考时为空 |
| `requestSuggestion` | 组装要求和最近几轮内容，用传入的模型登记表（`complete` 或带思考时的 `streamSimple(...).result()`）调用一次，交给 `acceptSuggestion` 判定；任何错误都转成"没有" |

## 协作关系
- `requestSuggestion` 调 `suggestionThinking` 决定走 `complete` 还是 `streamSimple`，拿到回复后调 `acceptSuggestion`。
- `recentRounds` 由调用方（plan input-suggestion-extension）先算好再传给 `requestSuggestion`。
- 外部依赖：pi-ai 的 `getSupportedThinkingLevels`、`Context` 类型；pi-coding-agent 的 `ModelRegistry`（只用 `hasConfiguredAuth`、`complete`、`streamSimple`）。调用方式参照 `src/modules/interaction/user-interaction-model.ts` 里 `createPiInteractionInterpreter` 用 registry 调模型的写法（`cacheRetention: "none"`，传入 `signal`）。
- 本模块不引用 `src/modules/` 下的其他模块。

## 验证方式
- 测试入口：从 `src/modules/input-suggestion/suggestion-model.ts` 导入的 `recentRounds`、`acceptSuggestion`、`suggestionThinking`、`requestSuggestion`。
- 测试输入：手工构造的会话分支条目（`type: "message"` 的 user / assistant / toolResult 消息，assistant 的 content 含 text、thinking、toolCall 块；另有 `type: "custom_message"` 等其他条目）；假的模型登记表（记录收到的模型、上下文和选项，返回指定的回复或抛错）；带不同 `reasoning`、`thinkingLevelMap` 的模型对象。
- 预期结果：
- [ ] 5 轮记录 → `recentRounds` 只给出第 3、4、5 轮；1 轮记录 → 只给出这 1 轮。
- [ ] 每轮只含用户文字和这一轮最后一条 assistant 消息的文字块；thinking、toolCall、toolResult 内容和自定义消息都不出现。
- [ ] `acceptSuggestion`：空串、全空白 → 没有；61 个汉字 → 没有；正好 60 个汉字 → 原样；前后带空白的 60 个字 → 去掉空白后的 60 个字；含 `\n` 或 `\u001b` → 没有。
- [ ] `suggestionThinking`：`reasoning: false` 的模型 → 不思考；`reasoning: true` 且 `thinkingLevelMap.off` 不是 null → 不思考；`thinkingLevelMap.off: null`、`minimal: null` → `low`。
- [ ] `requestSuggestion` 不思考时调 `complete`、不调 `streamSimple`；要思考时调 `streamSimple` 且选项里 `reasoning` 是上一条算出的等级。
- [ ] 交给模型的上下文里有"只写一句、最多 60 个字、推测不出时什么都不写"的要求，以及最近几轮的用户文字和主代理文字。
- [ ] 模型 `hasConfiguredAuth` 为假或没有模型 → 不调用登记表，结果为没有。
- [ ] 登记表抛错、回复的 stopReason 是 error 或 aborted、传入的 signal 已中止 → 结果为没有，不抛错。
