---
name: skills-shared-services
description: 写 Web/API 安全、认证与会话、依赖供应链和四份服务类清单共 7 份 skill
---
# 通用与服务类 skill（7 份）

## 目标
包里的 `skills/` 新增 web-api-security、auth-session、supply-chain、relational-db、redis、message-queue、service-runtime 7 份 skill，格式和主题覆盖通过检查。

## 业务规则（来源：PRD skills-and-acceptance）
- 格式同另两份 skill 计划：`skills/<名字>/SKILL.md`，name 与目录名一致，description 一句话，连设置段 ≤ 200 行；每个检查项四行：问题、怎么认出、修法、出处（https；优先 OWASP、各服务官方文档、云厂商官方文档；只有二手资料时注明「二手资料」）；每个链接写入时实际打开过，2xx 或 3xx。
- 必须覆盖的主题：
  - web-api-security：按 OWASP Top 10:2025 对照；越权（IDOR / BOLA）——每次按 ID 访问对象都在服务端校验归属；SSRF——目标地址白名单、解析后校验 IP 防 DNS 重绑定、关闭自动重定向、拦截云元数据地址；XSS——输出按上下文编码；批量赋值——只接收白名单字段；报错不把内部细节返回给调用方。
  - auth-session：JWT 验签显式传入算法白名单、拒绝 `alg: none`、使用强密钥；Cookie 设置 HttpOnly、Secure、SameSite；表单和改状态的请求带 CSRF token；token 存 localStorage 会被 XSS 读走；密码用 argon2id 或 bcrypt 哈希；登出和改密后让旧 token 失效。
  - supply-chain：CI 用 `npm ci --ignore-scripts`（或 `.npmrc` 里 `ignore-scripts=true`），需要构建脚本的原生包单独 rebuild；lockfile 提交并冻结安装；版本写死（save-exact）；新版本发布后等冷却期再升级；新增依赖要经用户同意；以 2025 年 Shai-Hulud 投毒事件说明 postinstall 风险。
  - relational-db：SQL 拼接用户输入造成注入，用预编译加参数占位符，动态表名列名走白名单；深分页 `OFFSET` 慢，改 keyset 分页；死锁——事务短小、按固定顺序访问行、捕获死锁错误后重试；N+1 查询；事务边界和连接池（连接没归还、池太小）。
  - redis：缓存穿透（参数校验、缓存空值、布隆过滤器）；缓存击穿（singleflight、互斥锁、逻辑过期）；缓存雪崩（TTL 加随机抖动、多级缓存、限流）；分布式锁误删（`SET key token NX PX` 加锁、Lua 比对 token 后删除）；Redlock 的争议与 fencing token；大 key 和热 key（`--bigkeys`、`--hotkeys`、`UNLINK`）。
  - message-queue：至少一次投递下的重复消费——已处理的消息 ID 和业务改动放同一事务、唯一键去重、不拿 offset 当 ID；写库和发消息的双写不一致用 Outbox；offset 或 ack 提交时机不对造成丢消息；需要顺序的消息按 key 分区；处理不了的进死信队列。
  - service-runtime：跨进程调用必须设超时；重试只在一层做、指数退避加随机抖动、限制重试次数（重试预算）、只重试幂等请求；非幂等写用幂等键；限流；收到 SIGTERM 后优雅停机；日志不打印密码、token；密钥不写进代码和日志。

## 涉及文件
- 新建 `skills/web-api-security/SKILL.md`、`skills/auth-session/SKILL.md`、`skills/supply-chain/SKILL.md`、`skills/relational-db/SKILL.md`、`skills/redis/SKILL.md`、`skills/message-queue/SKILL.md`、`skills/service-runtime/SKILL.md`
- 新建 `tests/skills-shared.test.ts`

## 成品定义
SKILL.md 骨架与 `skills-backend-languages` 计划相同：

```markdown
---
name: <目录名>
description: <一句话：这份清单覆盖什么>
---
# <标题>

## <分组名>
### 1. <问题名>
- 问题：<是什么问题、会造成什么后果>
- 怎么认出：<diff 里看得见的代码特征>
- 修法：<具体怎么改，必要时一两行示例>
- 出处：<https://…>（二手资料时在链接后注明「二手资料」）
```

主题关键词表（`tests/skills-shared.test.ts` 原样使用，区分大小写）：

```ts
const TOPICS: Record<string, string[]> = {
  "web-api-security": ["OWASP Top 10:2025", "IDOR", "SSRF", "169.254.169.254", "DNS 重绑定", "输出编码", "批量赋值", "内部细节"],
  "auth-session": ["alg: none", "HttpOnly", "SameSite", "CSRF", "localStorage", "argon2id", "旧 token"],
  "supply-chain": ["--ignore-scripts", "lockfile", "save-exact", "冷却期", "经用户同意", "Shai-Hulud"],
  "relational-db": ["占位符", "白名单", "keyset", "死锁", "N+1", "连接池"],
  "redis": ["穿透", "布隆过滤器", "击穿", "singleflight", "逻辑过期", "雪崩", "抖动", "NX", "Lua", "Redlock", "fencing", "UNLINK"],
  "message-queue": ["幂等", "offset", "Outbox", "死信", "按 key 分区"],
  "service-runtime": ["超时", "退避", "抖动", "重试预算", "幂等键", "限流", "SIGTERM", "脱敏", "密钥"],
};
```

## 函数清单
### tests/skills-shared.test.ts
| 函数名 | 职责 |
|---|---|
| （无新函数） | 用 `tests/helpers/skill-lint.ts` 的 `skillLintErrors` 逐份检查 TOPICS 里的 7 份 skill |

## 协作关系
依赖 `skills-backend-languages` 计划建立的 `tests/helpers/skill-lint.ts`。不改产品代码。

## 验证方式
- 测试入口：`pnpm test -- tests/skills-shared.test.ts`
- 测试输入：`skills/` 下 7 个目录
- 预期结果：每份的格式错误列表为空
- [ ] 7 份 SKILL.md 存在、name 一致、≤ 200 行，检查项四行齐全、出处为 https
- [ ] TOPICS 里每个关键词都能找到
- [ ] 链接检查：一次性脚本（`.bb-spec/.cache/skill-links/`）列出 7 份 skill 全部出处链接的 HTTP 状态，无 4xx、5xx、连不上；结果和「二手资料」清单贴进提交说明
