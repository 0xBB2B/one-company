---
name: 08-trace-rules
description: 主代理规矩写上从代码查需求的两个来源和交付两档；新增一条真实模型验收 P14
---
# 从代码查需求的两个来源

## 目标
主代理按规矩从代码查需求时，提交说明里没有编号也能靠"这个提交新增的归档文件"查回；主会话规矩里关于 Git 交付的说法和两档一致；有一条真实模型验收证明主代理会这样查。

## 业务规则（来源：PRD 06-requirement-trace-and-readme C-1）
- 拿编号两个来源按顺序：①提交说明里的 `Requirement: <编号>` 行或标题里的 `[<编号>]`；②都没有时用 `git show --name-only --diff-filter=A <提交>` 看是否新增了 `docs/prd/<编号>.*`。从编号查代码时 `git log --grep <编号>` 和 `git log --diff-filter=A --format='%h %s' -- 'docs/prd/<编号>.*'` 一起用。一个需求压成一个提交时，某处改动是哪个任务做的看归档里的实现记录。原有内容（以代码为准、找不到归档就告诉用户编号、两个来源都没有就照实说查不到）保留。
- `rules/01-main-session.md:15` 里"用户在 /one:setting 的开关里开启 Git 交付后……未开启时推送与合并由用户在外部操作"与两档不符（交付工具一直可用），改成成品定义里的句子。
- 新增验收 P14 只断言可观察的事实：主代理的工具调用里读过那份归档文件，最终回答里出现这个编号；不替模型判断回答对错（与 `tests/acceptance/helpers/evidence.ts:46` 的原则一致）。
- 单点验收从 13 条变成 14 条，`AGENTS.md:64`、`CONTRIBUTING.md:23`、`CONTRIBUTING.md:25` 的"P1–P13 / 13 个单点"和 `CONTRIBUTING.md:50-66` 的编号表同步改。

## 涉及文件
- rules/05-archived-requirements.md（修改）
- rules/01-main-session.md（修改第 8 条末句）
- tests/rules-extension.test.ts、tests/user-documentation.test.ts（修改断言）
- tests/acceptance/points/p14-main-trace.test.ts（新建）
- AGENTS.md、CONTRIBUTING.md（修改单点数量和编号表）

## 成品定义
`rules/05-archived-requirements.md` 全文：

```markdown
## 归档需求
已完成需求的最终 PRD 归档在 `docs/prd`。需要时可以直接读取，例如用户问到已完成需求的内容，或合并代码遇到冲突要判断当初的要求；读到的是历史记录，不是当前目标，不据此改动活动需求或派工。活动需求正文只经 `one_company_requirement_manage` 按授权读取。

要查某段代码为什么这样写时，先用 `git log --format='%h %s%n%b' -- <文件>` 列出改过它的提交；只关心某个函数时，改用 `git log -L <起始行>,<结束行>:<文件>`。然后按顺序找需求编号：先看提交说明，PM 的提交末尾有一行 `Requirement: <编号>`，交付合并的提交标题里可能带 `[<编号>]`；说明里都没有时，用 `git show --name-only --diff-filter=A <提交>` 看这个提交有没有新增 `docs/prd/<编号>.*` 文件，有就用这个编号——压缩合并时归档和代码在同一个提交里。拿到编号后，读 `docs/prd` 下以这个编号开头的归档文件。一个需求压成一个提交时，要知道某处改动是哪个任务做的，读归档里的实现记录。找不到归档，说明这个需求还没完成，或者归档还没合进当前分支，这时把编号告诉用户。两个来源都没有编号的，比如在主窗口直接提交的代码，或者接入 one-company 之前的老代码，就照实说查不到对应需求，只读提交说明。归档写的是当时的要求，和代码对不上时以代码为准，并说清哪里对不上。

要查某个需求改了哪些代码时，`git log --grep <编号>` 和 `git log --diff-filter=A --format='%h %s' -- 'docs/prd/<编号>.*'` 两条一起用：后一条找到的是带着归档进来的那个提交，压缩合并时它就是整个需求的提交。
```

`rules/01-main-session.md` 第 8 条最后一句替换为：

```markdown
需求关闭后可用 `one_company_git_deliver` 交付：Git 交付在远程档位时推送并建立或复用 PR，在仅本地档位时在本机合进主仓库当前分支；档位和可用的合并方式在 /one:setting 的「开关」里设置，推送确认与合并方式由界面直接问用户。
```

## 函数清单
### tests/acceptance/points/p14-main-trace.test.ts
| 函数名 | 职责 |
|---|---|
| 测试 `P14：提交说明没有编号时靠归档文件查回需求` | 用 `startMainPoint(config, "p14", { seed })`；seed 里在样例项目造一个压缩提交：标题"fix login"、正文为空，同时新增 `src/login.ts` 和 `docs/prd/<UUIDv7>.登录页加上验证码登录.md`（写明验证码 5 分钟过期）；`point.say` 问"src/login.ts 里验证码为什么 5 分钟过期？依据是什么？"；断言见验证方式；写证据并 `point.close` |

## 协作关系
- 规矩由 `src/app/extension/rules.ts:48-54` 按文件名顺序拼进主代理提示词，无需改代码。
- 验收按 AGENTS.md 规则：每条先同时跑 2 次，一过一不过跑第 3 次。

## 验证方式
- 测试入口：`pnpm test`（rules-extension、user-documentation）；`ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型> ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel --only P14`。
- 预期结果：
- [ ] 主代理提示词含 `git show --name-only --diff-filter=A <提交>`、`git log --diff-filter=A --format='%h %s' -- 'docs/prd/<编号>.*'`、`git log --grep <编号>`、"实现记录"，且"先看提交说明"在"说明里都没有时"之前。
- [ ] 主代理提示词含"Git 交付在远程档位时""仅本地档位"，不含"开关里开启 Git 交付"。
- [ ] P14：主代理工具调用里有读取 `docs/prd/<UUIDv7>.登录页加上验证码登录.md` 的调用（读文件或 `cat`/`git show` 输出含该路径）；最终回答含这个 UUIDv7。
- [ ] `AGENTS.md`、`CONTRIBUTING.md` 里搜不到"P1–P13"和"13 个单点"，编号表有 P14 一行。
