---
name: docs
description: README、CONTRIBUTING 跟上：样例只有 skills 和角色定义、定义正文可写明不适用的 skill 条目、单点验收增加 P18
---
# 文档跟上新行为

## 目标
README 和 CONTRIBUTING 写的是现在的做法：样例只复制 skills 和角色定义，不碰 AGENTS.md；定义正文写明某条 skill 不适用时代理按定义正文；单点验收是 P1–P18、18 个。

## 业务规则（来源：PRD OVERVIEW、copy-without-agents-md、definition-body-overrides-skill）
- 样例有两类文件：详细规范 skill，和内置专项定义同名、加挂这些 skill 的角色定义；定义正文写明本团队不适用的内置 skill 条目（例如 auth-session 第 15 条，样例把 refresh token 存在 localStorage）。
- `/one:examples` 只复制 skills 和角色定义，不读不写用户级或仓库根目录的 AGENTS.md。以前复制进 AGENTS.md 的那一段，程序不管，用户自己删（这句写不写进 README 由下面"写法"决定：只写现在怎么做）。
- worker、专项审查、通用审查遇到定义正文写明某份 skill 的某一条不适用时，按定义正文；同一份 skill 的其他条目照常执行。
- 新增单点 P18：vue-reviewer 装上 Vue 样例定义后，审一次同时有"refresh token 存 localStorage""refresh token 拼进 URL""v-html 渲染评论"的改动，后两处列为阻塞，localStorage 那处不列。
- 写法：只写现在怎么做，不写"不再""以前会追加"这类要知道旧做法才看得懂的话；文档要能单独读懂，不写"详见 X"。

## 涉及文件
- 修改 `README.md`
- 修改 `CONTRIBUTING.md`
- 修改 `tests/user-documentation.test.ts`

## 函数清单
无函数改动。要改的位置：

### README.md
| 位置 | 改成什么 |
|---|---|
| 「规范从哪来」表 `包内 skills/` 一行 | 冲突说明补上：定义正文写明某条不适用时按定义正文 |
| 同表 `~/.pi/agent/AGENTS.md` 一行 | 内容只写「你的个人规范」，去掉 `/one:examples` 追加那半句 |
| 「设计规范样例」一节 | "三类文件"改成两类，删掉 `AGENTS.md` 那一条；`agents/` 那条补上"定义正文写明本团队不适用的内置 skill 条目"及 localStorage 例子；复制目标表去掉 AGENTS.md 一列；删掉"AGENTS.md 按样例那一段的标题认……"整条；确认窗口按"正常只说几份、有特殊情况逐条说明"描述 |
| 「专项定义」相关段落（专项审查只按预设的 skills 和项目 AGENTS.md 审） | 补一句定义正文写明不适用的条目不算问题 |

### CONTRIBUTING.md
| 位置 | 改成什么 |
|---|---|
| 测试命令表 `test:acceptance:parallel` 一行 | 「17 个单点」改成「18 个单点」 |
| 合并前那段 | 「全部单点（P1–P17）」改成「P1–P18」 |
| 单点编号表 | P17 之后新增 P18 一行：场景"vue-reviewer 装上 Vue 样例定义（正文写明 auth-session 第 15 条不适用），改动里有 refresh token 存 localStorage、refresh token 拼进 URL、v-html 渲染评论"，预期"URL 和 v-html 两处列为阻塞，localStorage 那处不列" |

### tests/user-documentation.test.ts
| 位置 | 改成什么 |
|---|---|
| README 检查里 `"你的个人规范；`/one:examples` 经你确认后会在末尾追加样例那一段"` | 改成检查新写法；README「设计规范样例」一节不含「AGENTS.md 按样例那一段的标题」 |
| 「验收单点数量」 | 加检查：AGENTS.md、CONTRIBUTING.md 里搜不到 `P1–P17`、`17 个单点`；CONTRIBUTING.md 编号表有 `| P18 |` 行 |

## 协作关系
仓库 `AGENTS.md` 的单点范围已在 PRD 提交里改成 P1–P18，本 plan 不再改它。`ARCHITECTURE.md` 里"`/one:examples` 把它们复制到用户层或项目层"仍然成立，不改。

## 验证方式
- 测试入口：`pnpm test` 中的 `tests/user-documentation.test.ts`。
- 测试输入：仓库根目录的 README.md、CONTRIBUTING.md、AGENTS.md。
- 预期结果：
  - README「设计规范样例」一节写两类文件，没有 AGENTS.md 一列和"按样例那一段的标题认"那条；写了定义正文写明不适用条目的做法。
  - README「规范从哪来」表 `~/.pi/agent/AGENTS.md` 一行不含 `/one:examples`。
  - AGENTS.md、CONTRIBUTING.md 不含 `P1–P17`、`17 个单点`；CONTRIBUTING.md 编号表有 P18 一行。
  - 在本次改动的文件里搜「不再」「不进」「不询问」「无需」，没有因本次新增的命中。
- [ ] `tests/user-documentation.test.ts` 通过
- [ ] `pnpm test` 通过
