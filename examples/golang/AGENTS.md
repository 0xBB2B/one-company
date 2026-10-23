## 后端设计约定

本项目后端的关键设计决定。PM 规划任务、worker 写代码、审查核对时都按这里执行；和内置 skill 的写法冲突时，以这里为准。

### API
- URL 用复数名词加 kebab-case，路径带版本：`/api/v1/team-members`。URL 里不写动词。
- HTTP 状态码按语义返回，不用 200 包住一切。校验失败返回 400，未登录返回 401，没权限返回 403，触发限流返回 429。
- 单个资源直接返回对象，不用 `data` 包一层。列表返回 `items`、`meta`（分页信息）、`links`（翻页链接）三部分。
- 错误响应的格式是 `{"error": {"code", "message", "details"}}`。
- 错误码 `code` 只能用 `A-BBB-CCCC` 格式：
  - `A` 是错误来源：1 表示用户端，2 表示系统，3 表示第三方。
  - `BBB` 是三位模块号，`CCCC` 是模块内的四位编号。
  - 不允许出现第二套错误码体系。

### 数据库
- 主键由应用层生成 UUIDv7。MySQL 用 `BINARY(16)` 存，PostgreSQL 用 `uuid` 存。不把自增 ID 暴露给外部。
- 软删除用 `deleted BIGINT NOT NULL DEFAULT 0` 这一列，删除时写入 UTC 微秒时间戳。
  - 所有唯一键都要和 `deleted` 组成联合唯一键。
  - 常规查询都要带 `deleted = 0`。
- `created_at`、`updated_at` 由数据库自动维护，应用不写这两列；写入后要回读一次，拿到数据库生成的值。
- 全链路用 UTC 时间；建库建表时显式声明字符集（MySQL 用 `utf8mb4`）。

### Go 代码结构
- 调用链按 handler → service → repository 三层分；另外有 model、dto 包，config、pkg 两个包放在仓库根目录。
- 不引入 manager、facade、adapter、domain、application、controller、usecase 这些层。
- 事务只能在 service 层发起：
  - 跨领域的流程用编排 service，配合 `TxManager.InTx` 开事务。
  - 事务句柄通过 ctx 传递，不作为参数传。
- 默认不建 interface，仓库里已经有 2 个以上实现时才建。类型名不加 Handler、Service 这类后缀。
- 日志统一用 `log/slog`；lint 统一用 golangci-lint，并且和测试放在同一个 test 入口里一起跑。
- 测试文件和实现文件一一对应：有 `foo_test.go` 就必须有 `foo.go`。测试默认写成表格驱动（table-driven），用 `t.Run` 分子测试。

### 服务运行时
- 配置在启动时一次性加载并校验，缺失或非法就直接启动失败。
- 存活检查（liveness）和就绪检查（readiness）分开。
- 收到 SIGTERM 后：先停止接收新请求，再处理完在途请求，超过时限就强制退出。
- 非幂等的写操作支持 `Idempotency-Key`：同一个幂等键的重复请求，返回第一次执行的结果。
- 每个跨进程调用都要设超时，ctx 往下游传递。
- 重试只用于幂等操作，要用指数退避加随机抖动，并设次数上限。
- error 用 `%w` 包装后往上传；只在服务边界把它转换成 `A-BBB-CCCC` 错误码。

### 认证
- access token 用 JWT，有效期 5～15 分钟。
- refresh token 用不透明的随机串，数据库里只存它的哈希：
  - 一个用户的一台设备只占一行，每次刷新在这一行上原地轮换。
  - 超出宽限窗口后有人重放旧 token，就吊销这台设备的会话。
- 密码用 argon2id 哈希；登录失败要限流或锁定。
- Web 端的 token 存在 localStorage。这是本项目的决定，内置 skill 里"token 存 localStorage 会被 XSS 读走"那一条在本项目不算问题。

### 授权
- 默认拒绝：权限数据查不到或判定出错时，一律拒绝。
- 后端对每个敏感操作都单独校验。前端按权限隐藏按钮只是体验优化，不能当作安全边界。
- 授权判定集中在统一的 enforcer 里完成，业务代码里不写 `if role == "admin"` 这样的判断。
- 两级都要查：一是有没有这个权限，二是这条资源是不是属于当前用户。
- 多租户时，`tenant_id` 过滤放在 repository 的默认作用域里，不靠每个 handler 自己加。

### 配置
- 按三类放：
  - 启动时必需、运行中不热更的，放环境变量或 secret。
  - 运维要热更、而且有默认值的，放 yaml 或 configmap。
  - 业务方会改、需要审计的，放数据库并提供后台接口。
- 核心凭据（数据库密码、JWT 签名密钥、主密钥）只能放在 secret 或 KMS 里。
- 热更时新值解析失败，保留旧值并告警，进程不崩溃。

### 可观测性
- 日志、链路、指标统一用 OpenTelemetry，在一处集中装配。
- 日志输出 JSON，每条都带 `service`、`level`、`msg`、`time`、`trace_id`、`span_id`。
- 指标名用 `<domain>_<noun>_<unit>` 格式；label 里不放用户 ID、订单 ID 这类取值无限多的字段。
