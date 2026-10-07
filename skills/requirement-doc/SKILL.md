---
name: requirement-doc
description: 需求文档规范：规定需求正文的板块与写法。主会话写需求草稿时由框架自动注入，不必手动加载。
disable-model-invocation: true
sections:
  - { id: background, title: 背景 }
  - { id: requirements, title: 需求 }
  - { id: features, title: 功能, goal: true }
  - { id: implementation, title: 实现, record: implementation }
  - { id: acceptance, title: 验收, record: acceptance }
---
- 背景：用户说过的为什么做、谁用、现状问题；用户没说就写"用户未说明"，不自己编。
- 需求：目标、不做什么、约束。未决问题写成本板块下单独的三级小节，如 `### 未决问题 {#requirements.open}`，不和已确定的要求写在同一段：批准时每一段只能整段确认或整段待定。
- 功能：按场景分三级小节写行为，小节编号以 `features.` 开头，如 `### 地面快跑 {#features.sprint}`；批准并授权实施时，功能板块下已确认的小节都是要实施的目标。
- 实现：只写用户明确提出的实现要求，没有就写"由 PM 规划"；实施步骤、工作区、测试命令和交付流程是 PM 计划的事，不写进草稿。
- 验收：按场景分三级小节写前置条件、操作、可观察结果，如 `### 地面快跑 {#acceptance.sprint}`；用户明确提出的交付要求也写进验收。

每个板块标题下先写一句概述再接小节，每个小节标题下都要有正文。
