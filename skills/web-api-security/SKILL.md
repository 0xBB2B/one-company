---
name: web-api-security
description: Web 与 API 接口安全排查清单，按 OWASP Top 10:2025 对照：越权、SSRF 防护要点、XSS 输出编码、批量赋值、CORS、开放重定向、文件上传、报错泄漏、安全响应头等。
---
# Web 与 API 安全排查清单

下面的编号 A01 到 A10 指 OWASP Top 10:2025 的类别（A01 访问控制失效、A02 安全配置错误、A05 注入、A06 不安全设计、A09 日志与告警失败、A10 异常情况处理不当）。

## 访问控制（A01）
### 1. 接口只校验了登录，没校验角色权限
- 问题：管理类、运营类接口只确认"是登录用户"，普通用户知道路径就能调用，造成越权操作（OWASP Top 10:2025 的 A01，功能级越权）。
- 怎么认出：新增路由或控制器方法，鉴权中间件只有"已登录"检查；管理接口靠前端隐藏菜单保护；路由表里没有角色或权限声明。
- 修法：在服务端统一的鉴权层按角色或权限声明每个接口，默认拒绝，未声明的接口一律返回 403；前端隐藏只是体验，不算防护。
- 出处：https://top10.owasp.org/2025/A01_2025-Broken_Access_Control/

### 2. 按 ID 取对象，没校验这个对象属于当前用户（IDOR / BOLA）
- 问题：IDOR（不安全的直接对象引用）也叫 BOLA（对象级授权失效）：用户把 URL 或请求体里的 ID 改成别人的，就能读写别人的数据。
- 怎么认出：`GET /orders/{id}`、`PUT /users/{id}/profile` 这类接口，查询条件只有 `WHERE id = ?`，没有 `AND owner_id = 当前用户`；用 ID 查出对象后直接返回，没有归属判断。
- 修法：每次按 ID 访问对象，都在服务端用会话里的用户身份校验归属（查询条件带 owner 或租户字段，或查出来后比对）；归属取自 token，禁止取自请求参数；换成不可猜的 ID 只能加一层难度，不能代替校验。
- 出处：https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/

### 3. 请求体整体映射到数据模型（批量赋值）
- 问题：接口把请求体整体绑定到数据库模型再保存，调用方多传 `role`、`is_admin`、`owner_id` 之类字段就能改掉不该改的属性。
- 怎么认出：OpenAPI 或接口定义里请求体和数据库表是同一个结构；更新接口直接 `update(body)`；代码评审里看到"请求体 = 实体"。
- 修法：为每个写接口单独定义请求结构，只列允许修改的字段（白名单）；敏感字段（角色、归属、状态、价格）只能由服务端逻辑设置；对多余字段选择报 400 或忽略，并在团队内统一。
- 出处：https://api-security.owasp.org/editions/2023/en/0xa3-broken-object-property-level-authorization/

### 4. 响应直接返回完整数据对象
- 问题：接口把数据库对象整个序列化返回，前端只用其中两个字段，但密码哈希、内部备注、手机号全部暴露给调用方。
- 怎么认出：响应结构和表结构一致；列表接口返回的字段比页面展示的多得多；序列化时没有字段白名单。
- 修法：为每个接口写专门的响应结构，只放页面或调用方确实需要的字段；敏感字段按调用方角色决定是否返回，默认不返回。
- 出处：https://api-security.owasp.org/editions/2023/en/0xa3-broken-object-property-level-authorization/

### 5. 旧版本接口和测试接口没有下线
- 问题：新版接口加了鉴权和限制，旧版 `/v1` 或临时调试接口还在线上，攻击者绕到旧入口。
- 怎么认出：路由里同时存在 `/v1`、`/v2` 而 `/v1` 缺少新的鉴权中间件；网关配置里有 `/internal`、`/debug`、`/test` 路径对外转发。
- 修法：维护接口清单，下线旧版本要有日期；不能下线的旧版本套用和新版同一套鉴权与限制；网关只转发清单里的路径。
- 出处：https://api-security.owasp.org/editions/2023/en/0xa9-improper-inventory-management/

## 服务端请求伪造（SSRF，A01）
### 6. 服务端访问用户给的地址，没有目标白名单
- 问题：功能上需要服务端按用户提供的地址取数据（Webhook、图片抓取、URL 预览），攻击者把地址填成内网服务，服务端就替他访问了内网。
- 怎么认出：配置或请求里有 `callback_url`、`image_url`、`webhook` 这类用户可填地址，转发它的代码前面没有"域名或地址白名单"；网关没有出站限制。
- 修法：能列出目标时，用白名单限定域名或地址范围，只允许 https 和固定端口；列不出时，只允许公网地址，并在出站网络层（安全组、出站代理）禁止访问内网网段。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

### 7. 只校验域名，没校验解析后的 IP（DNS 重绑定）
- 问题：DNS 重绑定：攻击者的域名第一次解析成公网 IP 通过检查，真正连接时再解析成内网 IP，域名白名单形同虚设。
- 怎么认出：校验代码拿域名做判断，然后把同一个域名交给 HTTP 客户端再发请求，中间没有固定 IP。
- 修法：先自己解析域名，对所有解析结果校验不在内网和回环网段；然后用校验过的 IP 去连接（Host 头仍写原域名）；或在出站代理上统一做 IP 检查。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

### 8. 出站请求允许自动跟随重定向
- 问题：地址本身在白名单里，但对方返回 302 把请求引到内网地址，客户端自动跟随，白名单被绕过。
- 怎么认出：出站 HTTP 客户端配置里没有关闭重定向（`follow_redirects`、`maxRedirects` 保持默认），而前面有地址校验。
- 修法：关闭自动重定向；确实要跟随时，手动读取 `Location`，对每一跳重新做完整的地址校验，并给跳转次数设一个小的上限。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

### 9. 云主机元数据地址没有拦截
- 问题：云主机的元数据服务（IMDS，实例里一个固定地址的内部接口）在 169.254.169.254，IPv6 下是 fd00:ec2::254，能返回实例角色的临时密钥；服务端一旦被诱导访问它，云账号权限就被偷走。
- 怎么认出：SSRF 校验用的禁止列表里没有 169.254.0.0/16 和 fd00:ec2::254；本次改动涉及 IaC 或部署配置时，EC2 实例没有要求 IMDSv2（`HttpTokens` 不是 `required`）。
- 修法：应用层把 169.254.0.0/16 和 fd00:ec2::254 加入禁止列表；基础设施层要求 IMDSv2（它先用一次 PUT 请求换取会话令牌，单纯的 GET 型 SSRF 拿不到数据），并保持跳数限制为 1（IP 包最多经过几跳路由；设为 1 时，从容器经宿主机转发的请求到不了元数据服务）；实例角色只给最小权限。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-IMDS-existing-instances.html https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html

## 浏览器侧攻击面
### 10. 输出到页面时没有按上下文做输出编码（XSS）
- 问题：用户输入原样放进 HTML，攻击者的脚本在其他用户浏览器里执行，可以偷会话、替用户操作。
- 怎么认出：服务端生成页面时，用户输入被拼进 `<script>`、事件属性、URL 或 CSS 里，而代码里只做了一种统一的转义；同一个字段在不同位置输出，用的却是同一种编码。
- 修法：用模板引擎默认的转义输出；按输出位置选编码方式，HTML 正文用 HTML 编码，属性用属性编码，JS 数据用 JSON 序列化，URL 参数用 URL 编码；必须渲染富文本时，先用白名单净化库处理。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html

### 11. 没有 Content-Security-Policy 作为 XSS 的第二道防线
- 问题：只要有一处输出编码漏掉，没有 CSP 时注入的脚本就能直接执行。
- 怎么认出：网关或应用的响应头配置里没有 `Content-Security-Policy`；已有的策略里出现 `script-src 'unsafe-inline'` 或 `*`。
- 修法：设置带 nonce（每次响应随机生成、只让带这个随机值的脚本执行）或哈希的 `script-src`，去掉 `unsafe-inline`；先用 `Content-Security-Policy-Report-Only` 观察，没有误伤再强制执行。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html

### 12. CORS 把来源原样回显，或带凭证时用通配
- 问题：服务端把请求的 `Origin` 原样写进 `Access-Control-Allow-Origin` 并允许带凭证，任何恶意网站都能用受害者的登录状态读取响应。
- 怎么认出：CORS 配置里 `allowOrigin` 取自请求头；同时有 `Access-Control-Allow-Credentials: true`；用正则或 `endsWith` 校验来源（`evil-example.com` 也能通过）。
- 修法：来源写死成完整的白名单（协议、域名、端口完全相等才放行）；不带凭证的公开接口可以用 `*`，带凭证时浏览器本来就拒绝通配；响应加 `Vary: Origin`。
- 出处：https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS

### 13. 登录后跳转地址直接取自请求参数（开放重定向）
- 问题：`/login?next=https://evil.example` 登录成功后把用户送到钓鱼站，链接看上去是你的域名，容易被信任。
- 怎么认出：`redirect`、`next`、`return_url` 参数直接传给跳转函数或 `Location` 头，前面没有校验。
- 修法：只接受站内相对路径，并拒绝以 `//` 或 `\` 开头的值；需要跳外站时，用服务端维护的白名单或编号映射，不直接用地址。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html

### 14. 缺少 HSTS，浏览器仍会先用 HTTP 访问
- 问题：用户输入裸域名时浏览器先走 HTTP，网络中间人能在这一步劫持或剥离 HTTPS。
- 怎么认出：HTTPS 站点的响应头里没有 `Strict-Transport-Security`；或 `max-age` 很短（比如 300 秒）。
- 修法：全站 HTTPS 稳定后设置 `Strict-Transport-Security: max-age=63072000; includeSubDomains`；子域名里还有纯 HTTP 服务时，先不要加 `includeSubDomains`。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Strict_Transport_Security_Cheat_Sheet.html

## 文件、输入与业务逻辑
### 15. 上传文件只信客户端给的类型和文件名
- 问题：攻击者上传带脚本的网页或可执行文件，用双扩展名或伪造 `Content-Type` 骗过检查，文件被当成代码执行或被别人下载后触发。
- 怎么认出：只检查 `Content-Type` 或扩展名；用原始文件名保存；上传目录在站点根目录下并可直接访问；没有大小限制。
- 修法：扩展名用白名单；服务端按文件内容判断真实类型；文件改成随机名保存；存放在站点目录之外或对象存储；限制单文件大小；下载时指定 `Content-Disposition: attachment` 和 `X-Content-Type-Options: nosniff`。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html

### 16. 价格、折扣、金额由客户端传入并被服务端采信（不安全设计）
- 问题：下单接口接收前端传来的单价或总价，攻击者改成 0.01 元也能下单成功，这是业务逻辑上的设计缺陷（A06）。
- 怎么认出：下单、支付、优惠接口的请求体里有 `price`、`amount`、`discount` 字段，并被直接用于计算或扣款。
- 修法：金额由服务端按商品 ID 和数量重新计算；请求里只收商品、数量、优惠券编号；对"数量为负、优惠叠加、重复领取"这类流程写成明确的业务规则并写测试。
- 出处：https://top10.owasp.org/2025/A06_2025-Insecure_Design/

### 17. 限速的依据是可伪造的请求头
- 问题：登录、验证码、找回密码这类接口按 `X-Forwarded-For` 里的 IP 限速，攻击者每次换一个头就绕过。
- 怎么认出：限速键取自 `X-Forwarded-For`、`X-Real-IP` 且网关没有覆盖这些头。
- 修法：只信任自家反向代理追加的那一段地址（按可信代理的跳数从右往左取），代理前面的部分一律当作不可信；服务能被直接访问时，不要读这些头。
- 出处：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For

### 18. 把第三方接口的返回值当成可信数据
- 问题：第三方或合作方接口返回的内容未经校验就写库、拼进页面或当成地址去访问，对方被入侵或出错时，问题会传到你的系统里。
- 怎么认出：调用第三方后直接把响应字段存库、渲染或当 URL 使用，没有结构和长度校验；自动跟随第三方返回的链接。
- 修法：对第三方响应按预期结构做校验，不符合就拒绝；字段长度、取值范围设上限；第三方给的链接要访问时，同样先做目标白名单、解析后 IP 校验并关闭自动重定向。
- 出处：https://api-security.owasp.org/editions/2023/en/0xaa-unsafe-consumption-of-apis/

## 错误处理与日志
### 19. 报错把内部细节返回给调用方
- 问题：堆栈、SQL 语句、文件路径、框架版本出现在响应里，攻击者拿它摸清内部结构，下一步攻击更准。
- 怎么认出：全局异常处理里把 `exception.message` 或 stack 写进响应体；生产环境开着调试或详细错误页；数据库报错原样透传。
- 修法：对外只返回统一的错误码和一句话说明，加一个请求编号；详细信息只写服务端日志；设置全局异常处理兜住没预料到的错误。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html

### 20. 鉴权或校验组件出错时放行请求（fail open）
- 问题：权限服务超时、令牌解析抛异常时，代码 catch 之后继续往下走，等于出错时不检查权限（A10，失败时放行）。
- 怎么认出：鉴权相关的 `try/catch` 里 catch 分支为空、只打日志，或返回"允许"；远程权限服务不可用时有"降级为放行"的开关。
- 修法：鉴权路径上任何异常都按拒绝处理（返回 401 或 503），并记录日志告警；事务做到一半出错就整体回滚。
- 出处：https://top10.owasp.org/2025/A10_2025-Mishandling_of_Exceptional_Conditions/

### 21. 登录失败、越权被拒这类安全事件没有记录
- 问题：攻击者撞库、遍历 ID 的过程没有任何日志，事后查不到，也没法告警（A09）。
- 怎么认出：鉴权失败、权限拒绝、输入校验失败的分支里直接返回错误，没有日志语句；日志里没有用户标识和来源地址。
- 修法：这几类事件都写结构化日志（时间、用户、来源地址、接口、结果），并对"同一来源短时间大量失败"设告警；日志内容不含密码和 token。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html

### 22. 对象存储桶或文件目录对公网开放
- 问题：存储桶设成公开读，里面的用户上传文件、备份、导出报表可以被任何人下载（A02，配置错误）。
- 怎么认出：基础设施代码里 `acl = "public-read"`、桶策略的 `Principal` 是 `*`；没有开启"阻止公开访问"。
- 修法：开启账号和桶两级的"阻止公开访问"；需要公开的静态资源放单独的桶，私有文件用有时效的预签名链接下载。
- 出处：https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html

## 资源与请求头
### 23. 列表和批量接口没有条数上限
- 问题：调用方可以传 `limit=1000000` 或一次提交几万条，单个请求就能耗光数据库和内存，也方便批量拖库。
- 怎么认出：分页参数 `limit`、`page_size` 直接传给查询，没有最大值；批量接口的数组参数没有长度限制；响应体积没有上限。
- 修法：服务端给 `limit` 设最大值（例如 100），超过就截断或返回 400；批量接口限制数组长度；列表接口必须分页。
- 出处：https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/

### 24. 用 Host 请求头直接生成对外链接
- 问题：重置密码邮件、邀请链接里的域名取自请求的 `Host` 头，攻击者伪造它，受害者收到的链接就指向攻击者的站点，点击后令牌被拿走。
- 怎么认出：生成绝对链接时用 `request.host`、`req.headers.host`、`X-Forwarded-Host`；站点自己的域名没有放在配置里。
- 修法：对外域名写进配置，生成链接只用配置值；反向代理层校验 `Host`，只放行已知域名。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
