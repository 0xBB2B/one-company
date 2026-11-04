---
name: examples-copy-without-agents-md
description: 样例去掉 AGENTS.md，/one:examples 只复制 skills 和角色定义，确认窗口正常只说几份、特殊情况逐条说明
---
# /one:examples 只复制 skills 和角色定义

## 目标
`examples/` 下没有 AGENTS.md；`/one:examples` 全程不读不写目标层的 AGENTS.md，状态只按 skills 和定义算，确认窗口按新写法显示，选「复制」后直接出结果。

## 业务规则（来源：PRD copy-without-agents-md）
几个词：层目录是用户层 pi 代理目录（默认 `~/.pi/agent/`）或项目层主仓库下的 `.pi/`；一份 = 一个 skill 目录或一个定义文件；"要复制的"是目标缺文件且没有文件被改过的 skill、目标还没有的定义；"一样的"是每个文件都和样例相同；"被改过的"是至少一个文件不同；"要新复制的定义"是要复制的那些定义。
- `examples/golang/`、`examples/vue/` 只有 `skills/`、`agents/`。
- 运行前后用户级、仓库根目录的 AGENTS.md 内容相同，原来不存在的运行后也不存在。
- 每层状态只按 skills 和定义：全部一样「已复制」，全部没有「未复制」，有被改过的「有改动」，其他「部分复制」；AGENTS.md 里有没有样例那一段都不影响。
- 选样例窗口说明：「选中后再选复制到哪一层；skills 和角色定义一起复制。」
- 确认窗口标题、选项不变（「把 <中文名>样例复制到<层名>？」，「复制」「不复制」），正文按顺序：
  - 第一行：有要复制的写「复制 <总份数> 份到 <层目录>：<a> 份 skill、<b> 份角色定义。」，a 或 b 为 0 时省掉那一半和顿号（如「复制 3 份到 ~/.pi/agent/：3 份 skill。」）；没有要复制的写「这一层没有要复制的。」
  - 第二行：一样的 K ≥ 1 份时写「已经有、和样例一样的 <K> 份，跳过。」，K 为 0 不写。
  - 有特殊情况时先空一行，每种一行黄色（warning），顺序：① 被改过的「你改过的 <M> 份保留你的版本，不覆盖：<路径1>、<路径2>」，路径相对层目录，skill 写 `skills/<名字>`、定义写 `agents/<名字>.md`；② 复制到项目层、要新复制的定义在用户层已有同名文件，每个一行「<名字> 会替换你在用户层的同名定义 <用户层定义文件路径>。」；③ 要新复制的定义在 `/one:setting` 里关闭，每个一行「<名字> 在 /one:setting 里是关闭，复制后照样关闭，派工不会用它。」；④ 复制到用户层、项目受信任、要新复制的定义在项目层已有同名文件，每个一行「项目层已有 <名字>，在这个项目里用的是项目层那份，用户层这份不生效。」
  - 没有特殊情况不空行；不列要复制的、一样的名字；替换内置定义时不写说明；路径以家目录开头写成 `~`；正文里不出现「AGENTS.md」。
- 选「复制」后复制完直接出结果提示，中间没有别的窗口。
- 结果第一行「✓ <中文名>样例已复制到<层名>：新复制 <N> 个文件。」（N 按文件计）；有被改过的文件时第二行「被改过、没有覆盖：<完整路径…>。」；项目层首次授信时末尾照样加「 · 已把本项目设为受信任」。
- 复制中途失败：「✗ 复制没有完成：<原因> <目录>/」，第二行「已复制的 <n> 个文件保留；解决后再运行 /one:examples 会接着补。」，原因写法不变。
- 以前复制进 AGENTS.md 的那一段，程序不识别、不提示、不删除（用户 2026-11-04 决定，按不做向后兼容的规矩）。
- 本次改动导致不再使用的东西直接删掉，不留兼容分支。

## 涉及文件
- 删除 `examples/golang/AGENTS.md`、`examples/vue/AGENTS.md`
- 修改 `src/modules/settings/spec-examples.ts`
- 修改 `src/modules/settings/examples-extension.ts`
- 修改 `tests/spec-examples-files.test.ts`、`tests/examples-command.test.ts`、`tests/spec-examples-partial-write.test.ts`、`tests/examples-sep-win32.test.ts`

## 函数清单
### src/modules/settings/spec-examples.ts
| 函数名 | 职责 |
|---|---|
| `layerTargets` | 只给出 skills、agents 两个目标目录，去掉 AGENTS.md 目标 |
| `inspectExample` | 只判定 skills 和定义，去掉样例那一段的判定；整体状态只由它们决定 |
| `findSection`、`mergeConventions` | 删除 |
| `ExampleTargets`、`ExampleInspection` 类型 | 去掉 AGENTS.md 目标和那一段的字段；`MAX_CONVENTIONS_BYTES` 的 import 删除 |

### src/modules/settings/examples-extension.ts
| 函数名 | 职责 |
|---|---|
| `confirmLines` | 按上面的新写法生成确认窗口正文：份数行、跳过行、空行 + 四种黄色特殊情况行；需要层目录来算相对路径和第一行 |
| `conventionsWindow` | 删除 |
| `resultText` | 只写复制结果和被改过的文件，去掉所有 AGENTS.md 相关行和 outcome 参数 |
| `copyFailureText` | 第二行改成「已复制的 <n> 个文件保留；解决后再运行 /one:examples 会接着补。」 |
| `openExamplesPage` | 选样例窗口说明换新文案；去掉读样例 AGENTS.md、合并、写入窗口、写 AGENTS.md 的整段流程；确认后复制完直接出结果 |
| `classLines`、`CLASSES`、`WRITE`/`SKIP_WRITE`、`Outcome`、`readTextOrNull`、`symlinkTarget`/`writeFileAtomic` 的 import | 本次改动后不再使用的一律删除 |

## 协作关系
`openExamplesPage` → `inspectExample`（两层状态）→ `chooseWindow` 选样例、选层 → 重新 `inspectExample` → `confirmLines`（用 `agentSwitchOf`/`readDisabledAgents` 判断开关，`existsSync` 判断另一层同名定义）→ `chooseWindow` 确认 → 项目层授信（`readProjectTrust`/`trustProject`，不变）→ `copyExampleFiles`（不变）→ `ctx.ui.notify(resultText(...))`。`src/modules/verification/project-conventions.ts` 不改。

## 验证方式
- 测试入口：`inspectExample`、`layerTargets`、`copyExampleFiles`、`confirmLines`、`resultText`、`copyFailureText`、`openExamplesPage`（沿用 `tests/examples-command.test.ts` 里模拟窗口的跑法），以及 `examples/` 目录本身。
- 测试输入：临时用户层 / 项目层目录，按场景预置文件；`~/.pi/agent/AGENTS.md`、仓库根目录 AGENTS.md 预置内容或不存在。
- 预期结果：
  - `examples/golang`、`examples/vue` 下只有 `agents`、`skills`。
  - 两层各复制一次，两处 AGENTS.md 逐字节不变；原来不存在的仍不存在。
  - skills、定义全部一致时，不论 AGENTS.md 里有没有「## 后端设计约定」都是「已复制」；删一份 skill 变「部分复制」；改一个 skill 文件变「有改动」。
  - 全新复制 golang 到用户层：确认窗口正文只有「复制 12 份到 ~/.pi/agent/：10 份 skill、2 份角色定义。」；结果只有一行「✓ Go 后端样例已复制到用户层：新复制 12 个文件。」；只弹出过选样例、选层、确认三个窗口。
  - 用户层已有和样例一样的 golang-testing：第二行「已经有、和样例一样的 1 份，跳过。」，第一行「复制 11 份到 ~/.pi/agent/：9 份 skill、2 份角色定义。」
  - 项目层有改过的 version-policy、用户层有 go-worker.md、go-reviewer 关闭、复制到项目层：空一行后依次三行黄字，文字和上面规则逐字一致。
  - 复制到用户层、项目受信任且项目层已有 go-worker：出现「项目层已有 go-worker，在这个项目里用的是项目层那份，用户层这份不生效。」
  - 全部跳过或被改过：第一行「这一层没有要复制的。」；只缺 skill 时第一行「复制 3 份到 ~/.pi/agent/：3 份 skill。」
  - 确认窗口正文不含「AGENTS.md」；选样例窗口说明一字不差。
  - 项目层首次授信，结果末尾带「 · 已把本项目设为受信任」；skills 目录不可写时提示两行和规则一致（Windows 路径分隔符的现有检查保留）。
- [ ] 上述场景的单元测试通过，旧的 AGENTS.md 那一段、合并、写入窗口相关测试删除
- [ ] `pnpm run typecheck`、`pnpm test` 通过
