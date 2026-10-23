---
name: relational-db
description: 关系型数据库（MySQL、PostgreSQL）使用排查清单：动态标识符与 LIKE 注入、分页、N+1、索引与迁移锁表、事务与死锁、丢失更新、连接池与超时、金额类型。
---
# 关系型数据库排查清单

## 查询与注入
### 1. 表名、列名、排序方向来自用户输入，不能用占位符
- 问题：参数占位符（`?`、`$1`）只能代替"值"，不能代替表名、列名、`ORDER BY` 的方向。这些位置只能拼进语句，用户输入进去就是注入。
- 怎么认出：`ORDER BY` 后面接的是请求里的 `sort`、`order_by` 参数；动态表名、列名来自请求；ORM 的 `order_by(request.args['sort'])`、`literal`、`raw` 写法。
- 修法：服务端维护一个列名白名单映射（例如 `{"created": "created_at", "price": "price"}`），用户值只做查找，查不到就用默认值或返回 400；排序方向只接受 `ASC`、`DESC` 两个固定值；值的部分始终用占位符。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html

### 2. LIKE 的搜索词没有转义通配符
- 问题：用户输入里的 `%` 和 `_` 在 `LIKE` 里是通配符。即使用了占位符，输入 `%` 也能匹配全表，造成大范围扫描和信息泄露。
- 怎么认出：`LIKE ?` 的参数是 `"%" + keyword + "%"`，而 `keyword` 没有处理过。
- 修法：先把关键词里的 `\`、`%`、`_` 转义，再拼首尾的 `%`，并在语句里写 `ESCAPE '\'`；大表上的任意子串搜索改用全文索引。
- 出处：https://www.postgresql.org/docs/current/functions-matching.html#FUNCTIONS-LIKE

### 3. 应用连接数据库用的是管理员账号
- 问题：应用账号权限过大，一旦出现注入，攻击者可以删表、读其他库、改权限，而不只是查几行数据。
- 怎么认出：连接串、配置里的用户名是 `root`、`postgres`、`sa`；迁移脚本和应用共用同一个账号；账号拥有 `ALL PRIVILEGES`。
- 修法：为应用建单独账号，只授予所需表的 `SELECT/INSERT/UPDATE/DELETE`；迁移用另一个有 DDL 权限的账号，只在发布时使用。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html

## 分页与查询效率
### 4. 深分页使用 OFFSET，页数越大越慢
- 问题：`OFFSET n` 要先把前 n 行都算出来再丢掉，翻到几万页时每次请求都在做大量无用功。
- 怎么认出：列表接口 `LIMIT ? OFFSET ?`，页码由调用方传，没有页数上限；日志里翻页越深耗时越长。
- 修法：改成 keyset 分页（用上一页最后一行的排序键继续往后查）：`WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT 20`；排序键上建联合索引；需要跳页的后台页面限制最大页码。
- 出处：https://www.postgresql.org/docs/current/queries-limit.html

### 5. 分页的排序键不唯一，翻页时重复或漏行
- 问题：`ORDER BY created_at` 遇到同一时间的多行时，每次查询的相对顺序可能不同，翻页就会出现重复和遗漏。
- 怎么认出：带 `LIMIT` 的查询没有 `ORDER BY`；`ORDER BY` 只有可能重复的列（时间、状态、分数）。
- 修法：排序条件末尾加主键作为最后一个排序键：`ORDER BY created_at DESC, id DESC`；所有带 `LIMIT` 的查询都写明确的 `ORDER BY`。
- 出处：https://www.postgresql.org/docs/current/queries-limit.html

### 6. 循环里逐条查询关联数据（N+1）
- 问题：先查 1 次列表，再对每一行各查 1 次关联数据，一共 N+1 次查询。数据量一大，请求耗时和数据库压力成倍上升。
- 怎么认出：`for` 循环里调用查询、`get_by_id`、ORM 的懒加载属性；日志里同一条语句只有 ID 不同，连续出现几十次。
- 修法：先收集 ID，一次 `WHERE id IN (...)` 查出再在内存里组装；用 ORM 时改成预加载（eager loading，如 `JOIN` 或 `IN` 批量加载）；在测试里断言查询次数不随数据量增长。
- 出处：https://guides.rubyonrails.org/active_record_querying.html#eager-loading-associations （Rails 官方指南，用来说明 N+1 的概念；数据库厂商文档没有专门描述）

### 7. 在索引列上套函数或做类型转换，索引失效
- 问题：`WHERE DATE(created_at) = '2026-01-01'` 这类写法让数据库无法直接使用 `created_at` 上的普通索引，只能全表扫描。
- 怎么认出：`WHERE` 里有 `LOWER(col)`、`DATE(col)`、`col + 1`、`col::text`；字符串列和数字做比较。
- 修法：把函数挪到常量一侧，改成范围条件：`created_at >= '2026-01-01' AND created_at < '2026-01-02'`；确实需要按表达式查时，在 PostgreSQL 里建表达式索引（如 `CREATE INDEX ON t (lower(col))`）。
- 出处：https://www.postgresql.org/docs/current/indexes-expressional.html

### 8. 外键列没有索引（PostgreSQL）
- 问题：PostgreSQL 不会自动给引用表的外键列建索引。删除或更新被引用的行时，要全表扫描引用表，还会拉长持锁时间。
- 怎么认出：迁移里 `REFERENCES parent(id)` 的列没有对应的 `CREATE INDEX`；按外键列过滤、关联查询很慢。
- 修法：给每个外键列建索引（PostgreSQL 不会自动建，要在迁移里自己写）；先用 `EXPLAIN` 确认删除父表行时没有对引用表全表扫描。
- 出处：https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK

## 变更与迁移
### 9. 在大表上直接创建索引，阻塞写入（PostgreSQL）
- 问题：普通 `CREATE INDEX` 会锁住表的写操作直到建完，大表上可能持续几分钟，期间所有写请求排队超时。
- 怎么认出：迁移文件里 `CREATE INDEX idx ON big_table (...)`，没有 `CONCURRENTLY`。
- 修法：改为 `CREATE INDEX CONCURRENTLY`（不能放在事务块里，迁移工具要关闭该迁移的事务包装）；建完检查索引是否有效，失败会留下无效索引，要删掉重建。
- 出处：https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY

### 10. MySQL 修改大表结构，没有写明预期的在线方式
- 问题：不同的 `ALTER TABLE` 操作能否在线完成差别很大：8.4 里加列默认走 INSTANT（只改元数据，几乎瞬间完成），改列类型则只能 COPY（重建整张表并阻塞写入）。不写明预期，上线时才发现锁表。
- 怎么认出：迁移里对大表 `ALTER TABLE ... ADD COLUMN`、`MODIFY`、`CHANGE`、改字符集，没有 `ALGORITHM=`、`LOCK=` 子句。
- 修法：显式写出预期的算法：加列用 `ALGORITHM=INSTANT`，其他支持在线的操作用 `ALGORITHM=INPLACE, LOCK=NONE`；数据库做不到时语句会直接报错，而不是悄悄锁表。改列类型这类只能 COPY 的变更，改用在线迁移工具并选低峰期执行。
- 出处：https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html https://dev.mysql.com/doc/refman/8.4/en/alter-table.html

## 事务与并发
### 11. 多个相关写操作没有放在同一个事务里
- 问题：扣库存成功、写订单失败时，数据停在一半的状态，不会自动恢复。
- 怎么认出：一个业务函数里连续调用多个 `INSERT/UPDATE`，各自自动提交，没有 `BEGIN/COMMIT` 或事务注解、事务对象。
- 修法：一个业务动作里必须一起成功或一起失败的写操作，放在同一个事务里，出错就整体回滚；事务由业务层开启，不在数据访问的每个小函数里各自开启。
- 出处：https://www.postgresql.org/docs/current/tutorial-transactions.html

### 12. 事务开着的时间被拉长
- 问题：事务持有行锁和连接，开得越久越容易与别的事务冲突。MySQL 文档建议事务保持小而短，相关修改做完立刻提交，不要让事务带着未提交的改动挂着。
- 怎么认出：`BEGIN` 与 `COMMIT` 之间夹着 HTTP 请求、发消息、`sleep`、读文件这类耗时操作（它们一慢，事务就跟着变长，连接池和锁等待随之堆积）。
- 修法：事务里只放数据库操作；外部调用放到事务之前或提交之后。提交之后要可靠地通知别的服务时，用 Outbox（发件箱）：把业务数据和待发送的消息放在同一个本地事务里写进数据库，再由后台任务读出来转发。
- 出处：https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html

### 13. 不同代码路径以不同顺序更新同一批行
- 问题：事务 A 先锁行 1 再锁行 2，事务 B 先锁行 2 再锁行 1，两边互相等待，形成死锁，数据库会杀掉其中一个事务。
- 怎么认出：两个函数都会更新同一批表或同一批账户，但更新顺序不同（转账 A→B 与 B→A）；批量更新没有排序。
- 修法：所有路径按同一规则排序访问，例如按主键升序加锁：先 `SELECT ... WHERE id IN (...) ORDER BY id FOR UPDATE`，再更新；表之间也约定固定顺序。
- 出处：https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-DEADLOCKS

### 14. 遇到死锁错误没有重试
- 问题：即使代码顺序一致，死锁仍可能偶发。数据库回滚被选中的事务并报错，业务如果没有处理，用户就看到一次莫名其妙的失败。
- 怎么认出：数据库调用外层没有对 MySQL 错误码 1213（`ER_LOCK_DEADLOCK`）、PostgreSQL 的 `40P01`（死锁）和 `40001`（序列化失败）做处理；错误直接返回给调用方。
- 修法：识别这几个错误码，整个事务重新执行（不是只重试失败的那条语句），最多重试 3 次并加短暂随机等待；事务要写成可以安全重放的。
- 出处：https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html https://dev.mysql.com/doc/mysql-errors/8.4/en/server-error-reference.html https://www.postgresql.org/docs/current/errcodes-appendix.html

### 15. 先读后写造成丢失更新
- 问题：两个请求同时读到库存 10，各自减 1 后都写回 9，一次扣减丢了。
- 怎么认出：代码先 `SELECT` 出值，在应用里计算，再 `UPDATE ... SET qty = ?` 写回；没有 `FOR UPDATE`，也没有版本号。
- 修法：能在 SQL 里算就一条语句完成：`UPDATE stock SET qty = qty - 1 WHERE id = ? AND qty > 0`，检查影响行数；需要先读再算时用 `SELECT ... FOR UPDATE` 加锁，或加 `version` 列做乐观锁。
- 出处：https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED

### 16. 用"先查再插"保证唯一
- 问题：两个请求同时查到"不存在"，然后都插入，产生重复数据。
- 怎么认出：代码先 `SELECT count(*)` 或 `exists`，没有再 `INSERT`，表上又没有唯一索引。
- 修法：在表上建唯一索引，直接插入并处理冲突：PostgreSQL 用 `INSERT ... ON CONFLICT`，MySQL 用 `INSERT ... ON DUPLICATE KEY UPDATE`，或捕获唯一键冲突错误后改为读取已有记录。
- 出处：https://www.postgresql.org/docs/current/sql-insert.html#SQL-ON-CONFLICT

## 连接与超时
### 17. 异常路径上连接没有归还连接池
- 问题：取了连接，中间出错提前返回，没有释放。泄漏的连接越积越多，最终池被占满，所有请求卡住。
- 怎么认出：获取连接或事务对象后，释放写在正常路径末尾，不在 `finally`、`defer` 或 `with` 块里；日志里出现"等待连接超时"。
- 修法：用语言提供的自动释放结构；连接池打开泄漏检测（如 HikariCP 的 `leakDetectionThreshold`）；服务端设 `idle_in_transaction_session_timeout`（PostgreSQL），让卡在事务里的连接被自动回收。
- 出处：https://github.com/brettwooldridge/HikariCP#frequently-used https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-IDLE-IN-TRANSACTION-SESSION-TIMEOUT

### 18. 连接池太小，请求在池前面排队
- 问题：池大小远小于并发请求数时，请求等连接而不是等数据库，延迟高但数据库其实很闲。
- 怎么认出：池配置的最大连接数是默认的 5 或 10，服务并发远超这个数；监控里"等待连接的线程数"持续大于 0。
- 修法：按公式估算（经验起点：CPU 核数的 2 倍加磁盘数），用压测调整；配置获取连接的超时，超时快速失败而不是无限等待。
- 出处：https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing

### 19. 池太大，所有实例加起来超过数据库的连接上限
- 问题：每个实例连接池 50 个，部署 10 个实例就是 500 个连接。超过数据库 `max_connections`，新连接被拒绝，滚动发布时更容易触发。
- 怎么认出：池大小配置乘以副本数（含发布时多出的实例）大于数据库的 `max_connections`；弹性扩容规则里没有考虑连接数。
- 修法：先算总量：实例数 × 池大小 < `max_connections` 并留出余量；实例多时在前面放连接代理（如 PgBouncer、ProxySQL）。
- 出处：https://www.postgresql.org/docs/current/runtime-config-connection.html#GUC-MAX-CONNECTIONS

### 20. 慢语句没有执行超时
- 问题：一条慢查询会一直占着连接，后面的请求越积越多。
- 怎么认出：应用账号或连接参数里没有 `statement_timeout`（PostgreSQL）、`max_execution_time`（MySQL）；连接池只设了获取连接的超时。
- 修法：给应用账号设 `statement_timeout`（例如 30 秒，值按业务定）；MySQL 设 `max_execution_time`（只对 `SELECT` 有效）；个别长任务单独放宽。
- 出处：https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-STATEMENT-TIMEOUT https://dev.mysql.com/doc/refman/8.4/en/server-system-variables.html

### 21. 行锁等待时间没有按业务调整
- 问题：一个长时间没提交的事务占着行锁，其他事务会一直等到锁等待超时才报错。MySQL 的 `innodb_lock_wait_timeout` 默认 50 秒，请求早就超时了，后台还在排队。
- 怎么认出：MySQL 配置或会话里没有调整过 `innodb_lock_wait_timeout`，而接口的超时远小于 50 秒；PostgreSQL 一侧没有设 `lock_timeout`。
- 修法：把行锁等待时间设得短于接口超时。MySQL 锁等待超时默认只回滚当前这条语句，事务还开着，应用要先显式 `ROLLBACK`，再整个事务重试或返回失败；PostgreSQL 用 `lock_timeout`。
- 出处：https://dev.mysql.com/doc/refman/8.4/en/innodb-parameters.html https://www.postgresql.org/docs/current/runtime-config-client.html#GUC-LOCK-TIMEOUT

## 数据类型
### 22. 金额存成 FLOAT 或 DOUBLE
- 问题：浮点数是近似值，0.1 加 0.2 不等于 0.3，累计后账目对不上。
- 怎么认出：表结构里金额、费率、余额的列类型是 `FLOAT`、`DOUBLE`、`REAL`。
- 修法：用 `DECIMAL(精度, 小数位)`（MySQL）或 `NUMERIC`（PostgreSQL），或者用整数存最小货币单位（分）；应用层也用对应的定点或整数类型，不转成浮点。
- 出处：https://www.postgresql.org/docs/current/datatype-numeric.html#DATATYPE-FLOAT

## 补充
### 23. 列表接口每次都执行 COUNT(*) 取总数
- 问题：PostgreSQL 的多版本并发控制（同一时刻不同事务能看到不同版本的数据）使得没有现成的行数可读，大表上的 `count(*)` 要扫描整张表，列表接口每翻一页都执行一次，拖慢整个库。
- 怎么认出：分页接口里每次请求都带 `SELECT count(*) FROM big_table`（带不带 WHERE 都算）；响应里有 `total` 字段，前端只用来显示页码。
- 修法：不需要精确总数时改成返回"是否还有下一页"（多查一行判断）；需要大概数字时用估算值或定时刷新的缓存值；确需精确总数的筛选条件要有能收窄范围的索引。
- 出处：https://wiki.postgresql.org/wiki/Slow_Counting

### 24. 用 NOT IN 加子查询，遇到 NULL 返回空结果
- 问题：子查询结果里只要有一个 NULL，`col NOT IN (子查询)` 就一行都不返回，而且计划器无法把它改写成高效的反连接（先做连接、再排除匹配行的执行方式）。
- 怎么认出：`NOT IN (SELECT ...)`，或者 `NOT IN` 的列表来自可能含空值的列；结果莫名为空。
- 修法：改写成 `NOT EXISTS (SELECT 1 FROM t WHERE t.x = outer.col)`；确需 `NOT IN` 时在子查询里加 `WHERE x IS NOT NULL`。
- 出处：https://wiki.postgresql.org/wiki/Don%27t_Do_This

### 25. 加锁读或更新的条件没走索引，锁住大量行
- 问题：InnoDB 对扫描过的索引记录加锁。条件没有合适索引时，一条 `UPDATE` 或 `SELECT ... FOR UPDATE` 会锁住很多行，其他事务排队，也更容易死锁。
- 怎么认出：`UPDATE ... WHERE` 或 `SELECT ... FOR UPDATE` 的条件列没有索引；`EXPLAIN` 显示全表扫描或扫描行数远大于命中行数。
- 修法：给条件列建合适的索引，用 `EXPLAIN` 确认走索引；只锁需要的行，范围尽量精确。
- 出处：https://dev.mysql.com/doc/refman/8.4/en/innodb-deadlocks-handling.html
