---
name: skills-and-acceptance
description: 19 份 skill 的覆盖主题与格式（每份不超过 200 行，每项问题、怎么认出、修法、出处）；Go、Vue 埋坑样例项目的真实模型验收
date: 2026-10-21
---

# skill 内容与真实模型验收

几个词先说清：
- skill：一份 `SKILL.md` 文件，开头是设置段（name、description），下面是正文。角色定义在 `skills: [...]` 里写了它，派出这个代理时程序就把它的全文拼进任务说明。
- 编码规范 skill：写"这个技术栈的代码应该怎么写"，名字以 `-coding` 结尾。
- 排查清单 skill：写"这个技术栈或服务常见的安全和鲁棒性问题"，名字以 `-pitfalls` 结尾，或是通用的服务类清单。
- 检查项：skill 正文里的一条，固定写四样：问题、怎么在代码里认出来、修法、出处链接。
- 埋坑样例项目：测试用的小项目，里面故意留了已知问题，用来检查审查能不能找出来。

## 用户故事
### P0：作为审查代理，我想要拿到按技术栈整理、带修法和出处的清单，以便逐项对照本次改动，找出问题并写出具体修法
**用例（主路径）**
- 场景：go-reviewer 审一个改动，改动里 `api/client.go:42` 写了 `resp, err := http.Get(url)`。
- 操作：go-reviewer 对照 go-pitfalls 里"HTTP 请求没有超时"那一项。
- 预期：意见列为阻塞，写明 `api/client.go:42`、触发条件（下游不响应时请求一直挂着）、修法（自建带 Timeout 的 `http.Client` 或用 `NewRequestWithContext` + `context.WithTimeout`，用完关闭 `resp.Body`）。

### P0：作为用户，我想要证据证明专项审查真能找出技术栈特有的坑，以便决定以后要不要推广到其他职责
**用例（主路径）**
- 场景：跑 Go、Vue 两条新的真实模型验收。
- 操作：`pnpm run test:acceptance:parallel --only P15 P16`。
- 预期：两条都通过，即专项审查把样例项目里埋的每个坑都列为阻塞，并指出文件和行号，意见里说中了这个坑。

## 约束
- C-1：包里的 `skills/` 新增 19 个目录，每个目录一份 `SKILL.md`，目录名、设置段的 name 都和下表的名字一致；设置段的 description 用一句话写清覆盖什么。
- C-2：每份 `SKILL.md` 连设置段在内不超过 200 行；用中文大白话写，代码标识符保持英文。
- C-3：正文由检查项组成，每一项都写四样：
  - 问题：一句话写出是什么问题、会造成什么后果（编码规范 skill 写违反了哪条规范、会带来什么麻烦）。
  - 怎么认出：代码里能看见的特征，例如函数名、写法、缺了什么调用，审查代理能据此在 diff 里找到。
  - 修法：具体怎么改，必要时带一两行示例。
  - 出处：至少一个 https 链接。优先用语言、框架、服务的官方文档或规范，以及 OWASP 等标准组织的页面；只找得到二手资料（博客、课程、播客摘要）时，在链接后注明「二手资料」。
- C-4：写入 skill 时，每个出处链接都实际打开过一次，能返回页面（HTTP 状态 2xx 或 3xx）；打不开的换一个出处，换不到就删掉这一项。
- C-5：每份 skill 至少覆盖下表列出的主题（每个主题至少一项检查项），200 行放得下时再补充同类常见问题：

  | skill | 必须覆盖的主题 |
  |---|---|
  | go-coding | error 不忽略、用 %w 包装并用 errors.Is / errors.As 判断；context 作为第一个参数、不存进结构体；接口在使用方定义、保持小；命名和包名按 Go Code Review Comments；用 defer 释放资源；普通错误不用 panic |
  | go-pitfalls | 写 nil map 会 panic；map 并发读写会让进程崩溃；数据竞争（用 `go test -race` 查）；goroutine 泄漏（发送方没有退出途径）；`http.DefaultClient` 没有超时、`resp.Body` 没关闭；go.mod 声明低于 1.22 时循环变量被闭包共享；`WaitGroup.Add` 放在子 goroutine 里 |
  | typescript-coding | 开 strict；不用 any，外部数据用 unknown 再收窄；不用 `as` 断言外部输入；联合类型用 never 做穷尽检查；能 readonly / const 的就不可变 |
  | node-pitfalls | 类型只在编译期有效，接口入口要做运行时校验；校验库默认放过多余字段导致批量赋值；`__proto__` 原型污染；未处理的 Promise rejection 在 Node 15 起会让进程退出；同步重活阻塞事件循环；`child_process.exec` 拼接字符串造成命令注入 |
  | python-coding | 命名和格式按 PEP 8；函数签名写类型标注（PEP 484）；不写裸 `except:`、不吞异常；资源用 with 管理；日志用参数化写法，不提前拼字符串 |
  | python-pitfalls | pickle、`yaml.load` 反序列化不可信数据；可变默认参数；asyncio 协程里调用阻塞函数；`subprocess` 用 `shell=True` 拼接造成命令注入；对外部输入用 eval / exec |
  | java-coding | 命名和格式按 Google Java Style 或阿里巴巴 Java 开发手册；不吞异常、不 catch Throwable；equals 和 hashCode 一起重写；资源用 try-with-resources；Optional 只做返回值 |
  | java-pitfalls | 反序列化不可信数据（ObjectInputStream、Jackson 多态类型）；`@Transactional` 失效（同类自调用、非 public、受检异常默认不回滚）；用 `Executors` 创建无界队列的线程池；连接和流没关闭；Spring Boot Actuator 端点对外暴露；`SimpleDateFormat` 多线程共用 |
  | vue-coding | 按 Vue 官方风格指南：组件名多个单词、prop 定义写全、v-for 带稳定 key、v-if 不和 v-for 写在同一元素；用 `<script setup lang="ts">`；computed 里不写副作用；不直接改 props |
  | vue-pitfalls | 把用户内容当组件模板；`v-html` 渲染用户内容造成 XSS；`:href` 绑定用户 URL（`javascript:`）；用户可控的 style；Vue 挂载到含用户内容的服务端页面上；解构 reactive 对象丢失响应式；`onMounted` 里加的监听和定时器在 `onUnmounted` 没清理；路由守卫只当 UX，权限必须后端校验 |
  | react-coding | 按 Rules of React：Hooks 只在顶层调用、组件和 Hooks 保持纯；列表 key 稳定且唯一；能算出来的值不存 state；useEffect 只用来和外部系统同步 |
  | react-pitfalls | `dangerouslySetInnerHTML` 渲染用户内容；href 绑定用户 URL（`javascript:`）；useEffect 依赖漏写、没有清理函数；请求竞态（旧请求的结果覆盖新的）；用数组下标当 key；闭包拿到过期的 state |
  | web-api-security | 按 OWASP Top 10:2025 对照；越权（IDOR / BOLA）：每次按 ID 访问对象都在服务端校验归属；SSRF：目标地址白名单、解析后校验 IP 防 DNS 重绑定、关闭自动重定向、拦截云元数据地址；XSS：输出按上下文编码；批量赋值：只接收白名单字段；报错不把内部细节返回给调用方 |
  | auth-session | JWT 验签时显式传入算法白名单、拒绝 `alg: none`、使用强密钥；Cookie 设置 HttpOnly、Secure、SameSite；表单和改状态的请求带 CSRF token；token 存 localStorage 会被 XSS 读走；密码用 argon2id 或 bcrypt 哈希；登出和改密后让旧 token 失效 |
  | supply-chain | CI 安装依赖用 `npm ci --ignore-scripts`（或 `.npmrc` 里 `ignore-scripts=true`），需要构建脚本的原生包单独 rebuild；lockfile 提交进仓库并冻结安装；版本写死（save-exact）；新版本发布后等一段冷却期再升级；新增依赖要经用户同意；以 2025 年 Shai-Hulud 投毒事件为例说明 postinstall 风险 |
  | relational-db | SQL 拼接用户输入造成注入，用预编译加参数占位符，动态表名列名走白名单；深分页 `OFFSET` 很慢，改用 keyset 分页；死锁：事务短小、按固定顺序访问行、捕获死锁错误后重试；N+1 查询；事务边界和连接池（连接没归还、池太小） |
  | redis | 缓存穿透（参数校验、缓存空值、布隆过滤器）；缓存击穿（singleflight、互斥锁、逻辑过期）；缓存雪崩（TTL 加随机抖动、多级缓存、限流）；分布式锁误删（`SET key token NX PX` 加锁、Lua 比对 token 后删除）；Redlock 的争议与 fencing token；大 key 和热 key（`--bigkeys`、`--hotkeys`、`UNLINK`） |
  | message-queue | 至少一次投递下的重复消费：把已处理的消息 ID 和业务改动放在同一个事务里，用唯一键去重，不拿 offset 当 ID；写库和发消息的双写不一致用 Outbox；offset 或 ack 提交时机不对造成丢消息；需要顺序的消息按 key 分区；处理不了的消息进死信队列 |
  | service-runtime | 跨进程调用必须设超时；重试只在一层做、指数退避加随机抖动、限制重试次数（重试预算），只重试幂等请求；非幂等写用幂等键；限流；收到 SIGTERM 后优雅停机；日志里不打印密码、token 等敏感信息；密钥不写进代码和日志 |

- C-6：skill 只放在包里；用户在项目的 `.pi/skills/<名字>/` 或用户层的 skills 目录放同名 skill 时用用户的那份（现有查找顺序）。
- C-7：新增两条真实模型单点验收，编号 P15、P16，放在 `tests/acceptance/points/` 下，跑法和判定规则与现有单点验收相同（同一提交先同时跑 2 次，都过算通过，一过一不过跑第 3 次）：
  - P15（Go）：一个 Go 埋坑样例项目，一个执行定义是 go-worker 的任务（程序自动挂上 go-reviewer），改动里埋 5 个坑：用 `http.Get` 发请求没有超时；往没有 make 的 map 里写数据；多个 goroutine 不加锁写同一个 map；用字符串拼接把用户输入拼进 SQL；用 `DEL` 直接释放 Redis 分布式锁、不比对 token。PM 派审查后，判定看 go-reviewer 那一份结论。
  - P16（Vue）：一个 Vue 埋坑样例项目，一个执行定义是 vue-worker 的任务（程序自动挂上 vue-reviewer），改动里埋 5 个坑：用 `v-html` 渲染用户评论；`:href` 直接绑定用户填的链接；`onMounted` 里 `window.addEventListener`，`onUnmounted` 没移除；路由守卫里按用户角色放行管理页，后端接口不校验权限；解构 `reactive()` 的返回值后在模板里使用。PM 派审查后，判定看 vue-reviewer 那一份结论。
  - 通过条件：专项审查的结论是打回；5 个坑每个都有一条阻塞意见，意见里的文件就是埋坑的文件，意见文字里有这个坑的关键词（每个坑列几个同义说法，例如 SQL 拼接的坑认「拼接 / 注入 / 参数化 / 绑定」）；行号不参与判定。
- C-8：typescript-coding 写明 tsconfig 严格选项是新建或修改 tsconfig 时的写法；项目没有 tsconfig 时，不自行加严格参数去检查（包括测试文件），按项目已有的检查方式来，项目 AGENTS.md 优先。

## 验收
- [ ] AC-1 ← C-1、C-2：`skills/` 下有 C-5 表里的 19 个目录，每个的 `SKILL.md` 设置段 name 和目录名一致、description 不为空，总行数都不超过 200。
- [ ] AC-2 ← C-3：每份 skill 的每个检查项都有问题、怎么认出、修法、出处四部分，出处至少一个以 `https://` 开头的链接；标了「二手资料」的项目单独列出给用户过目。
- [ ] AC-3 ← C-4：写完 skill 后跑一次链接检查，列出全部出处链接和各自的 HTTP 状态，没有 4xx、5xx 或连不上的；检查结果写进提交说明。
- [ ] AC-4 ← C-5：对每份 skill，表里每个主题都能找到对应的检查项（由测试按每个主题的关键词检查，例如 go-pitfalls 要能找到 `DefaultClient`、`-race`、`nil map`）。
- [ ] AC-5 ← C-6：项目受信任、`.pi/skills/go-pitfalls/SKILL.md` 存在时，派 go-reviewer，任务说明里拼进去的是项目里这一份。
- [ ] AC-6 ← C-7：P15、P16 按规则判定为通过：每次运行里专项审查的结论都是打回，5 个坑各有一条阻塞意见，文件是埋坑的文件、意见文字说中这个坑；同一文件里无关的阻塞意见不算命中。
- [ ] AC-7 ← C-8：typescript-coding 里有"项目没有 tsconfig 时不自行加严格参数检查"这一条。

## 验证路径
1. 列出 `skills/` 下的目录，逐个数行数、读设置段（AC-1）；抽读每份 skill 的检查项格式（AC-2）。
2. 跑链接检查脚本，看每个链接的状态（AC-3）；跑主题关键词测试（AC-4）。
3. 在项目里放一份同名 go-pitfalls，派 go-reviewer，读任务说明（AC-5）。
4. `pnpm run test:acceptance:parallel --only P15 P16`，看判定结果和审查意见（AC-6）。
