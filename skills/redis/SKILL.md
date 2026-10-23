---
name: redis
description: Redis 使用排查清单：缓存穿透、击穿、雪崩、读写不一致，分布式锁（误删、过期、Redlock），大 key 与热 key，危险命令，计数竞态，事务与集群限制，安全暴露与连接配置。
---
# Redis 排查清单

## 缓存的三类故障
### 1. 缓存穿透：查询不存在的数据，每次都打到数据库
- 问题：缓存穿透：请求的 key 在缓存和数据库里都没有，每次都落到数据库。攻击者用随机 ID 就能把数据库压垮。
- 怎么认出：读缓存的代码"缓存没有就查库，库里没有就直接返回"，没有把"查不到"这个结果存回去；接口参数（ID、页码）没有格式和范围校验。
- 修法：入口先做参数校验，拒绝明显不合法的 ID；查不到的结果也缓存一个空值，TTL 设短（例如 30 到 60 秒）；key 范围很大又被恶意遍历时，在缓存前放布隆过滤器（用很小的内存判断"肯定不存在"）。
- 出处：https://redis.io/blog/how-to-tame-the-thundering-herd-problem/ https://builder.aws.com/content/3K9TeXp6strMiJ4vhakpRD7BQWO/caching-challenges-and-strategies https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/ https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html

### 2. 缓存击穿：热点 key 过期的瞬间，大量请求同时重建
- 问题：缓存击穿：一个访问量极高的 key 到期，同一时刻成百上千个请求都发现缓存没有，一起去查数据库。
- 怎么认出：热点数据的重建逻辑是"未命中就查库并写回"，没有请求合并；热点 key 设了固定 TTL。
- 修法：用请求合并：同一个 key 同一时刻只让一个请求去重建，其余请求等它的结果。同一进程内用 singleflight（Go 的 `x/sync/singleflight`，其他语言有同类库）；多个实例之间，用带过期时间的互斥锁让拿到锁的实例重建，其余实例等待。也可以用逻辑过期（软 TTL 加硬 TTL）：到了软 TTL 就去刷新；刷新失败或下游不可用时继续用旧值，直到硬 TTL 才真正失效；刷新时配合上面的请求合并，只放一个请求去查库。
- 出处：https://redis.io/blog/how-to-tame-the-thundering-herd-problem/ https://builder.aws.com/content/3K9TeXp6strMiJ4vhakpRD7BQWO/caching-challenges-and-strategies https://pkg.go.dev/golang.org/x/sync/singleflight

### 3. 缓存雪崩：大批 key 在同一时刻过期
- 问题：缓存雪崩：批量预热或批量写入的 key 用同一个 TTL，到点一起失效，数据库瞬间承受全部流量。
- 怎么认出：循环或批任务里 `SET key value EX 3600`，TTL 是固定常量；缓存预热脚本一次写入大批数据。
- 修法：TTL 加随机抖动（例如基础值再加 0 到 20% 的随机数）；热点数据在进程内加一层本地缓存，与 Redis 组成多级缓存；数据库入口限制请求速率、必要时丢弃低优先级请求（load shedding），保证缓存大面积失效时数据库不被打垮。
- 出处：https://docs.aws.amazon.com/whitepapers/latest/database-caching-strategies-using-redis/cache-validity.html https://builder.aws.com/content/3K9TeXp6strMiJ4vhakpRD7BQWO/caching-challenges-and-strategies

### 4. 更新数据库和缓存的顺序错误，缓存里留下旧值
- 问题：先更新缓存再更新数据库，或者更新时并发读写交错，缓存里会留下旧数据，直到过期。
- 怎么认出：写路径里 `SET`/`INCR` 更新缓存，随后才写库；或者先删缓存再更新库。
- 修法：采用"先更新数据库，再删除缓存"，让下一次读取时重建；缓存同时要设 TTL，万一删除失败，旧值最迟在 TTL 到期时消失；对一致性要求高的数据，读时带版本号校验。
- 出处：https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside

### 5. 缓存数据没有设置过期时间
- 问题：不过期的 key 会一直占用内存，直到达到 `maxmemory`。`noeviction` 策略下，之后新增缓存数据的命令会直接报错。
- 怎么认出：`SET key value` 或 `HSET` 之后没有 `EX`/`PX`/`EXPIRE`；配置里没有设置 `maxmemory` 和 `maxmemory-policy`。
- 修法：缓存类数据写入时必须带 TTL；配置 `maxmemory`，缓存场景用 `allkeys-lru` 或 `allkeys-lfu`；监控内存使用率和 `evicted_keys`。
- 出处：https://redis.io/docs/latest/develop/reference/eviction/

## 分布式锁
### 6. 加锁和设置过期时间分成两步
- 问题：先 `SETNX` 再 `EXPIRE`，两条命令之间进程崩溃，锁永远没有过期时间，其他进程一直拿不到。
- 怎么认出：加锁代码里分别调用 `SETNX`（或 `SETEX` 之外的写法）和 `EXPIRE`；加锁时没有超时设置。
- 修法：用一条原子命令：`SET lock:order:42 <随机token> NX PX 30000`。其中 `NX` 表示 key 不存在才设置，`PX` 设置毫秒级过期时间。
- 出处：https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/

### 7. 释放锁时直接 DEL，误删别人的锁
- 问题：A 的锁已过期，B 拿到了锁，A 这时执行 `DEL`，把 B 的锁删了，互斥被破坏。
- 怎么认出：解锁代码就是 `DEL lockKey`；加锁时 value 是固定值（如 `1`），不是每次随机的 token。
- 修法：加锁时 value 存本次随机 token；解锁要在服务端一步完成比对和删除：Redis 8.4 起用 `DELEX key IFEQ token`；更早的版本用 Lua 脚本：`if redis.call("get",KEYS[1]) == ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`。
- 出处：https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/

### 8. 业务执行时间超过锁的过期时间
- 问题：锁到期自动释放，但持锁的进程因为 GC、网络或慢查询还在干活，另一个进程拿到锁，两边同时修改共享资源。
- 怎么认出：锁的 TTL 是写死的固定值，没有续期；持锁期间调用外部服务或慢查询；锁保护的是写数据库、写文件这类操作。
- 修法：TTL 大于业务最坏耗时，并有看门狗线程定时续期；保护"必须正确"的资源时，用 fencing token（每次加锁递增的编号，资源端拒绝编号更小的写入）；写库用版本号条件更新。
- 出处：https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/

### 9. 把 Redlock 当成能保证绝对互斥的锁
- 问题：Redlock 在多个独立节点上加锁，但它依赖时钟和延迟的假设，对这些假设是否成立存在公开争议（Redlock 的争议）；主从切换时，单实例的锁也可能丢失。
- 怎么认出：代码用 Redlock 保护转账、库存这类要求严格正确的操作，而资源端没有任何校验。
- 修法：只为"避免重复劳动"的场景（定时任务只跑一次）用单实例加 TTL 的锁就够；为"正确性"保护的场景，锁加上 fencing token，或改用数据库行锁、唯一约束、带版本号的更新。
- 出处：https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/

## 大 key、热 key 与危险命令
### 10. 存在特别大的 key
- 问题：一个 key 里存几十万个元素或几十 MB 的值，读写它会长时间占用 Redis 的单线程，其他请求全部排队；集群里还造成节点内存不均。
- 怎么认出：一个 Hash、List、Set 不断 `HSET`/`RPUSH`/`SADD` 而没有上限；整份大 JSON 序列化后存成一个 String。
- 修法：设计时限制单个 key 的元素数（例如 1 万以内）并按哈希分桶拆分；排查用 `redis-cli --bigkeys` 或 `MEMORY USAGE key`，在低峰期扫描。
- 出处：https://redis.io/docs/latest/develop/tools/cli/

### 11. 删除大 key 用 DEL，阻塞整个实例
- 问题：`DEL` 是同步释放内存，删除一个大集合会让 Redis 卡住几百毫秒甚至几秒。
- 怎么认出：清理、过期、迁移代码里对大集合直接 `DEL`。
- 修法：删除大 key 用 `UNLINK`（先摘除 key，内存在后台线程回收，Redis 4.0 起可用）；删除前不确定大小的 key，一律按大 key 处理。
- 出处：https://redis.io/docs/latest/commands/unlink/

### 12. 热 key 把单个节点压满
- 问题：一个 key 的访问量远超其他，集群里它所在的那个节点 CPU 和网络先被打满，加节点也没用。
- 怎么认出：全站共用的配置、首页数据、热门商品都放在同一个 key 里，每个请求都读它。
- 修法：在应用进程里加一层本地缓存（TTL 几秒）；把热 key 复制成多个副本（`key:1`…`key:N`），读取时随机选一个；排查用 `redis-cli --hotkeys`（需要 `maxmemory-policy` 设为 LFU 类）。
- 出处：https://redis.io/docs/latest/develop/tools/cli/

### 13. 生产环境使用 KEYS 或一次取出整个大集合
- 问题：`KEYS *` 要遍历全部 key，`SMEMBERS`、`HGETALL`、`LRANGE 0 -1` 对大集合同样会阻塞，其他请求都被拖慢。
- 怎么认出：业务代码、运维脚本里有 `KEYS pattern`、对不确定大小的集合调用 `SMEMBERS`、`HGETALL`。
- 修法：用 `SCAN`、`SSCAN`、`HSCAN` 分批迭代，每批 100 到 1000；确需全量时先用 `SCARD`、`HLEN` 判断大小；用 ACL 禁用 `KEYS`。
- 出处：https://redis.io/docs/latest/commands/keys/

### 14. Lua 脚本里有循环或大批量操作
- 问题：Lua 脚本在 Redis 里是原子执行的，执行期间别的命令都被阻塞，脚本写得重会让整个实例没响应。
- 怎么认出：`EVAL` 脚本里有 `for`/`while` 遍历大量 key 或元素；脚本里调用 `KEYS`；脚本里没有任何上限。
- 修法：脚本只做少量固定步骤（比对、更新、判断）；批量处理放到应用里，分批用 `SCAN` 加管道；用慢日志监控脚本耗时。
- 出处：https://redis.io/docs/latest/develop/programmability/eval-intro/

## 数据正确性
### 15. 先 GET 再 SET 做计数或扣库存
- 问题：两个请求同时读到 10，各自写回 9，一次扣减丢失，库存超卖。
- 怎么认出：代码里 `GET`，应用里加减，再 `SET`；限流计数、库存、抢购都有这个模式。
- 修法：用原子命令 `INCR`/`DECR`/`INCRBY`；需要"先判断再改"时，用 Lua 脚本把判断和修改放在一起，或用 `WATCH`/`MULTI`/`EXEC` 乐观锁。
- 出处：https://redis.io/docs/latest/commands/incr/

### 16. 以为 MULTI/EXEC 失败会整体回滚
- 问题：Redis 的事务不支持回滚。队列里某条命令执行时出错，其他命令仍会执行，数据停在一半的状态。
- 怎么认出：代码用 `MULTI/EXEC`（或客户端的 `transaction`、`pipeline(transaction=True)`）保护多个互相依赖的写入，没有检查每条命令的执行结果。
- 修法：检查 `EXEC` 返回的每条结果；需要"全做或全不做"的逻辑改用 Lua 脚本并在脚本里先做所有校验；跨 key 的强一致需求放在数据库里。
- 出处：https://redis.io/docs/latest/develop/using-commands/transactions/

### 17. 集群模式下一条命令操作了不在同一槽位的多个 key
- 问题：Redis Cluster 要求多 key 命令（`MGET`、`MSET`、事务、Lua）涉及的 key 在同一个哈希槽，否则报 `CROSSSLOT` 错误，单机测试时发现不了。
- 怎么认出：多 key 命令的 key 名没有共同的 `{...}` 部分，例如 `user:1:profile`、`user:1:cart`；测试用单机 Redis，生产是集群。
- 修法：需要一起操作的 key 用相同的哈希标签：`{user:1}:profile`、`{user:1}:cart`；测试环境尽量与生产使用相同拓扑；注意标签过于集中会造成热点。
- 出处：https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/

### 18. 用 Pub/Sub 传递不能丢的消息
- 问题：Pub/Sub 是即发即弃，最多投递一次：订阅者掉线、重启期间发布的消息就永久丢了，也不能确认和重试。
- 怎么认出：订单、通知、任务等业务消息用 `PUBLISH`/`SUBSCRIBE` 传递，没有补偿机制。
- 修法：不能丢的消息改用 Streams（消费组加 `XACK` 确认），或者交给消息队列；Pub/Sub 只用于缓存失效广播这种丢了也能自愈的场景。
- 出处：https://redis.io/docs/latest/develop/pubsub/

## 安全与连接
### 19. Redis 绑定公网地址且没有密码
- 问题：Redis 默认设计为只在可信网络里使用。公网上没有认证的 Redis 会被扫描到，外部攻击者一条 `FLUSHALL` 就能删光全部数据，也能随意读写。
- 怎么认出：配置或 Compose、Helm 文件里 `bind 0.0.0.0`、`protected-mode no`，没有 `requirepass` 或 ACL；端口 6379 映射到宿主机公网地址或安全组对 `0.0.0.0/0` 开放。
- 修法：只绑定内网地址，安全组只允许应用访问；开启认证（ACL 用户加强密码）；保持 `protected-mode yes`；不要对外映射 6379。
- 出处：https://redis.io/docs/latest/operate/oss_and_stack/management/security/

### 20. 应用使用 default 用户，拥有全部命令权限
- 问题：应用只需要读写缓存，却能执行 `FLUSHALL`、`CONFIG`、`KEYS` 等管理命令，一旦被注入或被盗用损失很大。
- 怎么认出：连接串只有密码没有用户名，或者用户是 `default`；没有配置 ACL 文件。
- 修法：用 ACL 为应用建专用用户，限定 key 前缀和命令类别：`ACL SETUSER app on >密码 ~app:* +@read +@write -@dangerous`；禁用 default 用户。
- 出处：https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/

### 21. 跨网络连接 Redis 没有启用 TLS
- 问题：密码和数据在网络上以明文传输，同一网络的人可以抓包读到。
- 怎么认出：应用配置里的地址是 `redis://`，而 Redis 位于另一个网络、云厂商的跨可用区网络或公网上；服务端没有 `tls-port` 配置。
- 修法：服务端配置 `tls-port`、证书；客户端使用 `rediss://` 并校验证书；托管的 Redis 服务打开传输加密。
- 出处：https://redis.io/docs/latest/operate/oss_and_stack/management/security/#tls-support

### 22. 每次请求都新建 Redis 连接
- 问题：反复建立连接（含 TLS 握手、认证）会带来额外耗时和开销，官方文档建议尽量少建连接。
- 怎么认出：请求处理函数内部创建客户端对象；没有复用全局的连接池或客户端实例。
- 修法：进程启动时创建一个客户端（内部带连接池）并复用；设置连接超时和命令超时，避免 Redis 故障时请求一直挂着。
- 出处：https://redis.io/docs/latest/develop/clients/pools-and-muxing/

### 23. 把 Redis 当唯一数据源，却没有开持久化
- 问题：Redis 默认可能丢失最近的写入；没有持久化时重启或故障后数据清零，存的是不可重建的数据就是事故。
- 怎么认出：存放订单状态、用户资料等无法从别处恢复的数据；配置里 `save ""`、`appendonly no`；没有主从或备份。
- 修法：不可重建的数据主存放在数据库里，Redis 只做缓存；确实要用 Redis 保存时开启 AOF（`appendonly yes`），并配置备份和副本，同时接受它仍可能丢最近一秒内的数据。
- 出处：https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/

## 实例规划
### 24. 存锁、限流计数的实例开着 allkeys 淘汰策略
- 问题：`allkeys-lru` 这类策略会在内存满时淘汰任意 key，包括分布式锁、限流计数。锁被淘汰，互斥就失效了；`volatile-*` 策略淘汰的正是带过期时间的 key，锁和限流计数同样带过期时间，所以也不安全。
- 怎么认出：`maxmemory-policy` 是 `allkeys-*` 或 `volatile-*`，而同一个实例里还存了分布式锁、限流计数或任务队列。
- 修法：存锁和限流计数的实例用 `noeviction`（内存满时写入报错而不是悄悄丢数据），并监控内存使用率提前扩容；缓存数据单独用另一个实例，配 `allkeys-lru`。
- 出处：https://redis.io/docs/latest/develop/reference/eviction/
