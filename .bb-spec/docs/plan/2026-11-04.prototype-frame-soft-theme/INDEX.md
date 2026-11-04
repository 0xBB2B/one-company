# prototype-frame-soft-theme 实施计划
## 阶段 1：外框和设计师规矩（可并行）
- [frame-soft-theme](01-frame-soft-theme.md) — 外框柔和明暗配色、右上角明暗和方案切换
- [designer-project-ui](02-designer-project-ui.md) — 设计师先读项目整体布局和样式，新增 P19
## 阶段 2：DESIGN.md
- [design-spec-check](03-design-spec-check.md) — DESIGN.md 十章、必填项、格式、对比度检查
- [design-submit-dispatch](04-design-submit-dispatch.md) — 交稿带 DESIGN.md、派工带上它、库升到 10 [依赖: design-spec-check]
- [design-confirm-write](05-design-confirm-write.md) — 确认窗口提示改了几章、被改过时拦住、通过时写入 [依赖: design-submit-dispatch]
- [design-follow-guard](06-design-follow-guard.md) — worker、reviewer 照它做，代理不能改它 [依赖: design-confirm-write, designer-project-ui]
## 阶段 3：真实模型验收
- [acceptance-design-judgement](07-acceptance-design-judgement.md) — P17、P19 判定加 DESIGN.md [依赖: design-follow-guard]
