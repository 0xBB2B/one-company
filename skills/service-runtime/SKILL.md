---
name: service-runtime
description: 后端服务运行时排查清单：超时预算、重试与退避、幂等键、熔断与限流、优雅停机、健康检查、容器资源、定时任务与本地状态、日志脱敏与密钥管理。
---
# 服务运行时排查清单

## 超时与重试
### 1. 服务间调用没有统一的超时预算
- 问题：每一层各设各的超时，上游已经放弃了，下游还在继续干活；或者下游超时比上游更长，上游超时后的重试把下游压垮。
- 怎么认出：跨进程调用（HTTP、RPC、数据库、缓存、消息）没有显式超时；调用链上每个服务的超时是互相独立的固定数字；下游调用没有传递上游剩下的截止时间。
- 修法：所有跨进程调用都设超时。入口定总时限，逐层往下传递截止时间（gRPC 的 deadline 就是这个机制），下游超时必须小于上游剩余时间；超时后取消下游工作。
- 出处：https://grpc.io/docs/guides/deadlines/

### 2. 应用的空闲连接超时短于负载均衡的空闲超时
- 问题：负载均衡复用连接，应用已经先关掉空闲连接，负载均衡下一个请求发到已关闭的连接上，出现偶发的 502。
- 怎么认出：本次改动涉及 Deployment、Dockerfile、IaC、CI 配置等文件时：应用服务器的 Keep-Alive 超时（Node.js 的 `server.keepAliveTimeout` 默认 5 秒）小于 ALB 等负载均衡的空闲超时（ALB 默认 60 秒）；日志里偶发 502 又没有应用错误。
- 修法：应用的 Keep-Alive 超时设成大于负载均衡的空闲超时（例如 ALB 60 秒，应用设 65 秒以上）。
- 出处：https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html#connection-idle-timeout

### 3. 重试在多层同时进行，放大下游压力
- 问题：网关重试 3 次，服务 A 重试 3 次，服务 B 又重试 3 次，一次用户请求最多变成 27 次对最底层的调用，原本能恢复的故障被重试放大成雪崩。
- 怎么认出：网关、服务网格、SDK、业务代码里都配置了重试；调用链超过两层且每层都有重试。
- 修法：重试只在一层做，通常是最靠近调用方的那一层；其他层关闭自动重试或只上报错误；梳理调用链上全部重试配置。
- 出处：https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter

### 4. 重试没有指数退避和随机抖动
- 问题：失败后立刻或固定间隔重试，所有客户端在同一时刻再次涌向刚恢复的服务，把它再次压垮。
- 怎么认出：重试循环里 `sleep(1)` 或没有等待；退避有指数增长，但没有随机数。
- 修法：等待时间 = 随机(0, min(上限, 基础 × 2^次数))（即"完全抖动"）；基础值 100 毫秒起，上限几秒，次数不超过 3 到 5 次。
- 出处：https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/

### 5. 重试没有预算，故障期间流量成倍增加
- 问题：下游整体变慢时，每个请求都重试，调用方实际发出的请求量翻几倍，故障更严重。
- 怎么认出：重试只有"每个请求最多 N 次"的限制，没有全局的限额；没有按比例限制重试的机制。
- 修法：设重试预算，限定一段时间内允许的重试总量（例如每个进程每分钟 60 次，或不超过总请求量的 10%），用完就直接失败，不继续重试；gRPC 用 `retryThrottling`；也可以结合熔断。
- 出处：https://sre.google/sre-book/addressing-cascading-failures/ https://grpc.io/docs/guides/retry/

### 6. 重试了不该重试的错误，或不等 Retry-After 就重试
- 问题：对 400、401、404 这类重试没有意义，只会增加负载；对 429、503 这类带有"请稍后再来"含义的响应立即重试，则会加重对方的负担。
- 怎么认出：重试条件是"任何异常"或"状态码不是 200"；对 429、503 响应不看 `Retry-After` 就立刻重试。
- 修法：只重试临时性错误：连接失败、超时、502、503、504、429；使用响应的 `Retry-After` 作为最短等待时间；POST 这类非幂等请求不要盲目重试，除非请求带有幂等键（服务端能识别并忽略重复请求）。
- 出处：https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2 https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3

### 7. 非幂等的写操作没有幂等键
- 问题：用户重复点击、网关重试或客户端超时重发，都会让创建订单、扣款、发券执行多次。
- 怎么认出：`POST /orders`、`POST /payments` 这类接口，请求里没有幂等键（`Idempotency-Key` 之类），服务端没有"同一个键只执行一次"的记录。
- 修法：客户端对每个业务动作生成唯一键并随请求发送；服务端在数据库里用唯一约束记录键和处理结果，相同键直接返回第一次的结果；键相同但参数不同则拒绝；记录保留 24 小时以上。
- 出处：https://docs.stripe.com/api/idempotent_requests

### 8. 下游持续故障时没有熔断
- 问题：下游已经挂了，调用方仍然每个请求都去试并等到超时，线程、连接被占满，调用方自己也跟着不可用。
- 怎么认出：调用下游的客户端没有熔断器，也没有舱壁隔离（给每个下游划出独立的并发额度，一个下游出问题不会占满全部线程或连接）；所有下游共用同一个连接池或线程池。
- 修法：给每个下游加熔断器：错误率或慢调用比例超过阈值就快速失败一段时间，再放少量请求试探恢复；不同下游使用独立的并发上限；熔断时返回降级结果或明确的错误。
- 出处：https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker

### 9. 入口没有限流和过载保护
- 问题：流量突增或某个调用方出错时，服务来者不拒，把资源耗尽，正常用户也被拖垮。
- 怎么认出：网关、服务入口没有限流配置；没有并发上限；队列无界；过载时依然接收所有请求。
- 修法：入口按调用方设限流（令牌桶或漏桶），超出直接返回 `429` 并带 `Retry-After`；设置最大并发数，过载时主动拒绝低优先级请求；限流值要结合压测结果设定。
- 出处：https://sre.google/sre-book/handling-overload/ https://www.rfc-editor.org/rfc/rfc6585.html#section-4

## 进程生命周期
### 10. 容器里的应用收不到 SIGTERM
- 问题：容器停止时先给主进程发 SIGTERM。如果 Dockerfile 用 shell 形式启动，主进程是 `sh`，信号到不了应用，过了宽限期被强杀，正在处理的请求全部中断。
- 怎么认出：本次改动涉及 Deployment、Dockerfile、IaC、CI 配置等文件时：Dockerfile 里 `CMD npm start`、`ENTRYPOINT ./start.sh`、`CMD ["sh", "-c", "..."]`，而脚本里没有用 `exec` 启动应用。
- 修法：用 exec 形式：`CMD ["node", "server.js"]`；启动脚本最后一行写 `exec 应用命令`；应用本身要处理 SIGTERM。
- 出处：https://docs.docker.com/reference/dockerfile/#entrypoint https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/

### 11. 收到 SIGTERM 后直接退出，没有排空在途请求
- 问题：滚动发布时，旧实例收到 SIGTERM 立即退出，正在处理的请求被中断，用户看到错误；负载均衡还没来得及摘除它，新请求也会失败。
- 怎么认出：代码里没有 SIGTERM 处理；或者处理里直接 `exit`；Kubernetes 的 `terminationGracePeriodSeconds` 保持默认的 30 秒，而最慢请求超过这个时间；没有 `preStop`。
- 修法：收到 SIGTERM 后，先让就绪探针失败，停止接收新请求，等在途请求完成（设最长等待时间），再关闭连接池、提交消费进度，最后退出；`terminationGracePeriodSeconds`（默认 30 秒）要大于这个总时间。
- 出处：https://12factor.net/disposability https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/

### 12. 存活探针依赖外部服务
- 问题：存活探针失败会让容器被重启。如果探针检查数据库，数据库一抖动，所有实例同时被重启，故障扩大。
- 怎么认出：本次改动涉及 Deployment、Dockerfile、IaC、CI 配置等文件时：`livenessProbe` 指向的健康检查接口里会查数据库、缓存或下游接口。
- 修法：存活探针只检查进程自己是否卡死，不查外部依赖；依赖是否可用放在就绪探针里（失败只是暂时不接流量）。
- 出处：https://kubernetes.io/docs/concepts/workloads/pods/probes/

### 13. 启动慢的服务没有启动探针或就绪探针
- 问题：没有就绪探针，实例还没加载完就接入流量，出现一批错误；存活探针在启动阶段就开始检查，把还没起来的实例杀掉重启，反复循环。
- 怎么认出：本次改动涉及 Deployment、Dockerfile、IaC、CI 配置等文件时：Deployment 里没有 `readinessProbe`；`livenessProbe` 的 `initialDelaySeconds` 小于应用实际启动时间；没有 `startupProbe`。
- 修法：加上 `readinessProbe`，应用完成预热才返回成功；慢启动的应用加 `startupProbe`，探测通过之前不执行存活检查。
- 出处：https://kubernetes.io/docs/concepts/workloads/pods/probes/

### 14. 容器没有设置资源请求和限制
- 问题：没有内存限制时，一个实例内存泄漏会拖垮整台节点；没有请求值时，调度器无法合理分配，同一节点上被塞入太多实例。
- 怎么认出：本次改动涉及 Deployment、Dockerfile、IaC、CI 配置等文件时：Deployment 或 Pod 配置里没有 `resources.requests` 和 `resources.limits`。
- 修法：设置内存的 requests 和 limits（通常相等），CPU 设 requests；运行时的堆大小要小于容器内存限制并留出余量；根据监控数据调整。
- 出处：https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/

### 15. 定时任务在每个副本上都执行
- 问题：应用里写了定时任务，部署 3 个副本就会同时执行 3 次，重复发送通知、重复扣款。
- 怎么认出：本次改动新增了调度代码，或改了部署副本数时：应用内使用 `cron`、`@Scheduled`、`setInterval` 等调度库，同时部署配置里 `replicas` 大于 1，没有分布式锁。
- 修法：把定时任务拆成独立的 Kubernetes CronJob，并设置 `concurrencyPolicy: Forbid`；或在应用内抢占式加锁，保证同一时刻只有一个副本执行；任务本身也要幂等。
- 出处：https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/

### 16. 状态只放在进程内存或本地磁盘
- 问题：会话、上传的文件、限流计数、任务进度放在单个实例的内存或磁盘里，扩容后请求落到另一个实例就读不到，重启后数据丢失。
- 怎么认出：代码里用进程内的 map 保存会话；上传文件写到容器本地路径；部署为多副本，没有挂载共享存储。
- 修法：需要共享的状态放进外部存储（数据库、Redis、对象存储）；应用进程保持无状态，能随时被替换和重启。
- 出处：https://12factor.net/processes

### 17. 容器以 root 身份运行
- 问题：应用被攻破时，攻击者拥有容器内的 root 权限，逃逸到宿主机的风险更高。
- 怎么认出：本次改动涉及 Deployment、Dockerfile、IaC、CI 配置等文件时：Dockerfile 没有 `USER` 指令；Pod 的 `securityContext` 里没有 `runAsNonRoot: true`；设置了 `privileged: true`。
- 修法：Dockerfile 里创建普通用户并 `USER app`；Pod 设置 `runAsNonRoot: true`、`allowPrivilegeEscalation: false`，根文件系统只读，不开 `privileged`。
- 出处：https://kubernetes.io/docs/concepts/security/pod-security-standards/

### 18. 停机时后台任务或消费者被中途杀掉
- 问题：消息消费者、队列 worker 正在处理一条任务时收到 SIGTERM 直接退出，任务既没完成也没归还，丢失或卡住。
- 怎么认出：worker 的 SIGTERM 处理里直接 `exit`；没有"停止拉取新任务、处理完当前任务"的逻辑；任务取走后才确认，却没有在退出前 nack 或归还。
- 修法：收到 SIGTERM 后先停止拉取新任务，再处理完手头任务；来不及完成就把任务退回队列（比如 RabbitMQ 发 NACK）；`terminationGracePeriodSeconds` 要覆盖最长一条任务的处理时间。
- 出处：https://12factor.net/disposability

### 19. 多副本服务没有 PodDisruptionBudget
- 问题：PodDisruptionBudget（简称 PDB，规定同一服务最多允许同时被主动驱逐多少个副本）缺失时，节点维护、集群升级时，Kubernetes 可能同时驱逐同一服务的多个副本，服务短时间内没有可用实例。
- 怎么认出：本次改动涉及 Deployment、Dockerfile、IaC、CI 配置等文件时：`replicas` 大于 1 的 Deployment，仓库里没有对应的 `PodDisruptionBudget`；关键服务 `replicas: 1`。
- 修法：为无状态服务加 PDB，例如 `minAvailable: 90%`；关键服务至少 2 个副本；单副本又不能中断的有状态服务，要为维护安排专门的操作流程。
- 出处：https://kubernetes.io/docs/tasks/run-application/configure-pdb/

### 20. 多个副本可能被调度到同一个节点
- 问题：3 个副本都落在同一台节点上，这台节点故障时整个服务一起下线，多副本没有起到容灾作用。
- 怎么认出：本次改动涉及 Deployment、Dockerfile、IaC、CI 配置等文件时：Deployment 里 `replicas` 大于 1，却没有 `topologySpreadConstraints`，也没有反亲和配置（podAntiAffinity，声明同一服务的副本不要放在同一个节点上）。
- 修法：加 `topologySpreadConstraints`，以 `kubernetes.io/hostname` 和可用区标签为拓扑键，`maxSkew: 1`，`whenUnsatisfiable` 按容忍度选 `DoNotSchedule` 或 `ScheduleAnyway`。
- 出处：https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/

## 日志与密钥
### 21. 日志没有统一的脱敏机制
- 问题：靠每个开发者记得"不要打印密码"并不可靠。整份请求头、请求体、配置对象被写进日志，密码、令牌就会在日志系统里长期留存。
- 怎么认出：日志里整个对象输出（`log(req)`、`log(config)`、`log(headers)`）；请求日志中间件记录完整的 `Authorization`、`Cookie`、请求体；没有日志库层面的字段过滤配置。
- 修法：在日志库里统一配置脱敏过滤器，按字段名（`password`、`token`、`authorization`、`cookie`、`secret`、`card`）把值替换成 `***`；请求日志只记录白名单字段；日志系统限制访问权限和保留期。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html

### 22. 密钥写进了代码仓库
- 问题：密钥一旦进入 git 历史，所有能读仓库的人都拿到了它，删除提交也无法撤回。
- 怎么认出：代码或配置里有 `password=`、`api_key=`、`AKIA...` 开头的字符串；被提交的 `.env`、`application-prod.yml`；测试素材里放着真实密钥。
- 修法：密钥放在密钥管理服务或平台的 Secret 里，运行时通过环境变量或挂载文件注入；`.env` 加入 `.gitignore`；仓库开启密钥扫描；已经提交过的密钥必须立即轮换。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html

### 23. 构建时用 ARG 或 ENV 传入密钥，密钥留在镜像里
- 问题：镜像的每一层都保存在镜像里，用 `ARG`/`ENV` 传入的密钥可以通过 `docker history` 或检查镜像读出来。
- 怎么认出：本次改动涉及 Deployment、Dockerfile、IaC、CI 配置等文件时：Dockerfile 里 `ARG NPM_TOKEN`、`ENV DB_PASSWORD=...`、`RUN echo $TOKEN > ~/.npmrc`；构建命令里 `--build-arg TOKEN=...`。
- 修法：构建时用 `RUN --mount=type=secret,id=npm_token ...` 挂载密钥，它不会留在任何镜像层里；运行时的密钥在容器启动时注入，不打进镜像。
- 出处：https://docs.docker.com/build/building/secrets/

### 24. 同一套密钥在多个环境共用，且从不轮换
- 问题：开发、测试、生产共用一个密钥，开发环境泄露就等于生产泄露；长期不更换，泄露后的有效期没有上限。
- 怎么认出：各环境的配置里数据库密码、签名密钥相同；密钥没有创建时间和负责人记录；没有轮换流程。
- 修法：每个环境、每个服务使用独立的密钥和账号；密钥设有效期并定期轮换（例如 90 天）；代码支持同时接受新旧两个密钥，实现不停机轮换。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html
