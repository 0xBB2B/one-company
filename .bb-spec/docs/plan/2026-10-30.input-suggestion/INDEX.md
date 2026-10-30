# input-suggestion 实施计划
## 阶段 1：组件（可并行）
- [suggestion-model](01-suggestion-model.md) — 从会话记录取最近 3 轮、用主窗口模型生成一句输入建议、按规则判定结果算不算数
- [suggestion-editor](02-suggestion-editor.md) — 继承 pi 的 CustomEditor，空输入栏时画灰色提示，空输入栏按右方向键填入完整提示
## 阶段 2：接入
- [input-suggestion-extension](03-input-suggestion-extension.md) — 替换输入栏、每轮正常结束后生成、新一轮开始时清掉 [依赖: suggestion-model, suggestion-editor]
