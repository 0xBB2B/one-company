---
name: skills-backend-languages
description: 写 Go、TypeScript、Node、Python、Java 的 8 份 skill，并建立 19 份 skill 共用的格式检查辅助函数
---
# 后端语言 skill（8 份）与 skill 格式检查

## 目标
包里的 `skills/` 新增 go-coding、go-pitfalls、typescript-coding、node-pitfalls、python-coding、python-pitfalls、java-coding、java-pitfalls 8 份 skill；测试侧有一个能被另外两份 skill 计划复用的格式检查辅助函数。

## 业务规则（来源：PRD skills-and-acceptance）
- 每份 skill 是 `skills/<名字>/SKILL.md`，设置段 `name` 与目录名一致，`description` 一句话写清覆盖什么。连设置段在内不超过 200 行；中文大白话，代码标识符保持英文。
- 正文由检查项组成，每项固定四行：问题（是什么问题、什么后果；编码规范写违反了哪条、带来什么麻烦）、怎么认出（diff 里看得见的代码特征）、修法（具体怎么改，必要时一两行示例）、出处（至少一个 https 链接；优先语言官方文档、规范、OWASP 等标准组织；只找得到博客、课程、播客摘要时在链接后注明「二手资料」）。
- 写入时每个出处链接都要实际打开一次，返回 2xx 或 3xx；打不开换出处，换不到删掉这一项。
- 每份至少覆盖下面列出的主题，每个主题至少一项；200 行放得下时补充同类常见问题：
  - go-coding：error 不忽略、用 %w 包装并用 errors.Is / errors.As 判断；context 作为第一个参数、不存进结构体；接口在使用方定义、保持小；命名和包名按 Go Code Review Comments；用 defer 释放资源；普通错误不用 panic。
  - go-pitfalls：写 nil map 会 panic；map 并发读写会让进程崩溃；数据竞争（`go test -race`）；goroutine 泄漏（发送方没有退出途径）；`http.DefaultClient` 没有超时、`resp.Body` 没关闭；go.mod 低于 1.22 时循环变量被闭包共享；`WaitGroup.Add` 放在子 goroutine 里。
  - typescript-coding：开 strict；不用 any，外部数据用 unknown 再收窄；不用 `as` 断言外部输入；联合类型用 never 穷尽检查；能 readonly / const 就不可变。
  - node-pitfalls：类型只在编译期有效，接口入口做运行时校验；校验库默认放过多余字段导致批量赋值；`__proto__` 原型污染；未处理的 Promise rejection 在 Node 15 起让进程退出；同步重活阻塞事件循环；`child_process.exec` 拼字符串造成命令注入。
  - python-coding：PEP 8 命名和格式；函数签名写类型标注（PEP 484）；不写裸 `except:`、不吞异常；资源用 with 管理；日志参数化，不提前拼字符串。
  - python-pitfalls：pickle、`yaml.load` 反序列化不可信数据；可变默认参数；asyncio 协程里调用阻塞函数；`subprocess` 用 `shell=True` 拼接；对外部输入用 eval / exec。
  - java-coding：命名和格式按 Google Java Style 或阿里巴巴 Java 开发手册；不吞异常、不 catch Throwable；equals 和 hashCode 一起重写；资源用 try-with-resources；Optional 只做返回值。
  - java-pitfalls：反序列化不可信数据（ObjectInputStream、Jackson 多态类型）；`@Transactional` 失效（同类自调用、非 public、受检异常默认不回滚）；用 `Executors` 创建无界队列的线程池；连接和流没关闭；Spring Boot Actuator 端点对外暴露；`SimpleDateFormat` 多线程共用。

## 涉及文件
- 新建 `skills/go-coding/SKILL.md`、`skills/go-pitfalls/SKILL.md`、`skills/typescript-coding/SKILL.md`、`skills/node-pitfalls/SKILL.md`、`skills/python-coding/SKILL.md`、`skills/python-pitfalls/SKILL.md`、`skills/java-coding/SKILL.md`、`skills/java-pitfalls/SKILL.md`
- 新建 `tests/helpers/skill-lint.ts`（测试辅助）
- 新建 `tests/skills-backend.test.ts`

## 成品定义
每份 SKILL.md 的骨架（正文内容在 exec 时调研填写，结构原样使用）：

```markdown
---
name: <目录名>
description: <一句话：这份清单覆盖什么>
---
# <标题，如「Go 常见坑排查清单」>

## <分组名，如「并发」>
### 1. <问题名>
- 问题：<是什么问题、会造成什么后果>
- 怎么认出：<diff 里看得见的代码特征>
- 修法：<具体怎么改，必要时一两行示例>
- 出处：<https://…>（二手资料时在链接后注明「二手资料」）
```

主题关键词表（`tests/skills-backend.test.ts` 原样使用；每个关键词必须在对应 SKILL.md 正文里出现，区分大小写）：

```ts
const TOPICS: Record<string, string[]> = {
  "go-coding": ["%w", "errors.Is", "context.Context", "接口", "defer", "panic"],
  "go-pitfalls": ["nil map", "concurrent map", "-race", "goroutine", "DefaultClient", "Body.Close", "1.22", "WaitGroup"],
  "typescript-coding": ["strict", "unknown", "as", "never", "readonly"],
  "node-pitfalls": ["运行时校验", "多余字段", "__proto__", "unhandledRejection", "事件循环", "child_process"],
  "python-coding": ["PEP 8", "PEP 484", "except:", "with", "logging"],
  "python-pitfalls": ["pickle", "yaml.load", "可变默认参数", "asyncio", "shell=True", "eval"],
  "java-coding": ["Google Java Style", "Throwable", "hashCode", "try-with-resources", "Optional"],
  "java-pitfalls": ["ObjectInputStream", "@Transactional", "Executors", "close", "Actuator", "SimpleDateFormat"],
};
```

## 函数清单
### tests/helpers/skill-lint.ts
| 函数名 | 职责 |
|---|---|
| `readSkill` | 读包内 `skills/<名字>/SKILL.md`，切出设置段（name、description）、正文和总行数 |
| `skillItems` | 把正文按 `### ` 标题切成检查项，取出问题、怎么认出、修法、出处四行 |
| `skillLintErrors` | 汇总一份 skill 的格式错误：name 与目录名不一致、description 为空、超过 200 行、检查项缺四行之一、出处没有 `https://` 链接、缺少给定的主题关键词 |

## 协作关系
`skills-backend.test.ts` 用 `TOPICS` 逐份调用 `skillLintErrors`，断言返回空列表；`skills-frontend`、`skills-shared-services` 两份计划复用同一辅助函数。skill 由 `src/modules/agents/agent-resolve.ts` 按 `skills/<名字>/SKILL.md` 原样读取，本计划不改代码。

## 验证方式
- 测试入口：`pnpm test -- tests/skills-backend.test.ts`
- 测试输入：仓库 `skills/` 下 8 个目录
- 预期结果：每份 skill 的格式错误列表为空；任一份缺文件、超行数、缺字段、缺关键词时测试失败并指出是哪份、哪一项
- [ ] 8 份 SKILL.md 存在、name 与目录名一致、≤ 200 行
- [ ] 每个检查项四行齐全，出处以 `https://` 开头
- [ ] TOPICS 里每个关键词都能在对应 skill 里找到
- [ ] 链接检查：用一次性脚本（放 `.bb-spec/.cache/skill-links/`，不进仓库）对 8 份 skill 的全部出处链接发请求，列出每个链接和 HTTP 状态，没有 4xx、5xx、连不上；结果贴进本计划的提交说明；标了「二手资料」的项单独列出
