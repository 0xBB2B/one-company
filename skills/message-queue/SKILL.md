---
name: message-queue
description: 消息队列（Kafka、RabbitMQ）排查清单：重复消费与幂等、offset 与 ack 时机、生产者可靠性、Outbox 双写、顺序、死信、消费者再均衡、持久化与权限配置。
---
# 消息队列排查清单

## 重复消费与幂等
### 1. 消费者假设每条消息只来一次
- 问题：Kafka 和 RabbitMQ 在常见配置下都是至少一次投递：消费者崩溃、重启、再均衡（消费组成员变化时，分区在消费者之间重新分配，已读未提交的消息会被重新读取）、网络超时重发，都会让同一条消息被处理两次以上。
- 怎么认出：消费处理函数里直接做扣款、发券、加库存、发通知这类有副作用的操作，没有判断"这条消息是否已处理"。
- 修法：处理逻辑做成幂等（重复执行结果与执行一次相同）：用业务唯一键（订单号加事件类型）建唯一索引，重复就跳过；或者把更新写成"设为某值"而不是"加上某值"。
- 出处：https://www.rabbitmq.com/docs/reliability#consumer-side https://kafka.apache.org/43/design/design/#message-delivery-semantics

### 2. 已处理消息的记录和业务改动不在同一个事务里
- 问题：先处理业务、后记录"已处理"，两步之间崩溃就会重复处理；先记录、后处理，崩溃则这条消息再也不会被处理。
- 怎么认出：去重表或 Redis 里写入消息 ID 的代码，和业务写库不在同一个数据库事务里；去重记录用的是另一个存储。
- 修法：把"插入已处理消息 ID（唯一约束）"和业务改动放在同一个数据库事务里提交；插入冲突就说明处理过，直接确认消息；去重记录定期清理，保留期要长于消息可能重发的时间。
- 出处：https://kafka.apache.org/43/design/design/#message-delivery-semantics https://microservices.io/patterns/communication-style/idempotent-consumer.html 二手资料（模式作者的整理，Kafka 文档只给出了“把 offset 和输出存在同一个地方”的思路）

### 3. 拿 offset 或消息位置当去重用的消息 ID
- 问题：offset 只在同一个分区内有意义，换分区、重建 topic、数据迁移或重放后会变，不同分区的 offset 还会重复，用它去重会误判或漏判。
- 怎么认出：去重键由 `topic:offset`、`partition:offset` 拼成；消息体里没有业务自带的唯一 ID。
- 修法：生产者在消息里带唯一 ID（业务主键加事件类型，或随机生成的 UUID）；消费者按这个 ID 去重；offset 只用于提交进度。
- 出处：https://kafka.apache.org/43/implementation/log/

## 确认与提交时机
### 4. Kafka 自动提交 offset，处理还没完成就被提交
- 问题：`enable.auto.commit=true` 时 offset 按时间间隔自动提交，不看消息是否处理完。处理到一半崩溃，已提交的 offset 之前的消息就丢了。
- 怎么认出：消费者配置里 `enable.auto.commit` 为 `true`（默认值）；处理逻辑在另一个线程里异步执行。
- 修法：改成 `enable.auto.commit=false`，处理成功（业务事务已提交）后再手动 `commitSync`；用线程池异步处理时，只提交已经完成的最小 offset。
- 出处：https://kafka.apache.org/43/configuration/consumer-configs/#consumerconfigs_enable.auto.commit

### 5. 处理失败了，异常被吞掉后仍然提交 offset 或 ack
- 问题：`try/catch` 捕获异常后只打日志，接着正常提交 offset，这条消息就被当成已处理，实际上业务没有完成，消息永久丢失。
- 怎么认出：消费回调里 `catch` 块为空或只有日志，后面是 `ack`、`commit` 或框架的自动确认；没有把失败的消息送去重试或死信。
- 修法：失败时不提交、不确认，让消息重试；超过重试次数后送入死信队列（专门存放处理不了的消息的队列，之后人工检查或重放）并告警。
- 出处：https://www.rabbitmq.com/docs/confirms

### 6. RabbitMQ 使用自动确认
- 问题：自动确认模式下，消息一发给消费者就算送达，消费者崩溃或处理失败时，消息就丢了。
- 怎么认出：`basicConsume` 的 `autoAck=true`；Spring AMQP 里 `acknowledge-mode: none`。
- 修法：使用手动确认，处理完成后再 `basicAck`；处理失败用 `basicNack`；并设置 prefetch，限制未确认消息的数量。
- 出处：https://www.rabbitmq.com/docs/confirms#acknowledgement-modes

### 7. 失败后无限制地重新入队，毒消息循环
- 问题：一条永远处理失败的消息（格式错误、数据缺失）被 `nack` 并重新入队，立刻又被取回，占满消费者，后面的消息得不到处理。
- 怎么认出：`basicNack(..., requeue=true)` 或 `basicReject(..., true)` 没有次数限制；日志里同一个消息 ID 一直重复出现。
- 修法：限制重试次数（RabbitMQ 仲裁队列的投递次数上限 `x-delivery-limit` 在 4.0 起默认为 20，超过后丢弃或进入死信交换机）；确定无法处理的错误直接 `requeue=false`，进入死信。
- 出处：https://www.rabbitmq.com/docs/confirms#consumer-nacks-requeue https://www.rabbitmq.com/docs/quorum-queues

### 8. 处理失败的消息没有出口（无限重试或直接丢弃）
- 问题：既不能处理又不能跳过的消息，要么卡住整个分区或队列，要么被悄悄丢掉，没人知道。
- 怎么认出：消费循环里对失败消息 `while` 重试、`sleep` 后再试，没有次数上限；队列声明里没有 `x-dead-letter-exchange`；Kafka 没有对应的失败 topic。
- 修法：设置有限的重试次数，之后把消息连同错误原因送进死信队列（专门存放处理不了的消息的队列；RabbitMQ 用死信交换机；Kafka 把消息写到单独的 `<topic>.dlq`，然后提交 offset）；对死信队列的堆积设告警，并提供重放工具。
- 出处：https://www.rabbitmq.com/docs/dlx

## 生产者可靠性与双写
### 9. 先写数据库再发消息（或反过来），两边会不一致
- 问题：数据库提交成功后进程崩溃，消息没发出去；或者消息发出去了，事务却回滚了。数据库和消息队列无法放进同一个事务。
- 怎么认出：同一个业务函数里先 `commit` 再 `producer.send`（或先发再提交），没有补偿；发送失败只打日志。
- 修法：用 Outbox（发件箱）模式：业务数据和待发送消息写在同一个数据库事务的 outbox 表里，由另一个进程（轮询或读取数据库日志）把 outbox 里的消息发送出去并标记；发送是至少一次，所以消费端仍要做幂等：用业务唯一键去重，并和业务改动放在同一个事务里。
- 出处：https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html

### 10. Kafka 生产者的确认级别太低
- 问题：`acks=0` 或 `acks=1` 时，leader 刚收到消息就返回成功，leader 随后宕机而副本还没同步，这条消息就丢了；发送失败的异步回调没人看也会丢。
- 怎么认出：生产者配置 `acks=1`、`acks=0`；`send()` 没有传回调，也不检查 future；`retries=0`。
- 修法：重要消息用 `acks=all`，配合 `enable.idempotence=true`（新版本 Kafka 默认开启，以所用版本的文档为准，较老版本需要显式设置）；在回调里处理失败，记录并重试；设置合理的 `delivery.timeout.ms`。
- 出处：https://kafka.apache.org/43/configuration/producer-configs/#producerconfigs_acks

### 11. topic 只有一个副本
- 问题：只有一个副本，所在节点故障就丢数据。
- 怎么认出：本次改动涉及 topic 创建脚本、Helm 或 Terraform 时：`replication.factor=1`。
- 修法：生产环境 topic 的 `replication.factor` 设为 3，让单个节点故障时数据仍在。
- 出处：https://kafka.apache.org/43/design/design/

### 12. acks=all 没有配 min.insync.replicas
- 问题：`acks=all` 只要求"当前在同步的副本"都确认。同步副本只剩 leader 时，它一个确认就通过，等于只有一份数据。
- 怎么认出：生产者用 `acks=all`，而 broker 或 topic 没有设置 `min.insync.replicas`（或设为 1）。
- 修法：副本数为 3 时设 `min.insync.replicas=2`，配合 `acks=all`，这样挂一个节点仍可写，同时不丢已确认的消息。
- 出处：https://kafka.apache.org/43/configuration/broker-configs/#brokerconfigs_min.insync.replicas https://kafka.apache.org/43/configuration/producer-configs/#producerconfigs_acks

### 13. RabbitMQ 发布者不使用确认
- 问题：发布者发出消息后不知道 broker 是否收到，网络或 broker 故障时消息悄悄丢失；即使有确认，也可能因为确认丢失而重发，所以消费端仍要幂等。
- 怎么认出：发布代码里没有开启 publisher confirms（`confirmSelect`、`publisher-confirm-type`）；发布后不等 `basic.ack`，也不处理 `basic.nack`。
- 修法：开启 publisher confirms，收到 ack 才认为发送成功，收到 nack 或超时就重发并记录；需要知道消息有没有被路由到队列时，加上 mandatory 标志。
- 出处：https://www.rabbitmq.com/docs/confirms#publisher-confirms

### 14. RabbitMQ 队列和消息没有持久化
- 问题：队列不是 durable，或消息不是 persistent 时，broker 重启后队列和消息会消失。
- 怎么认出：声明队列时 `durable=false`；发布消息没有 `delivery_mode=2`（persistent）。
- 修法：队列声明为 durable，消息标记为 persistent；需要多副本的队列用仲裁队列（Quorum Queue）。
- 出处：https://www.rabbitmq.com/docs/queues#durability https://www.rabbitmq.com/docs/publishers#message-properties https://www.rabbitmq.com/docs/quorum-queues

### 15. 使用已经被移除的经典队列镜像（RabbitMQ 4.0 起）
- 问题：经典队列镜像在 RabbitMQ 4.0 中被移除，配置了镜像策略的部署升级后高可用配置失效。
- 怎么认出：部署里有 `ha-mode`、`ha-sync-mode` 的 policy；队列声明里没有 `x-queue-type: quorum`。
- 修法：新队列声明为 `x-queue-type: quorum`；旧部署在升级到 4.0 之前，先把队列迁移到仲裁队列。
- 出处：https://www.rabbitmq.com/docs/quorum-queues

## 顺序
### 16. 需要保序的消息没有按 key 分区
- 问题：Kafka 只保证同一个分区内有序。同一个订单的"创建、支付、发货"事件如果分散到不同分区，消费者可能先收到"发货"。
- 怎么认出：`producer.send` 没有传 key，或 key 是随机值、时间戳；需要顺序的业务（同一用户、同一订单）却用了多个分区、多个并发消费者。
- 修法：用业务主键（订单 ID、用户 ID）作为消息 key，让同一个 key 的消息进入同一分区；一个分区只由组内一个消费者处理；消费者内部再并发时，同一个 key 要落在同一个线程。
- 出处：https://kafka.apache.org/43/getting-started/introduction/#main-concepts-and-terminology

### 17. 上线后增加 topic 的分区数，打乱了 key 与分区的对应
- 问题：增加分区后，同一个 key 之后会被映射到新的分区，新旧消息分在两个分区，正在依赖顺序的消费者会读到乱序数据。
- 怎么认出：运维脚本或 Terraform 里对已有 topic 修改 `partitions`；该 topic 的消息依赖按 key 的顺序。
- 修法：需要保序的 topic 在创建时就预留足够的分区数；确实要扩容时，排空旧消息后再切换，或新建 topic 迁移。
- 出处：https://kafka.apache.org/43/operations/basic-kafka-operations/#modifying-topics

### 18. 开启重试但没有幂等，生产者并发请求造成乱序
- 问题：生产者同时发出多个批次，前一个批次失败重试时，后一个批次已经成功，消息在分区里的顺序变了。
- 怎么认出：`max.in.flight.requests.per.connection` 大于 1（默认值是 5），同时 `enable.idempotence=false`，且开启了重试。
- 修法：开启 `enable.idempotence=true`（开启后 in-flight 不超过 5 仍能保序）；需要保序又不想开幂等时，把 `max.in.flight.requests.per.connection` 设为 1。
- 出处：https://kafka.apache.org/43/configuration/producer-configs/#producerconfigs_max.in.flight.requests.per.connection

## 消费者运行
### 19. 消费一批消息的处理时间超过 max.poll.interval.ms
- 问题：消费者两次 `poll` 的间隔超过 `max.poll.interval.ms`（默认 5 分钟），会被认为已经失联，被踢出消费组并触发再均衡，没提交的消息又被重新投递。
- 怎么认出：消费循环里同步调用慢接口、做大批量写库；`max.poll.records` 保持默认的 500 而每条处理很慢；日志里反复出现 rebalance 和 "member was removed"。
- 修法：减小 `max.poll.records`；让单批处理时间远小于 `max.poll.interval.ms`；慢操作放到线程池，主线程继续 `poll` 并对分区调用 `pause`/`resume`；处理要幂等。
- 出处：https://kafka.apache.org/43/configuration/consumer-configs/#consumerconfigs_max.poll.interval.ms

### 20. RabbitMQ 消费者没有设置 prefetch
- 问题：prefetch 是消费者可以同时持有的未确认消息数，设成 0 表示不限。不限时消息积压会把消费者内存撑爆，多个消费者之间负载也不均。消费者不设时，服务端可以用 `rabbit.default_consumer_prefetch` 配一个默认值。
- 怎么认出：消费者代码里没有 `basicQos` / `prefetchCount`；使用手动确认却没有显式配置 prefetch 的客户端或框架。
- 修法：消费者显式设置 prefetch（`basicQos(n)`，n 大于 0），按单条处理耗时调整，耗时长的任务设更小的值，保证消息被公平分配；也可以在服务端配置 `default_consumer_prefetch` 作为默认值。
- 出处：https://www.rabbitmq.com/docs/consumer-prefetch

### 21. 消息体过大
- 问题：Kafka 默认单条消息上限约 1 MB，超过会发送失败；大消息还会拖慢整个分区的读写。
- 怎么认出：消息里带整个文件、图片的 base64 或大 JSON 数组；调大 `message.max.bytes`、`max.request.size`、`fetch.max.bytes` 的配置改动。
- 修法：大内容存对象存储，消息里只放引用（地址和摘要）；消息体保持在几十 KB 以内。
- 出处：https://kafka.apache.org/43/configuration/broker-configs/#brokerconfigs_message.max.bytes

### 22. 消息格式变更不兼容，老消费者解析失败
- 问题：生产者改了字段名或类型，线上还在运行的老消费者反序列化失败，失败消息又卡住分区。
- 怎么认出：消息定义里删除或重命名字段、修改字段类型；消费者用严格模式反序列化，遇到未知字段就抛异常。
- 修法：只做向后兼容的变更（新增可选字段、不删字段、不改类型）；消费者忽略未知字段；使用 schema 注册表在发布前检查兼容性。
- 出处：https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html

## 集群配置
### 23. 生产环境开启自动创建 topic
- 问题：`auto.create.topics.enable=true` 时，生产者或消费者写错 topic 名，Kafka 会按默认配置悄悄建一个新 topic，消息发到没人消费的地方。
- 怎么认出：broker 配置或 Helm values 里 `auto.create.topics.enable=true`（Apache Kafka 的默认值是 true）。
- 修法：生产环境设为 `false`，topic 由基础设施代码统一创建，明确分区数和副本数。
- 出处：https://kafka.apache.org/43/configuration/broker-configs/#brokerconfigs_auto.create.topics.enable

### 24. broker 使用明文监听，没有认证和授权
- 问题：`PLAINTEXT` 监听器没有认证、没有加密，网络内任何人可以读写所有 topic。
- 怎么认出：本次改动涉及 broker 配置、Helm 或 IaC 时：`listeners=PLAINTEXT://...`；没有 `authorizer.class.name`；RabbitMQ 保留默认的 `guest` 账号（密码也是 guest），或为了远程连接去掉了 guest 只能本机登录的限制。
- 修法：Kafka 使用 `SASL_SSL` 监听并开启 ACL，按应用分配 topic 的读写权限；RabbitMQ 新建账号并删除 guest（或至少改掉它的密码），为每个应用单独建账号并限定 vhost 权限。
- 出处：https://kafka.apache.org/43/security/listener-configuration/ https://kafka.apache.org/43/security/authorization-and-acls/ https://www.rabbitmq.com/docs/access-control

### 25. RabbitMQ 队列没有长度上限
- 问题：消费者停了或变慢时，队列无限积压，占满 broker 的内存和磁盘，影响所有使用它的应用。
- 怎么认出：声明队列时没有 `x-max-length`、`x-max-length-bytes`，也没有消息 TTL；没有对队列深度的告警。
- 修法：按业务能容忍的积压量设置 `x-max-length` 或 `x-max-length-bytes`，并选定溢出方式（`drop-head` 是默认值，会丢最老的消息；要拒绝新消息用 `reject-publish`）；为队列深度设告警。
- 出处：https://www.rabbitmq.com/docs/maxlength
