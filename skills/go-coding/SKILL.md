---
name: go-coding
description: Go 编码规范：错误处理、context、接口、命名、资源释放，写 Go 代码时遵守、审查 Go 代码时逐项对照。
---
# Go 编码规范

## 错误处理
### 1. 不忽略 error
- 问题：用 `_` 丢掉 error 或调用后不检查，失败被悄悄吞掉，后面的逻辑拿着坏数据继续跑，出事时无从查起。
- 怎么认出：`_ = f()`、`x, _ := f()`，或返回 error 的函数被当作语句直接调用。
- 修法：检查并处理；确实不需要处理时，写清为什么可以忽略。示例：`if err := f(); err != nil { return err }`。
- 出处：https://go.dev/wiki/CodeReviewComments#handle-errors

### 2. 用 %w 包装，用 errors.Is / errors.As 判断
- 问题：用 `%v` 包装会丢掉原始错误，调用方没法判断是哪种错；用 `==` 或类型断言比较，包装一层就失效。
- 怎么认出：`fmt.Errorf("...: %v", err)`；`err == ErrXxx`；`err.(*MyErr)`。
- 修法：包装用 `fmt.Errorf("读配置: %w", err)`；判断用 `errors.Is(err, ErrXxx)`，取具体类型用 `errors.As(err, &target)`。
- 出处：https://go.dev/blog/go1.13-errors

### 3. 普通错误不用 panic
- 问题：panic 会让整个程序崩溃，调用方无法按正常流程处理。输入不合法、文件不存在这类可预期的错误不该 panic。
- 怎么认出：业务代码里的 `panic(err)`、`log.Fatal` 出现在库函数或请求处理路径中。
- 修法：返回 error 让调用方决定；panic 只留给程序自身的不变量被破坏这种“不应发生”的情况。
- 出处：https://go.dev/wiki/CodeReviewComments#dont-panic

## context 与接口
### 4. context.Context 作第一个参数，不存进结构体
- 问题：把 context 存在结构体里，它的取消和超时会被绑在结构体的整个生命周期上，每次调用无法用自己的截止时间。
- 怎么认出：结构体字段类型是 `context.Context`；需要 context 的函数没有把它放在第一个参数，或自己用 `context.Background()`。
- 修法：每个方法接收 `ctx context.Context` 作第一个参数，一路向下传。
- 出处：https://go.dev/blog/context-and-structs

### 5. 接口在使用方定义，保持小
- 问题：在实现方提前定义大接口，使用方被迫依赖用不到的方法，测试替身也难写。
- 怎么认出：实现包里与结构体同时出现的大接口（方法多）；接口只有一个实现且没有使用方需要替换。
- 修法：在使用方包里按自己需要的几个方法定义接口，函数返回具体类型、参数接收接口。
- 出处：https://go.dev/wiki/CodeReviewComments#interfaces 、https://go.dev/doc/effective_go#interfaces

## 命名与资源
### 6. 命名和包名按 Go Code Review Comments
- 问题：命名不统一，读代码的人要多花时间猜意思，工具和同事的预期也对不上。
- 怎么认出：包名带下划线或大写、叫 `util` / `common`；变量用 `user_id`；包名在类型名里重复（`user.UserService`）。
- 修法：包名短、小写、单个单词；用驼峰；跑 `gofmt` 和 `go vet`。
- 出处：https://go.dev/wiki/CodeReviewComments#package-names

### 7. 用 defer 释放资源
- 问题：靠手写在每个返回点释放，漏掉一个分支就泄漏文件句柄、锁或连接。
- 怎么认出：`os.Open`、`Lock()`、`rows, err := db.Query` 之后找不到紧跟的 `defer`。
- 修法：检查完 err 后立刻 `defer f.Close()` / `defer mu.Unlock()`。注意循环里的 defer 要等函数结束才执行，循环体较大时拆成函数。
- 出处：https://go.dev/doc/effective_go#defer

## 错误与返回值
### 8. 错误信息小写开头、不加句号
- 问题：错误信息经常被拼进别的信息里，大写开头和句号会让拼出来的整句很别扭。
- 怎么认出：`errors.New("Failed to open file.")`、`fmt.Errorf("Invalid input")`。
- 修法：写成 `errors.New("open config: file not found")`，小写开头，不加标点，专有名词除外。
- 出处：https://go.dev/wiki/CodeReviewComments#error-strings

### 9. 不用特殊值（-1、空串）表示失败
- 问题：用 `-1`、`""`、`nil` 这类特殊值表示失败，调用方容易忘记检查，把特殊值当真值用。
- 怎么认出：函数返回 `-1` 表示没找到；返回空字符串表示出错；文档里写“失败时返回 X”。
- 修法：多返回一个 `error` 或 `ok bool`：`func Lookup(key string) (value string, ok bool)`。
- 出处：https://go.dev/wiki/CodeReviewComments#in-band-errors

### 10. 先处理错误，正常流程不缩进
- 问题：`if err == nil { 正常逻辑 } else { return err }` 让正常逻辑越缩越深，读起来费劲。
- 怎么认出：`if err == nil {` 包着大段代码；`else` 里只有 `return`。
- 修法：写成 `if err != nil { return err }`，正常逻辑留在最外层。
- 出处：https://go.dev/wiki/CodeReviewComments#indent-error-flow

### 11. 长函数不用裸 return
- 问题：有命名返回值时，裸 `return` 返回的是哪些值要往上翻才能看懂，容易返回错值。
- 怎么认出：函数体超过几行且出现单独一行的 `return`。
- 修法：长函数明确写 `return x, err`；命名返回值只用来说明含义，或配合 `defer` 修改返回错误。
- 出处：https://go.dev/wiki/CodeReviewComments#named-result-parameters

## 命名与注释
### 12. receiver 命名简短且一致
- 问题：receiver 叫 `this`、`self`，或同一类型的各方法用不同名字，读者要多想一步。
- 怎么认出：`func (this *Server) ...`；同一类型里 `(s *Server)` 和 `(srv *Server)` 混用。
- 修法：用类型名的一两个字母缩写，所有方法保持同一个名字。
- 出处：https://go.dev/wiki/CodeReviewComments#receiver-names

### 13. 方法 receiver 类型选对：指针或值
- 问题：该改状态的方法用了值 receiver，改动改在副本上丢失；同一类型两种混用，方法集不一致，实现接口时容易出错。
- 怎么认出：值 receiver 的方法里给字段赋值；同一类型既有 `(s S)` 又有 `(s *S)` 的方法。
- 修法：要修改状态、结构体较大就用指针 receiver；同一类型的方法保持同一种。
- 出处：https://go.dev/wiki/CodeReviewComments#receiver-type

### 14. 导出符号写文档注释
- 问题：导出的类型和函数没有注释，使用者只能读实现；godoc 里也是空的。
- 怎么认出：大写开头的函数、类型、常量上方没有注释，或注释不以名字开头。
- 修法：注释是完整句子，并以符号名开头：`// Server 处理 ...`。
- 出处：https://go.dev/wiki/CodeReviewComments#doc-comments

### 15. 变量名长度跟作用域成正比
- 问题：作用域很大的变量叫 `i`、`x`，读者不知道含义；很小的循环变量叫 `indexOfCurrentItem`，又太啰嗦。
- 怎么认出：包级变量或跨几十行使用的变量只有一个字母；三行内的循环变量名特别长。
- 修法：小作用域用短名（`i`、`r`），大作用域用能说明含义的名字。
- 出处：https://go.dev/wiki/CodeReviewComments#variable-names

### 16. 缩写保持同一大小写
- 问题：`Id`、`Url`、`Http` 与社区写法不一致，工具和同事搜索时容易漏。
- 怎么认出：`userId`、`ServeHttp`、`parseUrl`。
- 修法：写成 `userID`、`ServeHTTP`、`parseURL`。
- 出处：https://go.dev/wiki/CodeReviewComments#initialisms

### 17. 不用 Get 前缀，单方法接口以 -er 命名
- 问题：`GetName()` 是别的语言的习惯，在 Go 里多余；接口名不统一会让人猜不到含义。
- 怎么认出：`func (u *User) GetName() string`；一个方法的接口叫 `ReadInterface`。
- 修法：getter 直接叫 `Name()`，setter 叫 `SetName()`；单方法接口叫 `Reader`、`Closer`。
- 出处：https://go.dev/doc/effective_go#Getters

### 18. 包级变量和 init 尽量少
- 问题：包级可变变量和 `init()` 让行为依赖导入顺序，测试之间互相影响，也难以替换。
- 怎么认出：`var db *sql.DB` 之类的可变全局变量；`init()` 里读环境变量或连接外部服务。
- 修法：把依赖作为参数或结构体字段传入，在 `main` 里显式组装；全局只留常量和不可变值。
- 出处：https://google.github.io/styleguide/go/best-practices#global-state

### 19. 让零值可用
- 问题：类型必须先调用构造函数才能用，使用者忘了初始化就会 panic 或行为错误。
- 怎么认出：结构体里的 map 字段在零值（nil）时直接被写入，所以使用前必须先调用 `New`；文档里写着“必须调用 New”。
- 修法：设计成零值就能用，如 `sync.Mutex`、`bytes.Buffer`；字段在第一次用到时再创建。
- 出处：https://go.dev/doc/effective_go#allocation_new

### 20. 声明空切片用 var，不用 []T{}
- 问题：`[]string{}` 与 `nil` 切片行为大多一样，但前者多余，JSON 编码结果也不同（`[]` 与 `null`）。
- 怎么认出：`s := []string{}` 之后只做 append，且没有刻意要求输出 `[]`。
- 修法：写 `var s []string`；确实需要 JSON 输出 `[]` 时再用字面量。
- 出处：https://go.dev/wiki/CodeReviewComments#declaring-empty-slices

### 21. 导入分组、不用 dot import
- 问题：`import .` 让读者分不清符号从哪来；标准库和第三方混在一起不易看。
- 怎么认出：`import . "pkg"`；一个 import 块里标准库与第三方库交错。
- 修法：标准库一组，第三方一组，用 `goimports` 自动整理；不用 dot import。
- 出处：https://go.dev/wiki/CodeReviewComments#imports

## 并发与测试
### 22. 对外同步，调用方想异步自己加 go
- 问题：函数内部自己起 goroutine 并立刻返回，调用方无法知道何时完成，也难以测试。
- 怎么认出：公开函数里直接 `go ...` 然后返回，没有返回完成信号。
- 修法：函数写成同步的，需要并发时由调用方 `go f()`。
- 出处：https://go.dev/wiki/CodeReviewComments#synchronous-functions

### 23. 测试用 table-driven，失败信息写清输入和期望
- 问题：每个用例复制一遍代码，很难加用例；失败只显示 `failed`，看不出是哪个输入。
- 怎么认出：一个测试函数里反复出现相同的调用加断言；`t.Error("failed")`。
- 修法：用用例切片加 `t.Run(name, ...)`；失败信息写成 `f(%v) = %v, want %v`。
- 出处：https://go.dev/wiki/TableDrivenTests

### 24. 用 crypto/rand 生成密钥和令牌
- 问题：`math/rand` 的结果可以被预测，用来生成令牌或密码会被攻击者猜中。
- 怎么认出：生成 token、密码、盐值的代码 import 了 `math/rand`。
- 修法：改用 `crypto/rand`（如 `rand.Read`）。
- 出处：https://go.dev/wiki/CodeReviewComments#crypto-rand

### 25. 小结构体和基本类型直接传值
- 问题：为了“省几个字节”到处传指针，反而让代码到处要处理 nil。
- 怎么认出：参数是 `*string`、`*int`，或指向很小结构体的指针，函数里没有修改它，指针也不是用来表示"可以不传"。
- 修法：传值；只有需要修改、结构体很大或含不能复制的字段时才传指针。
- 出处：https://go.dev/wiki/CodeReviewComments#pass-values

### 26. 每个包有一条包注释
- 问题：没有包注释，godoc 里看不到这个包是干什么的，使用者要翻源码。
- 怎么认出：包里所有文件的 `package xxx` 上方都没有注释。
- 修法：在其中一个文件的 `package` 上方写 `// Package xxx 提供 ...`，以 `Package 包名` 开头。
- 出处：https://go.dev/wiki/CodeReviewComments#package-comments
