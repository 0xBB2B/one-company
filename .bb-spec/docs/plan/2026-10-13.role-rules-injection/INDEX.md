# role-rules-injection 实施计划

## 阶段 1：规矩注入与保护
- [role-rules-injection](01-role-rules-injection.md) — 各职责的流程规矩挪进包内 role-rules 目录，由程序按职责注入；四个内置定义正文清空并带空 skills、mcp
- [settings-protection](02-settings-protection.md) — 项目里和用户层的 pi 设置文件不能被子代理改动

## 阶段 2：设定
- [agent-settings-store](03-agent-settings-store.md) — 读写 pi 设置文件 one-company 字段，分层取值，写错列为问题
- [settings-tab-ui](04-settings-tab-ui.md) — /one:agents 最右边的设定栏 [依赖: agent-settings-store]
- [settings-resolution](05-settings-resolution.md) — PM 与内部代理改按设定取模型，删掉它们的定义文件 [依赖: agent-settings-store, settings-tab-ui, role-rules-injection]

## 阶段 3：页面收尾
- [definition-tabs](06-definition-tabs.md) — 去掉 pm 栏、所有定义可改名复制、详情新增正文一行 [依赖: settings-resolution]
