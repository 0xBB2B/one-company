# one-setting 实施计划
## 阶段 1：设置文件
- [settings-storage](01-settings-storage.md) — 设置文件支持 git-delivery 开关的读、写、清除与写错检查
## 阶段 2：界面与工具
- [settings-page-view](02-settings-page-view.md) — 设置页视图：目录 + 右栏、窄终端轮流显示 [依赖: settings-storage]
- [git-delivery-tool](03-git-delivery-tool.md) — 交付工具按设置文件开关，删 /one:git-delivery [依赖: settings-storage]
## 阶段 3：接线
- [settings-command](04-settings-command.md) — 注册 /one:setting、删 /one:agents、落盘与工具刷新、文字与 README [依赖: settings-page-view, git-delivery-tool]
