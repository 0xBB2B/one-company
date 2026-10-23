---
name: go-pitfalls
description: Go 安全与鲁棒性常见坑：nil map、并发读写、数据竞争、goroutine 泄漏、HTTP 客户端超时、循环变量、WaitGroup。
---
# Go 常见坑排查清单

## 并发
### 1. 写 nil map 会 panic
- 问题：只声明没初始化的 map 是 nil，读不出错，写会 panic，请求处理中直接崩溃。
- 怎么认出：`var m map[K]V` 或结构体里的 map 字段，后面直接 `m[k] = v`，找不到 `make` 或字面量初始化。
- 修法：写之前 `m = make(map[K]V)`，结构体在构造函数里初始化。
- 出处：https://go.dev/blog/maps

### 2. map 并发读写导致进程崩溃（concurrent map writes）
- 问题：多个 goroutine 同时读写同一个 map，运行时检测到会直接 fatal，无法 recover，整个进程退出。
- 怎么认出：包级变量或共享结构体里的 map，被 `go func` 或多个请求处理函数访问，周围没有锁。
- 修法：用 `sync.RWMutex` 保护，或用 `sync.Map`（适合读多写少）；或让一个 goroutine 独占这个 map。
- 出处：https://go.dev/doc/go1.6#runtime

### 3. 数据竞争（用 go test -race 检查）
- 问题：两个 goroutine 同时访问同一变量且至少一个在写，结果不可预测，常在线上偶发。
- 怎么认出：多个 goroutine 读写同一个变量、切片或结构体字段，没有锁、channel 或 `sync/atomic`。
- 修法：加锁、改用 channel 传递所有权，或用 atomic；CI 里跑 `go test -race ./...`。
- 出处：https://go.dev/doc/articles/race_detector

### 4. goroutine 泄漏（发送方没有退出途径）
- 问题：goroutine 卡在向没人接收的 channel 发送、或等待永远不关闭的 channel，永远不退出，内存和 goroutine 数持续增长。
- 怎么认出：`go func()` 里有 `ch <- x` 或 `<-ch`，但调用方可能提前返回，且没有 `ctx.Done()` 或 done channel 的分支。
- 修法：用 `select` 同时监听 `ctx.Done()`；channel 设缓冲或由发送方 `close`；保证每个 goroutine 都有退出条件。
- 出处：https://go.dev/blog/pipelines

### 5. WaitGroup.Add 放在子 goroutine 里
- 问题：`Add` 在子 goroutine 中执行时，主 goroutine 的 `Wait` 可能先跑完，等不到这些任务就返回。
- 怎么认出：`go func() { wg.Add(1); defer wg.Done() ... }()`。
- 修法：在启动 goroutine 之前调用 `wg.Add(1)`；Go 1.25 起直接用 `wg.Go(f)`，它自己处理 Add 和 Done。
- 出处：https://pkg.go.dev/sync#WaitGroup

### 6. go.mod 低于 1.22 时循环变量被闭包共享
- 问题：Go 1.22 之前，循环变量整个循环只有一份，闭包或 goroutine 里读到的是最后一次的值。go.mod 里的 go 版本低于 1.22 时仍是旧行为。
- 怎么认出：`for _, v := range xs { go func() { use(v) }() }`，且 go.mod 里 `go 1.21` 或更低。
- 修法：go.mod 升到 1.22 及以上；或在循环体内写 `v := v`，或把 `v` 作为参数传给闭包。
- 出处：https://go.dev/blog/loopvar-preview

## HTTP 客户端
### 7. http.DefaultClient 没有超时
- 问题：`http.DefaultClient` 和 `http.Get` 没有超时，对端不响应时请求一直挂着，占用 goroutine 和连接。
- 怎么认出：`http.Get(`、`http.Post(`、`http.DefaultClient.Do(`；`http.Client{}` 里没有 `Timeout`，请求也没带超时的 ctx。
- 修法：自建 `&http.Client{Timeout: 10 * time.Second}`，或用 `http.NewRequestWithContext` 配合带超时的 context。
- 出处：https://pkg.go.dev/net/http#Client

### 8. 响应的 Body.Close 没调
- 问题：不关闭响应体，底层连接不能复用，连接和文件句柄越积越多，最终耗尽。
- 怎么认出：`resp, err := client.Do(req)` 之后找不到 `defer resp.Body.Close()`，或写在 err 检查之前。
- 修法：检查完 err 后立刻 `defer resp.Body.Close()`；需要复用连接时先把剩余内容读完。
- 出处：https://pkg.go.dev/net/http#Client.Do

## 循环与资源
### 9. 循环里的 defer 要到函数结束才执行
- 问题：在循环里 `defer f.Close()`，所有文件到整个函数返回时才关，处理大量文件会耗尽句柄。
- 怎么认出：`for` 循环体里有 `defer`。
- 修法：把循环体抽成函数，在函数里 defer；或处理完立刻手动 Close。
- 出处：https://go.dev/ref/spec#Defer_statements

### 10. 循环里用 time.After 造成定时器堆积
- 问题：每次循环创建一个新定时器，到期之前不会被回收（go.mod 低于 1.23 时），高频循环会占大量内存。
- 怎么认出：`for { select { case <-time.After(d): ... } }`。
- 修法：在循环外建一个 `time.NewTimer` 并用 `Reset`；或升级 go.mod 到 1.23 及以上。
- 出处：https://pkg.go.dev/time#After

### 11. Ticker 没有 Stop
- 问题：go.mod 低于 1.23 时，不停止的 `time.Ticker` 不会被回收，函数退出后它仍占着资源。Go 1.23 起垃圾回收能回收没人引用的 ticker。
- 怎么认出：`time.NewTicker(` 后面没有 `defer t.Stop()`。
- 修法：创建后立刻 `defer ticker.Stop()`；或把 go.mod 升到 1.23 及以上。
- 出处：https://pkg.go.dev/time#NewTicker

### 12. rows 不关闭、不检查 rows.Err
- 问题：`db.Query` 返回的 rows 不关闭会占住连接；遍历中途出错没检查，会把不完整的数据当成全部。
- 怎么认出：`rows, err := db.Query(` 后没有 `defer rows.Close()`；`for rows.Next()` 之后没有 `rows.Err()`。
- 修法：检查 err 后 `defer rows.Close()`，循环结束后 `if err := rows.Err(); err != nil { ... }`。
- 出处：https://pkg.go.dev/database/sql#Rows

## 数据与类型
### 13. 切片共享底层数组，append 可能改到别人的数据
- 问题：子切片和原切片共用一块内存，容量够时 `append` 会覆盖原切片后面的元素。
- 怎么认出：`b := a[:2]` 后对 `b` 做 `append`；把切片返回给调用方后自己还在修改。
- 修法：需要独立副本时用 `copy` 或 `slices.Clone`；限制容量用 `a[:2:2]`。
- 出处：https://go.dev/blog/slices-intro

### 14. interface 里装着 nil 指针，不等于 nil
- 问题：返回具体类型的 nil 指针时，接口变量的类型部分非空，`err != nil` 为真，调用方误以为出错。
- 怎么认出：函数返回 `error` 但内部是 `var e *MyErr; return e`。
- 修法：没有错误时直接 `return nil`，不要返回类型化的 nil 指针。
- 出处：https://go.dev/doc/faq#nil_error

### 15. 数值类型转换可能溢出
- 问题：把大整数转成小类型时会静默截断，用来做长度、下标、金额会得到错误结果。
- 怎么认出：`int32(x)`、`uint8(n)`、`int(u64)` 的参数来自外部输入。
- 修法：转换前检查范围，或用 `math.MaxInt32` 等常量比较；金额用整数分或 decimal 库。
- 出处：https://go.dev/ref/spec#Conversions

### 16. 用 == 比较 time.Time
- 问题：`Time` 里包含时区和单调时钟读数，同一时刻的两个值用 `==` 可能不相等。
- 怎么认出：`t1 == t2`、把 `time.Time` 当 map 的 key。
- 修法：用 `t1.Equal(t2)`；零值判断用 `t.IsZero()`。
- 出处：https://pkg.go.dev/time#Time

## 并发细节
### 17. 复制 sync.Mutex 或 WaitGroup
- 问题：锁被复制后，副本和原件互不相干，保护形同虚设。
- 怎么认出：含 `sync.Mutex` 的结构体按值传参或值 receiver；`go vet` 的 copylocks 告警。
- 修法：结构体用指针传递，CI 里跑 `go vet`。
- 出处：https://pkg.go.dev/sync#Mutex

### 18. 重复关闭 channel 或向已关闭的 channel 发送
- 问题：二者都会 panic，多个发送方抢着关闭时很容易出现。
- 怎么认出：多处出现 `close(ch)`；接收方去关闭 channel。
- 修法：只由唯一的发送方关闭；多个发送方时用 `sync.Once` 或单独的 done channel。
- 出处：https://go.dev/ref/spec#Close

### 19. select 没有 default 或退出分支会一直阻塞
- 问题：所有 case 都不就绪时，select 一直等；加上没有 ctx 分支就永远不会退出。
- 怎么认出：`select` 只有 channel 读写分支，没有 `case <-ctx.Done()`，也没有 `default`。
- 修法：加 `case <-ctx.Done(): return ctx.Err()`，需要非阻塞时加 `default`。
- 出处：https://go.dev/ref/spec#Select_statements

### 20. 长任务不检查 context 是否已取消
- 问题：请求已被取消或超时，后台仍在做无用功，占着数据库连接和 CPU。
- 怎么认出：循环或耗时调用里没有检查 `ctx.Err()`，下游调用没有传 ctx。
- 修法：在循环里检查 `ctx.Err()` 或监听 `ctx.Done()`，并把 ctx 传给所有下游调用。
- 出处：https://pkg.go.dev/context

### 21. recover 只在 defer 中才有效
- 问题：在普通代码里调用 `recover()` 拿不到 panic，goroutine 里的 panic 也不会被外层 recover 捕获，进程仍然崩溃。
- 怎么认出：`recover()` 不在 `defer func()` 里；`go func()` 里没有自己的 recover，而外层才有。
- 修法：在每个会 panic 的 goroutine 入口自己 `defer func() { recover() ... }()`，并记录日志。
- 出处：https://go.dev/blog/defer-panic-and-recover

## 网络与安全
### 22. http.Server 没设超时
- 问题：没有读超时，慢速客户端可以长时间占住连接，把服务拖垮（Slowloris）。
- 怎么认出：`http.ListenAndServe(` 或 `&http.Server{}` 没有 `ReadHeaderTimeout`、`ReadTimeout`。
- 修法：自建 `http.Server` 并设置 `ReadHeaderTimeout`、`WriteTimeout`、`IdleTimeout`。
- 出处：https://pkg.go.dev/net/http#Server

### 23. 请求体不限大小
- 问题：直接 `io.ReadAll(r.Body)` 会把攻击者发来的超大请求全读进内存。
- 怎么认出：`io.ReadAll(r.Body)`、`json.NewDecoder(r.Body)` 之前没有大小限制。
- 修法：先 `r.Body = http.MaxBytesReader(w, r.Body, 1<<20)`。
- 出处：https://pkg.go.dev/net/http#MaxBytesReader

### 24. JSON 解码悄悄丢掉对不上的字段
- 问题：默认解码会忽略对不上的键，客户端把字段名拼错也不报错，字段被悄悄丢掉，请求看似成功实际没生效。
- 怎么认出：`json.NewDecoder(r.Body).Decode(&v)` 没有设置 `DisallowUnknownFields`。
- 修法：`dec.DisallowUnknownFields()`，让拼错的字段直接报 400。
- 出处：https://pkg.go.dev/encoding/json#Decoder.DisallowUnknownFields

### 25. 请求直接解码进数据库模型
- 问题：把请求体直接解码进数据库模型再保存，请求里带上 `role`、`is_admin` 之类字段就能改到不该改的列（批量赋值）。
- 怎么认出：`Decode(&user)` 的 `user` 就是写库用的结构体，里面有权限、余额等敏感字段。
- 修法：专门定义只含允许字段的请求结构体，解码进它，再手动拷贝到模型。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html

### 26. SQL 用字符串拼接
- 问题：把用户输入拼进 SQL 会造成 SQL 注入，攻击者可读写整个数据库。
- 怎么认出：`fmt.Sprintf("SELECT ... %s", x)`、`"..." + name` 传给 `db.Query` / `db.Exec`。
- 修法：用占位符 `db.Query("SELECT ... WHERE id = ?", id)`。
- 出处：https://go.dev/doc/database/sql-injection

### 27. 路径拼接未防路径穿越
- 问题：用户给出 `../../etc/passwd` 这类路径，就能读到目录之外的文件。
- 怎么认出：`filepath.Join(base, userInput)` 后直接 `os.Open`，没有检查结果是否仍在 base 之内。
- 修法：用 `os.OpenRoot(base)`（Go 1.24 起）限定在目录内；或清理路径后检查前缀。
- 出处：https://go.dev/blog/osroot

### 28. 日志打印敏感信息
- 问题：密码、令牌、身份证号写进日志，日志的访问范围通常比数据库宽，等于泄漏。
- 怎么认出：`log.Printf("%+v", req)` 打印整个请求或用户对象；日志里出现 `Authorization`、`password`。
- 修法：只记录必要字段，对敏感字段脱敏或不记。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html

### 29. 关闭 TLS 证书校验
- 问题：`InsecureSkipVerify: true` 让中间人可以冒充服务端，窃取或篡改通信内容。
- 怎么认出：`tls.Config{InsecureSkipVerify: true}`，包括放在测试之外的 `http.Transport` 里。
- 修法：保持校验；私有 CA 通过 `RootCAs` 配置，不跳过校验。
- 出处：https://pkg.go.dev/crypto/tls#Config

### 30. 用 sh -c 拼命令
- 问题：把用户输入拼进 `sh -c` 的命令字符串，会被当作 shell 命令执行。
- 怎么认出：`exec.Command("sh", "-c", fmt.Sprintf(...))`。
- 修法：`exec.Command("cmd", arg1, arg2)`，每个参数单独传，对输入做白名单校验。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html

### 31. SSRF：服务端按用户给的 URL 发请求
- 问题：攻击者让服务访问内网地址或云厂商元数据地址，读到内部信息。
- 怎么认出：`http.Get(userURL)`、`client.Do(req)` 的 URL 来自请求参数，没有主机白名单。
- 修法：只允许白名单域名；解析后拒绝内网和回环地址；自定义 `CheckRedirect` 防止被重定向到内网。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
