---
name: java-pitfalls
description: Java / Spring 安全与鲁棒性常见坑：不可信数据反序列化、@Transactional 失效、线程池、资源关闭、Actuator 暴露、SimpleDateFormat 线程安全。
---
# Java 常见坑排查清单

## 安全
### 1. 反序列化不可信数据
- 问题：`ObjectInputStream` 读取外部字节时，攻击者可以构造对象链，在反序列化过程中执行代码。Jackson 开启多态类型（default typing）也有同类风险。
- 怎么认出：`new ObjectInputStream(`、`readObject()` 的输入来自网络或用户；`enableDefaultTyping()`、`@JsonTypeInfo(use = Id.CLASS)`。
- 修法：交换数据用 JSON 等纯数据格式；必须用 Java 序列化时设置 `ObjectInputFilter` 白名单；Jackson 多态类型用 `PolymorphicTypeValidator` 限定允许的子类。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Deserialization_Cheat_Sheet.html

### 2. Spring Boot Actuator 端点对外暴露
- 问题：`env`、`heapdump`、`beans` 等端点会泄漏配置、密钥甚至内存内容，对外开放等于把内部信息送给攻击者。
- 怎么认出：配置里 `management.endpoints.web.exposure.include=*`；管理端口与业务端口相同，且没有鉴权。
- 修法：只暴露需要的端点（如 `health`、`info`）；管理端口绑内网或加 Spring Security 保护。
- 出处：https://docs.spring.io/spring-boot/reference/actuator/endpoints.html

## 事务与线程
### 3. @Transactional 失效
- 问题：同类内部方法互相调用（自调用）不经过代理，注解不生效；private 方法上的注解不起作用；用接口代理时方法不是 public 也不起作用；受检异常默认不回滚。结果是数据写了一半却不回滚。（Spring 6.0 起，基于类的代理下 protected 和包可见方法也可以加事务。）
- 怎么认出：`this.save()` 之类同类自调用的 `@Transactional` 方法；注解写在 `private` 方法上，或接口代理下写在非 public 方法上；抛出 `IOException` 等受检异常却没有 `rollbackFor`。
- 修法：把被调方法放到另一个 Bean；写 `@Transactional(rollbackFor = Exception.class)`；Spring 6.2 起也可以用 `@EnableTransactionManagement(rollbackOn = ALL_EXCEPTIONS)` 让受检异常全局回滚。
- 出处：https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html

### 4. 用 Executors 创建无界队列的线程池
- 问题：`newFixedThreadPool` 和 `newSingleThreadExecutor` 的队列无上限，任务堆积会耗尽内存；`newCachedThreadPool` 线程数无上限，可能创建出大量线程。
- 怎么认出：`Executors.newFixedThreadPool(`、`newCachedThreadPool(`、`newSingleThreadExecutor(`。
- 修法：直接用 `ThreadPoolExecutor`，指定有界队列（如 `ArrayBlockingQueue`）和拒绝策略。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/Executors.html

### 5. SimpleDateFormat 多线程共用
- 问题：`SimpleDateFormat` 内部有可变状态，不是线程安全的。多线程共用一个实例会得到错乱的日期或抛异常。
- 怎么认出：`static final SimpleDateFormat` 字段，或单例 Bean 里的 `SimpleDateFormat` 字段被多个请求使用。
- 修法：改用线程安全的 `java.time.format.DateTimeFormatter`；或每次调用新建实例。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/text/SimpleDateFormat.html#synchronization

## 资源
### 6. 连接和流没 close
- 问题：数据库连接、文件流、HTTP 响应不关闭，连接池被耗尽、文件句柄泄漏，服务逐渐卡死。
- 怎么认出：`getConnection()`、`new FileInputStream(`、`openStream()` 后没有 `close()`，也没有 try-with-resources；异常路径上漏 close。
- 修法：全部用 try-with-resources，让编译器保证 close。
- 出处：https://docs.oracle.com/javase/tutorial/essential/exceptions/tryResourceClose.html

## 注入与输入
### 7. SQL 拼接
- 问题：把用户输入拼进 SQL 会被注入，攻击者可读写整个数据库。
- 怎么认出：`statement.executeQuery("... " + name)`、`String.format` 拼出的 SQL、JPA 里 `"... " + param` 的 JPQL 或原生查询。
- 修法：用 `PreparedStatement` 和 `?` 占位符，JPA 用命名参数。
- 出处：https://docs.oracle.com/javase/tutorial/jdbc/basics/prepared.html

### 8. XML 解析打开外部实体（XXE）
- 问题：解析器默认可能读取本地文件或访问内网地址，攻击者在 XML 里引用外部实体即可读出文件。
- 怎么认出：`DocumentBuilderFactory.newInstance()`、`SAXParserFactory`、`XMLInputFactory` 之后没有关闭 DTD 的设置。
- 修法：设置 `disallow-doctype-decl` 为 true，或关闭外部实体解析。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html

### 9. 日志注入和日志泄漏敏感信息
- 问题：含换行的用户输入会伪造日志行；密码、令牌写进日志会泄漏。
- 怎么认出：`log.info("login " + user)`；打印整个请求对象、`toString()` 含密码字段。
- 修法：去掉换行再输出；敏感字段不进 `toString` 和日志。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html

### 10. 路径穿越
- 问题：用户给出 `../` 路径可跳出目录，读写任意文件，解压 zip 时也一样（Zip Slip）。
- 怎么认出：`new File(base, userName)`、`Paths.get(base, name)` 后直接读写；`ZipEntry.getName()` 直接拼路径。
- 修法：`normalize()` 之后检查 `startsWith(baseDir)`，不通过则拒绝。
- 出处：https://owasp.org/www-community/attacks/Path_Traversal

### 11. SSRF：服务端按用户给的 URL 发请求
- 问题：攻击者让服务请求内网或云元数据地址，拿到内部信息。
- 怎么认出：`new URL(userInput).openStream()`、`RestTemplate.getForObject(userUrl, ...)`。
- 修法：域名白名单，解析后拒绝内网和回环地址，不自动跟随重定向。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

### 12. Spring 批量赋值（mass assignment）
- 问题：控制器直接绑定实体类，请求里多带 `role`、`isAdmin` 之类字段就会被写进去。
- 怎么认出：`@RequestBody User user` 或表单绑定的参数是数据库实体，里面有不该由用户修改的字段。
- 修法：用专门的请求对象（DTO）只含允许字段；或在 `@InitBinder` 里 `setAllowedFields`。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html

### 13. 正则回溯（ReDoS）
- 问题：写法不当的正则遇到特殊输入时耗时爆炸，一个请求占满一个 CPU 核。
- 怎么认出：嵌套量词 `(a+)+`，用 `Pattern.matches` 匹配外部输入。
- 修法：简化正则，限制输入长度。
- 出处：https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS

## 密码学与网络
### 14. 用 Random 生成令牌
- 问题：`java.util.Random` 不是密码学安全的，结果可预测。
- 怎么认出：令牌、验证码、密码重置码用了 `new Random()`、`Math.random()`。
- 修法：用 `SecureRandom`。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/Random.html

### 15. 用 MD5 / SHA-1 存密码
- 问题：快速哈希可被暴力破解，数据库泄漏后密码很快被还原。
- 怎么认出：`MessageDigest.getInstance("MD5")`、`"SHA-1"` 用于密码。
- 修法：用 argon2id、bcrypt 或 scrypt，如 Spring Security 的 `PasswordEncoder`。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

### 16. HTTP 客户端没有超时
- 问题：对端不响应时线程永久等待，线程池被耗尽。
- 怎么认出：`HttpClient.newHttpClient()` 配合没有 `.timeout(...)` 的请求；`HttpURLConnection` 没设 `setReadTimeout`。
- 修法：`HttpClient.newBuilder().connectTimeout(...)` 加 `HttpRequest.Builder.timeout(...)`。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.net.http/java/net/http/HttpRequest.Builder.html#timeout(java.time.Duration)

### 17. 依赖里有已知漏洞
- 问题：依赖库的已知漏洞（如日志库、序列化库）被直接利用，不需要攻击你自己的代码。
- 怎么认出：diff 里 `pom.xml` 或 `build.gradle` 新增、改动了依赖版本，而 CI 里没有依赖扫描步骤。
- 修法：CI 里加依赖漏洞扫描，及时升级。
- 出处：https://owasp.org/www-project-dependency-check/

## 数值与类型
### 18. 用 == 比较包装类型
- 问题：`==` 比较引用；`Integer` 只缓存一小段范围内的值，超出范围通常不是同一个对象，结果时真时假。
- 怎么认出：两个 `Integer`、`Long` 变量直接 `a == b`。
- 修法：用 `equals`，或先转成基本类型再比较。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Integer.html#valueOf(int)

### 19. 用 double 构造 BigDecimal，或用 equals 比较
- 问题：`new BigDecimal(0.1)` 得到的是 0.1 的二进制近似值，不是 0.1；`equals` 还会比较精度，`2.0` 与 `2.00` 不相等。
- 怎么认出：`new BigDecimal(double)`；`a.equals(b)` 两个 BigDecimal。
- 修法：用 `new BigDecimal("0.1")` 或 `BigDecimal.valueOf`；比较大小用 `compareTo`。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/math/BigDecimal.html

### 20. 整数溢出静默发生
- 问题：`int` 加乘溢出不报错，金额、数量、下标会变成负数或错值。
- 怎么认出：对来自外部的数字做 `a + b`、`a * b`，再用作长度、数量、金额。
- 修法：用 `Math.addExact`、`multiplyExact`，或改用 `long`、`BigInteger`。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Math.html#addExact(int,int)

## 并发与资源
### 21. ThreadLocal 在线程池里不清理
- 问题：线程池的线程会复用，ThreadLocal 里的数据留给下一个请求，既泄漏内存，也可能串用户数据。
- 怎么认出：`ThreadLocal.set(...)` 之后没有 `finally { remove(); }`。
- 修法：在 `finally` 中调用 `remove()`。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/ThreadLocal.html#remove()

### 22. 遍历集合时修改它
- 问题：`for-each` 里 `list.remove(...)` 会抛 `ConcurrentModificationException`，多线程下表现更不稳定。
- 怎么认出：`for (X x : list) { list.remove(x); }`。
- 修法：用 `Iterator.remove()`、`removeIf`，或遍历副本。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/ArrayList.html

### 23. 吞掉 InterruptedException
- 问题：抛出 `InterruptedException` 时线程的中断标志已被清除，捕获后不重新设置，线程池关闭、任务取消不起作用，线程无法停止。
- 怎么认出：`catch (InterruptedException e) {}` 或只打日志。
- 修法：`Thread.currentThread().interrupt();` 后返回，或直接向上抛。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Thread.html#interrupt()

### 24. 异步任务在公共线程池里做阻塞 IO
- 问题：`CompletableFuture` 不传线程池的异步方法都跑在 `ForkJoinPool.commonPool()` 上，整个应用共用这一个池；在里面等数据库、HTTP，会把池占满，拖慢所有用它的任务。
- 怎么认出：`supplyAsync(...)`、`runAsync(...)`、`thenApplyAsync(...)` 没传 Executor，回调里调用数据库、HTTP 或 `Thread.sleep`。
- 修法：阻塞任务传入自己的线程池（第二个参数传 Executor）；公共池只放纯计算任务。
- 出处：https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/CompletableFuture.html 、https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ForkJoinPool.html

### 25. @Async 同类自调用不生效
- 问题：和 @Transactional 一样，同类内部调用不经过代理，方法在调用线程里同步执行。
- 怎么认出：同一个类里 `this.asyncMethod()`；需要 `@EnableAsync` 但没开。
- 修法：把异步方法放到另一个 Bean；确认开启 `@EnableAsync`。
- 出处：https://docs.spring.io/spring-framework/reference/integration/scheduling.html#scheduling-annotation-support-async

### 26. SpEL 表达式注入
- 问题：把用户输入当作 SpEL 表达式求值，攻击者可调用任意类的方法，实现远程代码执行。
- 怎么认出：`parser.parseExpression(userInput)` 的参数来自请求，且求值时用的是 `StandardEvaluationContext`。
- 修法：不要对外部输入求值；`StandardEvaluationContext` 绝不能用于不可信表达式；`SimpleEvaluationContext` 也只是尽量限制，官方文档写明不保证安全。
- 出处：https://docs.spring.io/spring-framework/reference/core/expressions/evaluation.html 、https://cwe.mitre.org/data/definitions/917.html
