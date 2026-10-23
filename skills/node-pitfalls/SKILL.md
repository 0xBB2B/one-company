---
name: node-pitfalls
description: Node.js 后端安全与鲁棒性常见坑：运行时校验、批量赋值、原型污染、未处理的 Promise rejection、阻塞事件循环、命令注入。
---
# Node.js 常见坑排查清单

## 输入处理
### 1. 类型只在编译期有效，接口入口要做运行时校验
- 问题：TypeScript 的类型编译后就消失。请求体写成什么类型都没用，攻击者发来的数据形状可以是任意的，后面代码按错误形状处理会崩溃或越权。
- 怎么认出：`req.body as X`、`const body: X = req.body`，处理函数里没有校验库的 parse 或手写校验。
- 修法：入口处用校验库（如 zod）或 JSON Schema 校验，校验失败直接返回 400，通过后才使用。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html

### 2. 校验库默认放过多余字段，导致批量赋值
- 问题：请求里夹带 `role`、`isAdmin` 之类多余字段，如果整个对象直接写进数据库或展开合并，用户就能改自己不该改的字段。
- 怎么认出：`User.create(req.body)`、`Object.assign(user, req.body)`、`{ ...user, ...req.body }`；校验通过后后面仍然使用 `req.body`，而不是校验返回的结果。
- 修法：只使用校验后返回的对象，不再用 `req.body`；zod 默认会在返回值里去掉多余字段，要直接拒绝就用 `z.strictObject(...)`（zod 4）。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html 、https://zod.dev/api

### 3. __proto__ 原型污染
- 问题：深度合并或按路径赋值时，输入里的 `__proto__`、`constructor` 键会改到所有对象共用的原型，影响整个进程的行为。
- 怎么认出：自写的 merge / set / clone 函数递归复制外部对象的键；`obj[key][key2] = value` 的 key 来自请求。
- 修法：过滤 `__proto__`、`constructor`、`prototype` 三个键；用 `Object.create(null)` 或 `Map` 存外部键；使用已修复的合并库。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Prototype_Pollution_Prevention_Cheat_Sheet.html

## 进程与事件循环
### 4. 未处理的 Promise rejection（unhandledRejection）会让进程退出
- 问题：Node 15 起，没人处理的 rejection 默认抛出错误，进程直接退出。一个漏掉的 `.catch` 就能把服务打挂。
- 怎么认出：`async` 函数被调用后既没 `await` 也没 `.catch`；`new Promise` 里的异步回调抛错；`forEach(async ...)`。
- 修法：调用处 `await` 并 try/catch，或链上 `.catch`；用 `Promise.all` 替代 `forEach(async)`；顶层加 `process.on('unhandledRejection')` 只做记录和优雅退出。
- 出处：https://nodejs.org/api/cli.html#--unhandled-rejectionsmode

### 5. 同步重活阻塞事件循环
- 问题：Node 用一个线程处理所有请求，一个请求里做长时间同步计算，其他请求全部卡住。
- 怎么认出：请求路径里的 `*Sync` 函数（`readFileSync`、`pbkdf2Sync`）、大 JSON 的 `JSON.parse`、复杂正则、大循环。
- 修法：改用异步版本；重计算放到 `worker_threads` 或独立服务；给正则输入加长度限制。
- 出处：https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop

### 6. child_process.exec 拼字符串造成命令注入
- 问题：`exec` 把整个字符串交给 shell 执行，用户输入里的 `;`、`$()`、反引号会被当成命令执行。
- 怎么认出：`exec(` 或 `execSync(` 的参数里有模板字符串或 `+` 拼接了外部输入。
- 修法：改用 `execFile` / `spawn`，把参数放进数组，不开 `shell: true`；对输入做白名单校验。
- 出处：https://nodejs.org/api/child_process.html#child_processexeccommand-options-callback

## 文件与路径
### 7. 路径穿越
- 问题：用户传入 `../../etc/passwd`，拼进路径后就能读写目录之外的文件。
- 怎么认出：`path.join(base, req.query.file)` 后直接 `fs.readFile`，没有检查结果是否仍在 base 之内；`res.sendFile(userInput)`。
- 修法：`path.resolve` 之后检查是否以 `base + path.sep` 开头；或只接受文件 ID，由服务端映射到路径。
- 出处：https://owasp.org/www-community/attacks/Path_Traversal

### 8. 先检查再使用的竞态（TOCTOU）
- 问题：先 `fs.access` / `existsSync` 再打开文件，两步之间文件可能被换掉，检查失去意义。
- 怎么认出：`if (fs.existsSync(p)) { fs.readFileSync(p) }`。
- 修法：直接打开，处理 ENOENT 错误。
- 出处：https://nodejs.org/api/fs.html#fsaccesspath-mode-callback

### 9. 流的错误没处理
- 问题：`pipe` 不会把一端的错误传给另一端，出错后另一端不关闭，句柄泄漏，错误事件没监听还会让进程崩。
- 怎么认出：`a.pipe(b)` 没有监听 `error`。
- 修法：改用 `stream.pipeline(a, b, cb)` 或 `await pipeline(...)`。
- 出处：https://nodejs.org/api/stream.html#streampipelinesource-transforms-destination-callback

### 10. EventEmitter 的 error 事件没有监听
- 问题：触发 `error` 事件且没有监听器时，Node 会抛出异常，进程崩溃。
- 怎么认出：自定义 EventEmitter、socket、stream 上没有 `.on("error", ...)`。
- 修法：为每个会触发 error 的对象注册处理函数。
- 出处：https://nodejs.org/api/events.html#error-events

## 注入与不可信输入
### 11. SQL 查询拼字符串
- 问题：把用户输入拼进 SQL 会被注入，攻击者可读写整个数据库。
- 怎么认出：`` db.query(`SELECT ... ${id}`) ``、`"... " + name` 传给 `query` / `execute`。
- 修法：用参数化查询：`db.query("SELECT ... WHERE id = $1", [id])`。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html

### 12. NoSQL 查询直接塞用户给的对象
- 问题：把请求里的对象直接当 Mongo 查询条件，攻击者可以传 `{"$ne": null}` 这类运算符，绕过账号密码比对。
- 怎么认出：`User.findOne({ name: req.body.name, pass: req.body.pass })`，没有检查字段必须是字符串。
- 修法：先校验字段类型必须是字符串（或用 `String(x)`），再查询；不信任能带运算符的对象。
- 出处：https://cwe.mitre.org/data/definitions/943.html 、https://www.mongodb.com/docs/manual/reference/operator/query/ne/

### 13. eval、new Function 执行外部字符串
- 问题：这些函数把字符串当代码执行，外部输入进去就是远程代码执行。
- 怎么认出：`eval(`、`new Function(`、`vm.runInNewContext(`、字符串形式的 `setTimeout("...")`。
- 修法：解析数据用 `JSON.parse`；动态行为用白名单函数表。注意 `vm` 模块不是安全沙箱。
- 出处：https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval#never_use_direct_eval!

### 14. ReDoS：正则回溯耗尽 CPU
- 问题：写得不好的正则遇到特殊输入时匹配时间指数增长，单个请求就能卡死事件循环。
- 怎么认出：嵌套量词 `(a+)+`、`(.*)*`，或 `(a|a)*` 这种重叠分支，用来匹配外部输入。
- 修法：改写成无歧义的正则，限制输入长度，或使用线性时间匹配库。
- 出处：https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS

### 15. SSRF：服务端按用户给的 URL 发请求
- 问题：攻击者让服务访问内网地址或云厂商元数据地址，读到内部信息。
- 怎么认出：`fetch(req.body.url)`、`axios.get(userUrl)`，没有主机白名单。
- 修法：只允许白名单域名；解析后拒绝内网和回环地址，并禁止自动跟随重定向。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

### 16. Buffer：new Buffer 与 allocUnsafe
- 问题：`new Buffer(n)` 已废弃，旧版本可能返回未清零的内存，泄漏之前的数据；`Buffer.allocUnsafe` 同样不清零。
- 怎么认出：`new Buffer(`、`Buffer.allocUnsafe(`。
- 修法：用 `Buffer.alloc(n)`（清零）和 `Buffer.from(...)`。
- 出处：https://nodejs.org/api/buffer.html#static-method-bufferallocunsafesize

## 超时与限流
### 17. 出站请求的超时没有按业务设置
- 问题：Node 自带的 `fetch`（undici）默认等响应头、响应体各 300 秒才超时，对端卡住时请求会挂五分钟；axios 默认 `timeout` 是 0，即永不超时。
- 怎么认出：`fetch(url)` 没有 `signal`；`axios.get(url)` 没有 `timeout`。
- 修法：`fetch(url, { signal: AbortSignal.timeout(5000) })`；axios 设 `timeout`。
- 出处：https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay 、https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Client.md 、https://github.com/axios/axios#request-config

### 18. HTTP 服务端超时被关掉或设得过大
- 问题：Node 18 起 `requestTimeout` 默认 300 秒、`headersTimeout` 默认 60 秒，已经有保护；被设成 0 或很大的值，或低于 Node 18 时，慢速连接就能长时间占着套接字。
- 怎么认出：代码里 `server.requestTimeout = 0`、`server.headersTimeout = 0` 或很大的值；项目运行在 Node 18 以下。
- 修法：去掉 `0` 的覆盖，按业务设置合理的值；升级到 Node 18 及以上，前面放反向代理。
- 出处：https://nodejs.org/api/http.html#serverrequesttimeout

### 19. 请求体大小限制被放得很大
- 问题：`express.json()` 默认限制是 100kb；被调成几十 MB，或自己拼接请求体时没有上限，攻击者发超大 JSON 就会占满内存并阻塞事件循环。
- 怎么认出：`express.json({ limit: "50mb" })`；自己写 `req.on("data", chunk => body += chunk)` 且没有累计长度检查。
- 修法：保持默认或按接口设小的 `limit`；只在确实需要上传的接口单独调大；自拼请求体时超过上限就中断连接。
- 出处：https://expressjs.com/en/resources/middleware/body-parser.html#limit

## 密码学与会话
### 20. 用 Math.random 生成令牌
- 问题：`Math.random` 可预测，生成的会话令牌、重置码可被猜中。
- 怎么认出：令牌、验证码、ID 的生成用了 `Math.random()` 或时间戳。
- 修法：`crypto.randomBytes(32).toString("hex")` 或 `crypto.randomUUID()`。
- 出处：https://nodejs.org/api/crypto.html#cryptorandombytessize-callback

### 21. 用 === 比较密钥或签名
- 问题：普通比较在第一个不同字符处就返回，响应时间泄漏了匹配了多少位，可被逐位猜测。
- 怎么认出：`sig === expected`、`token === stored`。
- 修法：两个等长 Buffer 用 `crypto.timingSafeEqual`，先比较长度。
- 出处：https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b

### 22. Express 的安全配置缺失
- 问题：默认暴露 `X-Powered-By`，Cookie 没有 `httpOnly`、`secure`，生产环境把错误堆栈返回给用户。
- 怎么认出：没使用 helmet；`res.cookie(` 没设置选项；错误处理中间件把 `err.stack` 发给客户端。
- 修法：用 helmet，Cookie 加 `httpOnly`、`secure`、`sameSite`，`NODE_ENV=production`，错误只返回通用信息。
- 出处：https://expressjs.com/en/advanced/best-practice-security.html

## 进程与依赖
### 23. uncaughtException 之后继续运行
- 问题：出现未捕获异常后进程状态已不可信，继续服务可能带着损坏的状态处理请求。
- 怎么认出：`process.on("uncaughtException", () => { /* 记录后继续 */ })`。
- 修法：只用来记录日志和清理，随后退出进程，由进程管理器重启。
- 出处：https://nodejs.org/api/process.html#warning-using-uncaughtexception-correctly

### 24. 收到 SIGTERM 没有优雅退出
- 问题：容器停止时请求被直接中断，数据库连接、队列消息处理到一半丢失。
- 怎么认出：没有 `process.on("SIGTERM", ...)`；或处理函数里直接 `process.exit()`。
- 修法：收到信号后先停止接收新连接（`server.close`），等处理中的请求结束，再关闭连接并退出。
- 出处：https://nodejs.org/api/process.html#signal-events

### 25. 依赖未锁定、漏洞没检查
- 问题：安装时版本漂移可能装到有漏洞或被投毒的版本，线上和本地行为不一致。
- 怎么认出：没提交 lockfile；CI 里用 `npm install` 而不是 `npm ci`；从不运行 `npm audit`。
- 修法：提交 lockfile，CI 用 `npm ci`，定期 `npm audit` 并升级有漏洞的包。
- 出处：https://docs.npmjs.com/cli/v10/commands/npm-ci
