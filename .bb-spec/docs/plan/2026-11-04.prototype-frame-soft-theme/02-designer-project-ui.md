---
name: designer-project-ui
description: 设计师规矩加"先读项目整体布局和现有样式再画"，新增单点验收 P19
---
# 设计师结合项目整体界面出原型

## 目标
原型设计师的规矩要求它先读懂项目的整体布局和现有样式，改已有页面整页还原、新页面套进整体布局；新增真实模型单点验收 P19 检查它照做。

## 业务规则（来源：PRD designer-follows-project-ui）
- 原型设计师只能读仓库文件，不能写文件、不能运行命令。它的规矩在 `role-rules/prototype.md`，程序固定加进提示词。
- 规矩要写明五件事：先找界面代码并读懂整体布局（顶栏、侧边导航、页脚、内容区宽度和边距）、现有样式（配色、字体、字号、间距、圆角）和要用的组件；改已有页面先整页还原再只改要改的地方；新页面套进现有整体布局，用现有样式和组件，没有的组件按现有配色、字号、间距画；终端界面照现有命令的输出格式还原（前缀、颜色、对齐、提示文字写法）；找不到界面代码时按任务说明自己定，读不懂的写进 openQuestions、不猜。
- P19：样例项目里有一个布局组件（顶栏导航写着"工作台""订单""客户""设置"）、一个写着主色 `#0f766e` 的样式文件、一个已有"账号安全""通知"两块标题的设置页。真实模型扮演设计师，任务是在设置页加"每日提醒时间"设置项。判定：交稿被收下（看板状态 `awaiting`）；最后一次交稿的 html 里能搜到 4 个导航文字、主色值（不分大小写）和"账号安全""通知"。设计得好不好不判。
- 合并前 P19 和其余单点一起按项目规矩跑两次（一过一不过跑第三次）。

## 涉及文件
- 修改 `role-rules/prototype.md`
- 修改 `tests/role-rules.test.ts`
- 新建 `tests/acceptance/points/p19-prototype-project-ui.test.ts`（并行脚本按用例名冒号前的编号自动发现，用例名以"P19："开头）

## 成品定义
`role-rules/prototype.md` 第 10 行"- 只能读仓库里的文件，不能改文件，也不能运行命令；需要了解现有界面时读源码和样式。"整行替换成下面四行：

```markdown
- 只能读仓库里的文件，不能改文件，也不能运行命令。
- 动手画之前，先在仓库里找这次涉及的界面代码（页面组件、布局组件、样式文件，命令行程序里拼输出文字的代码），读懂整体布局（顶栏、侧边导航、页脚、内容区宽度和边距）、现有样式（配色、字体、字号、间距、圆角）和这次要用到的组件长什么样。
- 改已有页面时，先把这个页面照现在的样子整页还原，包括整体布局和页面里这次不改的部分，再只改这次要改的地方。做新页面时，把它套进项目现有的整体布局，用现有样式和现有组件的样子画；项目里没有的组件，按现有样式的配色、字号、间距画。终端界面同样照现有命令的输出格式还原，包括前缀、颜色、对齐方式和提示文字的写法。
- 仓库里找不到界面代码时，按任务说明自己定布局和样式；找到了但读不懂某一部分的样子时，把读不懂的地方写进 openQuestions，不猜。
```

P19 样例项目文件（测试里写进 `w.fixture.root`，再派设计师）：

```text
src/layout/AppShell.html
<header class="topbar"><nav><a>工作台</a><a>订单</a><a>客户</a><a class="active">设置</a></nav></header>
<main class="content"><slot></slot></main>

src/styles/tokens.css
:root { --color-primary: #0f766e; --color-text: #1f2933; --radius: 6px; --space: 8px; }

src/pages/settings.html
<section><h2>账号安全</h2><p>修改密码、绑定手机</p></section>
<section><h2>通知</h2><p>邮件通知、站内信</p></section>
```

P19 的任务说明（brief）：`在设置页里加一个"每日提醒时间"设置项：管理员选一个时间，每天这个时间给成员发提醒；保存时要等待，保存可能失败。`；原型名称 `设置页每日提醒`。

## 函数清单
### tests/acceptance/points/p19-prototype-project-ui.test.ts
| 函数名 | 职责 |
|---|---|
| P19 测试用例 | 照 P17 的写法建 `createPmRunWorld` 和真实模型，写入样例项目文件，调 `prototypes.dispatch`，等看板 `awaiting`，按业务规则判定并把判定材料写进证据目录 `judgement.json` |

### tests/role-rules.test.ts
| 函数名 | 职责 |
|---|---|
| 设计师规矩用例 | 断言 `loadRoleRules("prototype")` 含成品定义四行里的关键句 |

## 协作关系
P19 复用 `tests/helpers/run-manager-fixture.ts` 的 `createPmRunWorld`、`tests/acceptance/helpers/*` 的 `acceptanceConfig`、`pointEvidence`、`createRealModel`，和 P17 同样只把设计师的请求交给真实模型。

## 验证方式
- 测试入口：`pnpm test tests/role-rules.test.ts`；`ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型> ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance:parallel --only P19`。
- 测试输入：上面的样例项目文件和 brief。
- 预期结果：
- [ ] `loadRoleRules("prototype")` 含"整体布局（顶栏、侧边导航、页脚、内容区宽度和边距）""先把这个页面照现在的样子整页还原""照现有命令的输出格式还原""读不懂的地方写进 openQuestions"
- [ ] 没有验收配置时 P19 跳过（和 P17 一样 `skipIf`）
- [ ] 有配置时 P19 判定：状态 `awaiting`，html 含"工作台""订单""客户""设置""账号安全""通知"，`/#0f766e/i` 命中
