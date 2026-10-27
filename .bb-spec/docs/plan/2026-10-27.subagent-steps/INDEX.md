# subagent-steps 实施计划
## 阶段 1：守护进程
- [step-recording](01-step-recording.md) — 子代理会话报出工具调用，步骤簿按运行记下每一步的文字和状态
- [steps-method](02-steps-method.md) — 新增 runs.steps 方法，面板概览行带运行编号 [依赖: step-recording]
## 阶段 2：主窗口
- [step-window](03-step-window.md) — 步骤窗口的渲染、滚动、定时刷新和各种状态 [依赖: steps-method]
- [panel-select](04-panel-select.md) — 面板子代理行可选中，回车打开步骤窗口 [依赖: step-window]
