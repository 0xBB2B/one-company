---
name: auth-session
description: 认证与会话排查清单：JWT 验证与有效期、Cookie 属性、CSRF、token 存放位置、密码哈希参数、登录防护、登出与改密后的 token 失效、OAuth 授权流程。
---
# 认证与会话排查清单

## JWT 验证
### 1. 验签时没有显式给出算法白名单
- 问题：JWT 的头部自己声明用什么算法。服务端如果按头部选算法，攻击者可以把 RS256 改成 HS256，用公开的公钥当对称密钥签出合法 token（算法混淆）。
- 怎么认出：验证函数调用里没有 `algorithms`、`allowedAlgorithms` 这类参数；验证库配置只传了密钥；同一个服务既支持对称又支持非对称算法。
- 修法：验证时显式传算法白名单，一个密钥只对应一种算法；升级老版本的 JWT 库，让它在算法和密钥类型不匹配时报错。
- 出处：https://www.rfc-editor.org/rfc/rfc8725.html#section-3.1

### 2. 接受 alg: none 的未签名 token
- 问题：`alg: none` 表示没有签名。验证端若接受它，攻击者可以随意编造 token 内容，任何身份都能冒充。
- 怎么认出：自己写的验证逻辑里按头部 `alg` 分支处理；用 `decode` 解码后直接使用 payload，没有走 `verify`；测试里存在 `alg: none` 的样例却被放行。
- 修法：算法白名单里不放 none；业务代码只使用经过 `verify` 的结果，不使用 `decode` 的结果；给验证逻辑加一条"alg: none 必须被拒绝"的测试。
- 出处：https://www.rfc-editor.org/rfc/rfc8725.html#section-3.2

### 3. HS256 签名密钥太短或是弱口令
- 问题：HS256 的密钥如果是 `secret`、`changeme` 这类弱口令，攻击者拿到一个 token 就能离线暴力破解出密钥，然后随意签发 token。
- 怎么认出：密钥是人能记住的短字符串；密钥长度小于 32 字节；测试或示例配置里的弱密钥原样带到了生产配置。
- 修法：用密码学安全的随机数生成至少 32 字节（256 位）的密钥；优先用非对称算法，私钥只放在签发方。
- 出处：https://www.rfc-editor.org/rfc/rfc8725.html#section-3.5 https://www.rfc-editor.org/rfc/rfc7518.html#section-3.2

### 4. 只验签，没校验 exp、iss、aud
- 问题：只验签名而不看过期时间、签发方和受众，过期的 token 永远能用，别的服务签发的 token 也能拿来访问本服务。
- 怎么认出：验证参数里没有 `issuer`、`audience`；自己解析 payload 时没有比较 `exp`；多个服务共用同一个密钥。
- 修法：验证时必须带上预期的 `iss` 和 `aud`，并启用 `exp` 校验；时钟容差只留几分钟以内（RFC 7519 的原话是"通常不超过几分钟"），不要放得更大；不同服务使用不同的 `aud`。
- 出处：https://www.rfc-editor.org/rfc/rfc8725.html#section-3.8 https://www.rfc-editor.org/rfc/rfc8725.html#section-3.9 https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1.4

### 5. 头部的 kid、jku、x5u 被直接信任
- 问题：`kid` 被拼进文件路径或 SQL 里会造成注入；`jku`、`x5u` 让服务端去下载公钥，攻击者把地址指向自己的服务器，就能用自己的密钥签出"合法"token。
- 怎么认出：验证代码用头部的 `kid` 拼接路径或查询语句；按头部的 `jku` 发起 HTTP 请求取公钥；没有 JWKS 地址的固定配置。
- 修法：公钥只从服务端配置里固定的 JWKS 地址或本地密钥库读取；`kid` 只作为已加载密钥表的查找键，查不到就拒绝；忽略 `jku`、`x5u`。
- 出处：https://www.rfc-editor.org/rfc/rfc8725.html#section-3.10

### 6. 访问 token 有效期很长，或根本不设 exp
- 问题：token 一旦泄露，攻击者可以长期使用。JWT 是自包含的，服务端默认无法提前作废。
- 怎么认出：签发代码里没有 `exp`；`expiresIn` 是几天、几周甚至"永不过期"；没有刷新 token 机制。
- 修法：访问 token 有效期设为几分钟到十几分钟，配合刷新 token 获取新的访问 token；刷新 token 每次使用都换一个新的，旧的立即作废；发现旧的被再次使用时，吊销整条登录链。
- 出处：https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14 https://www.rfc-editor.org/rfc/rfc7519.html#section-4.1.4

## Cookie 与会话
### 7. 会话 Cookie 没设 HttpOnly
- 问题：没有 `HttpOnly` 时，页面里的脚本可以直接读 Cookie。一旦有 XSS，会话立即被偷走。
- 怎么认出：`Set-Cookie` 或框架的会话配置里没有 `HttpOnly`，或显式设为 false。
- 修法：所有承载会话或 token 的 Cookie 都设 `HttpOnly`；前端确实要读的值单独放在另一个不含身份信息的 Cookie 里。
- 出处：https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies#block_access_to_your_cookies

### 8. 会话 Cookie 没设 Secure
- 问题：没有 `Secure` 时，Cookie 在 HTTP 请求里也会发出去，同一网络里的人能直接截获。
- 怎么认出：会话配置里没有 `Secure`，或用环境变量在生产里关掉它；Cookie 名没有 `__Host-` 前缀。
- 修法：生产环境所有会话 Cookie 都设 `Secure`；Cookie 名加 `__Host-` 前缀（要求 `Secure`、`Path=/`、不带 `Domain`）；全站同时启用 HSTS。
- 出处：https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies#block_access_to_your_cookies https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies#cookie_prefixes

### 9. 会话 Cookie 没写 SameSite，或写成了 None
- 问题：浏览器对没写 `SameSite` 的 Cookie 处理不一致：按 MDN 兼容表，Chrome 80、Edge 86、Opera 71 起默认当 `Lax`，Firefox 要手动打开 `network.cookie.sameSite.laxByDefault`，Safari 不支持。没写等于跨站请求是否带 Cookie 取决于用户的浏览器；写成 `None` 则任何站点发出的请求都会带上它。
- 怎么认出：会话 Cookie 的 `Set-Cookie` 或框架会话配置里没有 `SameSite`，或出现 `SameSite=None`、`sameSite: 'none'`；常见于为了前后端跨域联调、iframe 嵌入而把 `Lax` 改掉。
- 修法：会话 Cookie 显式写 `SameSite=Lax`，转账、改密码这类敏感操作的 Cookie 用 `Strict`；确实要跨站嵌入时才用 `None`，并且必须同时带 `Secure`，改状态的请求另外要有 CSRF token；本地联调用同域代理，不要改 Cookie 策略。
- 出处：https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies#controlling_third-party_cookies_with_samesite https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie

### 10. 登录成功后沿用登录前的会话 ID（会话固定）
- 问题：攻击者先拿到一个未登录的会话 ID，诱导受害者用它登录，登录后这个 ID 就变成了已登录状态，攻击者直接接管。
- 怎么认出：登录处理函数里没有"重新生成会话"的调用；登录前后会话 ID 不变；允许从 URL 参数里接收会话 ID。
- 修法：登录成功、提权、改密码之后都重新生成会话 ID 并作废旧的；会话 ID 只从 Cookie 读取，不接受 URL 参数。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#renew-the-session-id-after-any-privilege-level-change

### 11. 会话没有空闲超时和绝对超时
- 问题：会话一旦建立就一直有效，被盗的会话或公共电脑上忘记退出的会话可以被无限期使用。
- 怎么认出：会话存储的 TTL 是几个月或没设；每次请求都把有效期延长，没有总时长上限。
- 修法：设空闲超时（高价值系统 2 到 5 分钟，低风险系统 15 到 30 分钟）和绝对超时（办公场景可取 4 到 8 小时），服务端存储里到期就删除；超时由服务端判断，不依赖前端计时。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#session-expiration

### 12. token 或会话 ID 放在 URL 里
- 问题：URL 会进浏览器历史、服务器访问日志、代理日志和 `Referer` 头，放在里面的 token 会被这些地方带走。
- 怎么认出：前端拼接 `?token=`、`?access_token=`；日志格式里记录了完整查询串；下载链接直接带登录凭证。
- 修法：token 放在 `Authorization` 请求头或 Cookie 里；必须用链接传递时，用一次性、短时效（几分钟）的专用令牌，并限定用途。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html

## 跨站请求伪造（CSRF）与 token 存放
### 13. 靠 Cookie 鉴权的改状态请求没有 CSRF token
- 问题：浏览器会自动带上 Cookie。恶意网站能让受害者的浏览器向你的接口发出表单请求，以受害者的身份改密码、转账。
- 怎么认出：使用 Cookie 会话的 POST、PUT、DELETE 接口和表单里没有 CSRF token 字段或请求头校验；框架的 CSRF 中间件被关闭或对某些路径豁免。
- 修法：开启框架自带的 CSRF 防护，表单和改状态的请求都带 token，服务端校验；纯 JSON 接口用同步令牌或双重提交 Cookie；同时校验 `Origin` 头。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html

### 14. 用 GET 请求执行改状态的操作
- 问题：GET 请求会被预取、被图片标签或链接触发，既绕开了 CSRF token 的保护，也违背 HTTP 对安全方法的约定。
- 怎么认出：路由里 `GET /delete`、`GET /logout`、`GET /approve?id=` 这类会修改数据的 GET 接口。
- 修法：所有修改状态的操作改用 POST、PUT、PATCH、DELETE，并带 CSRF 校验。
- 出处：https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.1

### 15. 登录 token 存在 localStorage 或 sessionStorage 里
- 问题：页面里的任何脚本都能读 localStorage。只要有一处 XSS，攻击者就能带走 token，换到别处继续使用。
- 怎么认出：前端代码里 `localStorage.setItem('token'`、`sessionStorage.setItem('access_token'`；请求拦截器从这里取值拼 `Authorization` 头。
- 修法：把会话凭证放进带 `HttpOnly`、`Secure`、`SameSite` 的 Cookie 里，由浏览器自动携带；确实要用 Bearer token 的单页应用，访问 token 只放内存，有效期缩到几分钟，并配合严格的 CSP。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#local-storage

## 密码与登录防护
### 16. 密码哈希没用 argon2id 或 bcrypt，或者参数太低
- 问题：通用哈希速度太快，数据库泄露后可以高速暴力破解。argon2id 和 bcrypt 是专为存密码设计的慢哈希，但参数调得太低同样会被很快破解。
- 怎么认出：登录注册代码里的哈希调用不是 `argon2id` 或 `bcrypt`；argon2 的参数低于下面五组中的任何一组；bcrypt 的 cost 小于 10。
- 修法：优先用 argon2id，并行度 1，内存和迭代次数不低于下列任一组（OWASP 称它们防护强度相当）：46 MiB 加 1 次、19 MiB 加 2 次、12 MiB 加 3 次、9 MiB 加 4 次、7 MiB 加 5 次；用 bcrypt 时 cost 不低于 10；参数写进哈希字符串里，登录成功时发现参数过旧就重新哈希。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html

### 17. bcrypt 的密码超过 72 字节被静默截断
- 问题：bcrypt 只处理前 72 字节。长口令后面的部分不参与哈希，两个只有尾部不同的密码会被当成同一个。
- 怎么认出：使用 bcrypt，且没有限制密码最大长度，也没有先做预处理。
- 修法：新项目优先 argon2id；继续用 bcrypt 时，限制密码最大 72 字节并在界面提示；不要自己对密码先做 SHA-256 再交给 bcrypt，OWASP 指出这样做会因为哈希输出里的 NUL 字节削弱安全性。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#bcrypt

### 18. 登录失败的提示或耗时能区分"用户不存在"
- 问题：攻击者可以通过提示语或响应时间差，批量判断哪些账号存在，再针对这些账号撞库。
- 怎么认出：登录、注册、找回密码接口对"账号不存在"和"密码错误"返回不同文案、不同状态码；账号不存在时直接返回，没有走哈希计算。
- 修法：统一返回"用户名或密码错误"；账号不存在时也做一次相同代价的哈希计算；找回密码一律返回"若账号存在，已发送邮件"。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-responses

### 19. 登录接口对同一账号的连续失败没有限制
- 问题：攻击者可以对一个账号尝试大量密码，或用泄露的密码库撞库。
- 怎么认出：登录处理函数没有失败计数；限制只按 IP 做，没有按账号做；没有验证码或延迟递增机制。
- 修法：按账号统计连续失败，到阈值后延迟递增或要求验证码，不要永久锁账号（否则会被人恶意锁死）；配合多因素认证；失败事件写日志。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#protect-against-automated-attacks

### 20. 重置密码的令牌可预测、不过期或可重复使用
- 问题：重置令牌被猜到、被邮件系统转发或重复使用，账号就被接管。
- 怎么认出：令牌用用户 ID、时间戳或自增数生成；数据库里明文保存令牌；没有过期时间；使用后没有删除。
- 修法：用安全随机数生成足够长的令牌（例如 32 字节）；库里只存它的哈希；有效期设短（例如 15 到 60 分钟）；使用一次即作废；重置成功后让该用户其他会话全部失效。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html

## 登出与失效
### 21. 登出只删了前端的 token，服务端仍然认
- 问题：用户点了登出，但被偷走的旧 token 仍然有效，登出没有真正起作用。
- 怎么认出：登出接口只清除 Cookie 或返回 200，没有任何服务端状态变化；没有 token 黑名单、会话表或版本号。
- 修法：会话类凭证在服务端存储里删除；JWT 用"token 版本号"或黑名单（保留到原有效期结束）；刷新 token 在服务端存储并在登出时吊销。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#logout-button

### 22. 改密码或重置密码后，旧 token 和其他设备的会话仍有效
- 问题：用户怀疑账号被盗而改密码，但攻击者手里的旧 token 仍然可用，改密码没有起到止损作用。
- 怎么认出：改密码、重置密码、停用账号的处理函数只更新密码字段，没有吊销该用户其他会话或刷新 token。
- 修法：改密码或重置后，让该用户所有旧 token 和会话失效（递增用户的 token 版本号，或删除全部会话记录），并保留当前这一次会话或要求重新登录；同时通知用户。
- 出处：https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#renew-the-session-id-after-any-privilege-level-change https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html

## OAuth 授权流程
### 23. redirect_uri 不是精确匹配
- 问题：授权服务器按前缀或通配符匹配回调地址，攻击者构造一个仍然匹配的地址，授权码就被送到攻击者手里。
- 怎么认出：客户端注册配置里回调地址带通配符或只登记域名；授权服务器的校验用 `startsWith`、正则。
- 修法：每个客户端登记完整的回调地址，授权请求里的 `redirect_uri` 必须与登记值逐字符相同。
- 出处：https://www.rfc-editor.org/rfc/rfc9700.html#section-4.1

### 24. 授权码流程没有 state 和 PKCE
- 问题：缺少 `state` 时回调请求可被伪造（登录 CSRF）；缺少 PKCE（授权码交换保护：客户端先发一个随机串的哈希，换 token 时再出示原串，截获授权码的人拿不到原串）时，被截获的授权码可以直接换成 token。
- 怎么认出：发起授权的代码里没有生成并校验 `state`；授权请求里没有 `code_challenge`；单页应用或移动应用使用隐式授权（`response_type=token`）。
- 修法：所有客户端都用授权码加 PKCE（`S256`）；`state` 随机生成，存在会话里，回调时比对；改用授权码流程，淘汰隐式授权。
- 出处：https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1 https://www.rfc-editor.org/rfc/rfc9700.html#section-4.7
