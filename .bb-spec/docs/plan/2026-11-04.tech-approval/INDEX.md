# tech-approval 实施计划
## 阶段 1：窗口排版
- [01-window-layout](01-window-layout.md) — 问答窗口支持分段着色、固定问题、其他行说明、Esc 单独一行，新增技术清单窗口入口
## 阶段 2：格式与流程
- [02-tech-list-format](02-tech-list-format.md) — 技术清单参数、检查、记录与原话文字、窗口内容、对话问答块 [依赖: 01-window-layout]
- [03-tech-ask-flows](03-tech-ask-flows.md) — ask-tech 两种用法、面板同意后登记调整并等新版本 [依赖: 02-tech-list-format]
## 阶段 3：规矩与验收
- [04-prompts](04-prompts.md) — 主代理、需求文档规范、PM、worker、审查规矩和报错文字 [依赖: 03-tech-ask-flows]
- [05-acceptance-p18](05-acceptance-p18.md) — 真实模型单点 P18 与文档里的单点范围 [依赖: 04-prompts]
