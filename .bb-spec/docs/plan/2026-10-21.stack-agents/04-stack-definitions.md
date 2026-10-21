---
name: stack-definitions
description: 内置 12 个专项角色定义（6 个技术栈各一对 worker、reviewer），并给出"通用定义"名单
---
# 内置专项定义

## 目标
包里的 `agents/` 多出 12 份专项定义，内置层加载时全部有效；代码里有一份"通用定义"名单（worker、reviewer、qa、explore、prototype），供开关和审查判断用。

## 业务规则（来源：PRD definitions-and-switches）
- 通用定义：内置的 worker、reviewer、qa、explore、prototype 这 5 个，流程离不开，不能关闭。判断"是否通用"按定义名。
- 专项定义：每栈一个 `<栈>-worker`（职责 worker）和一个 `<栈>-reviewer`（职责 reviewer），同栈两个预设同一组 skills，顺序按下表。
- 描述写明写或审哪种代码，PM 靠描述挑选；正文不为空，写明作用和专攻的技术栈；不写 model、thinking（跟随主会话）。
- 12 份定义在内置层加载时都有效，没有问题项。

## 涉及文件
- 新建 `agents/go-worker.md`、`agents/go-reviewer.md`、`agents/node-worker.md`、`agents/node-reviewer.md`、`agents/python-worker.md`、`agents/python-reviewer.md`、`agents/java-worker.md`、`agents/java-reviewer.md`、`agents/vue-worker.md`、`agents/vue-reviewer.md`、`agents/react-worker.md`、`agents/react-reviewer.md`
- 修改 `src/modules/agents/roles.ts`
- 修改 `tests/role-catalog.test.ts`（:31-43 "内置恰好 5 份" 的断言）、`tests/role-rules.test.ts`（:71 起只覆盖 5 个通用定义，保留；另加专项定义的用例）

## 成品定义
后端四栈的 skills 行：
- go：`skills: [go-coding, go-pitfalls, web-api-security, auth-session, supply-chain, relational-db, redis, message-queue, service-runtime]`
- node：`skills: [typescript-coding, node-pitfalls, web-api-security, auth-session, supply-chain, relational-db, redis, message-queue, service-runtime]`
- python：`skills: [python-coding, python-pitfalls, web-api-security, auth-session, supply-chain, relational-db, redis, message-queue, service-runtime]`
- java：`skills: [java-coding, java-pitfalls, web-api-security, auth-session, supply-chain, relational-db, redis, message-queue, service-runtime]`

前端两栈：
- vue：`skills: [typescript-coding, vue-coding, vue-pitfalls, web-api-security, auth-session, supply-chain]`
- react：`skills: [typescript-coding, react-coding, react-pitfalls, web-api-security, auth-session, supply-chain]`

12 份文件按下面两个模板生成，`<栈名>`、`<代码>`、`<编码规范>`、`<排查清单>`、`<skills 行>` 按下表替换，其余文字原样：

```markdown
---
name: <栈>-worker
description: 写 <代码>，按 <栈名> 编码规范和排查清单写
role: worker
<skills 行>
mcp: []
---
你负责写 <代码>，专攻 <栈名>。动手前先读本任务加载的 skills：按 <编码规范> 的写法写，按 <排查清单> 和其余各份清单避开常见的安全和鲁棒性问题。
```

```markdown
---
name: <栈>-reviewer
description: 审查 <代码> 改动的编码规范、安全和鲁棒性，只按预设的 skills 核对
role: reviewer
<skills 行>
mcp: []
---
你负责审查 <代码> 的改动，专攻 <栈名>。逐项对照本任务加载的 skills（<编码规范>、<排查清单> 和其余各份清单）核对本次改动，找出违反规范和会出事的写法，并写出按 skill 给出的修法。
```

| 栈 | 栈名 | 代码 | 编码规范 | 排查清单 |
|---|---|---|---|---|
| go | Go | Go 后端代码 | go-coding | go-pitfalls |
| node | Node.js / TypeScript | Node.js / TypeScript 后端代码 | typescript-coding | node-pitfalls |
| python | Python | Python 后端代码 | python-coding | python-pitfalls |
| java | Java / Spring | Java / Spring 后端代码 | java-coding | java-pitfalls |
| vue | Vue | Vue 前端代码 | typescript-coding、vue-coding | vue-pitfalls |
| react | React | React 前端代码 | typescript-coding、react-coding | react-pitfalls |

## 函数清单
### src/modules/agents/roles.ts
| 函数名 | 职责 |
|---|---|
| `GENERIC_DEFINITIONS` | 常量：5 个通用定义的名字。和 `DEFINITION_ROLES` 内容相同但语义不同（一个是定义名，一个是职责），单独定义 |
| `isGenericDefinition` | 判断一个定义名是不是通用定义 |

## 协作关系
`isGenericDefinition` 供后续"定义开关"（设置解析、设置页、派工拦截）和"专项审查规矩选择"使用。定义由现有 `loadRoleCatalog` 从 `defaultRoleDir()` 读取，加载逻辑不改。

## 验证方式
- 测试入口：`loadRoleCatalog`（只给内置目录）、`isGenericDefinition`
- 测试输入：仓库 `agents/` 目录
- 预期结果：
  - 内置目录共 17 份定义，`roles` 名单是 5 个通用定义加 12 个专项定义，`problems` 为空
  - 每份专项定义的 role、skills（含顺序）和上表一致；description、正文都不为空且都含栈名；没有 model、thinking
  - 5 个通用定义的正文仍为空（现有用例保留）
  - `isGenericDefinition("reviewer")` 为真，`isGenericDefinition("go-reviewer")`、`isGenericDefinition("acme-worker")` 为假
- [ ] 12 份文件内容与模板逐字一致（替换后）
- [ ] role-catalog、role-rules 两个测试文件按上面更新并通过
