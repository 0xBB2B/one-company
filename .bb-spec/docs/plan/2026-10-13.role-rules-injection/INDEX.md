# role-rules-injection 实施计划

## 阶段 1：规矩注入与保护
- [role-rules-injection](01-role-rules-injection.md) — 各职责的流程规矩挪进包内 role-rules 目录，由程序按职责注入；四个内置定义正文清空并带空 skills、mcp
- [settings-protection](02-settings-protection.md) — 项目里和用户层的 pi 设置文件不能被子代理改动

## 阶段 2：设定
- [agent-settings-store](03-agent-settings-store.md) — 读写 pi 设置文件 one-company 字段，分层取值，写错列为问题
- [settings-tab-ui](04-settings-tab-ui.md) — /one:agents 最右边的设定栏 [依赖: agent-settings-store]
- [follow-main-defaults](05-follow-main-defaults.md) — 默认跟随主窗口的模型和思考等级，思考等级可选跟随 [依赖: settings-tab-ui]
- [settings-resolution](06-settings-resolution.md) — PM 与内部代理改按设定取模型，删掉它们的定义文件 [依赖: follow-main-defaults, role-rules-injection]

## 阶段 3：页面收尾与解释器
- [definition-tabs](07-definition-tabs.md) — 去掉 pm 栏、所有定义可改名复制、详情新增正文一行 [依赖: settings-resolution]
- [interpreter-no-timeout](08-interpreter-no-timeout.md) — 去掉解释器 120 秒时限
