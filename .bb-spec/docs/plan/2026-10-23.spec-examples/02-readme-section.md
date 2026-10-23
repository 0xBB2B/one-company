---
name: readme-section
description: README 在「设置」和「原理」之间新增「设计规范样例」一节，开头目录导航加链接，README 测试补上这一节
---
# README「设计规范样例」一节

## 目标
用户读 README 就知道有 Go、Vue 两套设计规范样例、在哪、三类文件各复制到哪、复制同名定义的后果。

## 业务规则（来源：PRD examples-readme-and-test）
- C-11：README 在「设置」和「原理」两个二级标题之间新增二级标题「设计规范样例」，原有二级标题顺序不变。这一节写明：两套样例及三类文件各是干什么的；装好后样例在 `~/.pi/agent/git/github.com/0xBB2B/one-company/examples/`，也可以在仓库网页上看；skills 复制到 `~/.pi/agent/skills/`（所有项目生效）或仓库内 `.pi/skills/`（只对这个项目生效，项目受信任后才加载）；agents 复制到 `~/.pi/agent/agents/` 或仓库内 `.pi/agents/`，复制后同名内置定义被替换，开关管复制过去的那一份，删掉复制的文件恢复用内置的；`AGENTS.md` 内容并进自己仓库根目录的 `AGENTS.md`，和内置 skill 冲突的条目代理按 `AGENTS.md` 执行；样例是一个团队的规范，照抄前先按自己团队的做法改。
- C-12：README 开头的目录导航加上这一节的链接。
- 路径出处：skill 查找目录见 `src/app/daemon/lifecycle.ts:513-514`（项目层仅受信任时加入）；定义三层目录见 README「角色定义」表；git 包安装位置见 pi 1.3.0 `dist/core/package-manager.js` 的 `getGitInstallRoot`、`resolveManagedPath`。

## 涉及文件
- `README.md` 修改
- `tests/user-documentation.test.ts` 修改

## 成品定义
README 开头目录导航那一行（现第 20 行），在 `[设置](#设置) · ` 后面插入 `[设计规范样例](#设计规范样例) · `，改后整行：

```markdown
[前置条件](#前置条件) · [安装](#安装) · [上手](#上手) · [功能](#功能) · [设置](#设置) · [设计规范样例](#设计规范样例) · [原理](#原理) · [已知限制](#已知限制) · [常见问题](#常见问题) · [参与开发](CONTRIBUTING.md)
```

（落盘前先核对现有这一行，除插入的这一段外其余文字以现有为准。）

在 `## 原理` 正上方插入下面整节（前后各留一个空行）：

```markdown
## 设计规范样例

包里带了两套设计规范样例，演示怎么让专项代理按你团队自己的规范写代码和审查。

| 样例 | 目录 |
|---|---|
| Go 后端 | `examples/golang/` |
| Vue 前端 | `examples/vue/` |

每套样例有三类文件：

- `AGENTS.md`：团队的关键设计决定，比如分层怎么分、错误码长什么样、token 存在哪。PM、worker、reviewer 都会读仓库根目录的 `AGENTS.md`。
- `skills/`：详细规范，每个目录是一份 skill。skill 的设置段写了 `disable-model-invocation: true`，pi 主窗口的模型看不到它们，只有在定义里点名它们的子代理会拿到全文。
- `agents/`：和内置专项定义同名的角色定义（Go 样例是 go-worker、go-reviewer，Vue 样例是 vue-worker、vue-reviewer）。skills 名单先列内置定义原有的 skill，后面加上样例自带的 skill。

用 `pi install git:github.com/0xBB2B/one-company` 装好后，样例在 `~/.pi/agent/git/github.com/0xBB2B/one-company/examples/`，也可以在仓库网页上看。样例是一个团队的规范，照抄前先按你团队的做法改。

用到自己项目里分三步：

1. 把 `skills/` 下的每个目录复制到 `~/.pi/agent/skills/`，对你的所有项目生效；或者复制到仓库内的 `.pi/skills/`，只对这个项目生效，项目在 pi 里设为受信任后才加载。
2. 把 `agents/` 下的定义复制到 `~/.pi/agent/agents/`，对你的所有项目生效；或者复制到仓库内的 `.pi/agents/`，只对这个项目生效，项目在 pi 里设为受信任后才加载。复制后同名的内置定义被替换：派工用的是复制过去的这一份，`/one:setting` 里这个定义的开关管的也是这一份。删掉复制的文件，就恢复用内置的。
3. 把 `AGENTS.md` 的内容并进自己仓库根目录的 `AGENTS.md`。其中和内置 skill 写法冲突的条目，代理按 `AGENTS.md` 执行，例如 Vue 样例把 refresh token 存在 localStorage。
```

## 函数清单
### tests/user-documentation.test.ts
| 函数名 | 职责 |
|---|---|
| `REQUIRED_SECTION_ORDER`（常量） | 在 "设置" 和 "原理" 之间加上 "设计规范样例" |
| `REQUIRED`（「README 必需句」常量） | 加上 `examples/golang/`、`examples/vue/`、`~/.pi/agent/git/github.com/0xBB2B/one-company/examples/`、`[设计规范样例](#设计规范样例)` |

## 协作关系
只改文档和文档测试，不碰产品代码。

## 验证方式
- 测试入口：`pnpm exec vitest run tests/user-documentation.test.ts`。
- 测试输入：仓库根目录的 `README.md`。
- 预期结果：二级标题里有「设计规范样例」，排在「设置」之后、「原理」之前，其余规定标题顺序不变；README 含上面列出的必需句；原有的必需句、禁止句、命令登记检查全部仍通过。
- [ ] `pnpm exec vitest run tests/user-documentation.test.ts` 通过
- [ ] 在 README 里点开头导航的「设计规范样例」能跳到这一节（GitHub 锚点就是标题文字）
- [ ] 逐项对照 C-11，这一节都写到了
