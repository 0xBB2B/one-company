# 技术栈专项代理与多角度审查 实施计划

## 阶段 1：skill 内容
- [skills-backend-languages](01-skills-backend-languages.md) — Go、TypeScript、Node、Python、Java 的 8 份 skill 与共用格式检查
- [skills-frontend](02-skills-frontend.md) — Vue、React 的 4 份 skill [依赖: skills-backend-languages]
- [skills-shared-services](03-skills-shared-services.md) — Web/API 安全、认证、供应链和服务类 7 份 skill [依赖: skills-backend-languages]

## 阶段 2：定义与开关
- [stack-definitions](04-stack-definitions.md) — 内置 12 个专项定义与通用定义名单
- [role-rules-texts](05-role-rules-texts.md) — 专项审查规矩、worker 与 PM 规矩的改动 [依赖: stack-definitions]
- [disabled-agents-settings](06-disabled-agents-settings.md) — disabled-agents 的解析、读写与问题提示 [依赖: stack-definitions]
- [settings-page-switch](07-settings-page-switch.md) — 设置页状态列与空格开关 [依赖: stack-definitions, disabled-agents-settings]
- [catalog-dispatch-gating](08-catalog-dispatch-gating.md) — 关闭的定义不进清单、派工拦截 [依赖: disabled-agents-settings]

## 阶段 3：多审查
- [review-plan-fields](09-review-plan-fields.md) — 计划里的专项审查列表、校验、同栈自动挂上、数据库升版本 [依赖: catalog-dispatch-gating]
- [review-round-state](10-review-round-state.md) — 整轮审查的状态流转与计数 [依赖: review-plan-fields]
- [review-round-dispatch](11-review-round-dispatch.md) — 守护进程派出整轮审查、合并意见、整轮汇总 [依赖: role-rules-texts, review-round-state]
- [review-labels-adjudication](12-review-labels-adjudication.md) — 审查卡住时的事项文字与裁决卡片 [依赖: review-round-state]

## 阶段 4：面板
- [overview-task-rows](13-overview-task-rows.md) — 概览任务行数据、运行记录轮数上限、协议版本 4 [依赖: review-round-dispatch, review-labels-adjudication]
- [panel-tree-render](14-panel-tree-render.md) — 面板树状显示与选中顺序 [依赖: overview-task-rows]

## 阶段 5：验收
- [acceptance-p15-p16](15-acceptance-p15-p16.md) — P15（Go）、P16（Vue）真实模型验收 [依赖: skills-frontend, skills-shared-services, stack-definitions, review-round-dispatch]
