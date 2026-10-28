# daemon-auto-replace 实施计划
## 阶段 1：基础能力
- [code-fingerprint](01-code-fingerprint.md) — 算安装目录的代码指纹，得出项目目录名
## 阶段 2：守护进程端
- [daemon-upgrade-methods](02-daemon-upgrade-methods.md) — 记下启动指纹，新增握手前可用的查过旧与让位请求 [依赖: code-fingerprint]
## 阶段 3：窗口端
- [client-upgrade-flow](03-client-upgrade-flow.md) — 连接时查过旧、让位换新、等待重查、旧窗口状态，提示文字与模型错误 [依赖: daemon-upgrade-methods]
- [window-notices](04-window-notices.md) — 提示显示到 pi 终端，Shell 出错前缀改用项目目录名 [依赖: client-upgrade-flow]
