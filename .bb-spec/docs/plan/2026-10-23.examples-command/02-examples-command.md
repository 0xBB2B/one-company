---
name: examples-command
description: 注册 /one:examples，依次弹选样例、选层、确认、AGENTS.md 差异四个窗口，复制后用一条提示报结果
---
# /one:examples 命令与窗口流程

## 目标
用户输入 `/one:examples`，按确认过的预览（`/Users/bb/Projects/one-company/.bb-spec/.cache/ui-preview/one-examples.html`）走完选样例 → 选层 → 确认 → AGENTS.md 差异窗口，复制缺的文件、按需追加 AGENTS.md 那一段，最后一条提示写清结果。

## 业务规则（来源：PRD choose-and-copy、agents-md-section）
- 没有交互终端（`!ctx.hasUI || ctx.mode !== "tui"`）：只提示「需要交互终端才能打开样例」，不读写文件。
- 层：用户层 = pi 代理目录（`dirname(dataRoot(process.env))`，默认 `~/.pi/agent`）下 `skills/`、`agents/`、`AGENTS.md`；项目层 = `primaryWorktreeRoot(ctx.cwd)` 下 `.pi/skills/`、`.pi/agents/`、`AGENTS.md`。项目受信任 = `new ProjectTrustStore(agentDir).get(主仓库目录) === true`。
- 窗口一（选样例）：标题「要用哪套设计规范样例？」；灰色说明行「选中后再选复制到哪一层；skills、角色定义和 AGENTS.md 那一段一起复制。」；每个样例一个选项，选项名是目录名，说明「<中文名> · 用户层：<状态> · 项目层：<状态>」；项目未受信任时项目层状态写「未受信任」。Esc 说明「不复制」。
- 窗口二（选层）：标题「把 <中文名>样例复制到哪一层？」。用户层说明「~/.pi/agent/ · 对你的所有项目生效」（路径按真实代理目录，家目录写成 `~`，末尾带 `/`）；项目层说明「<主仓库目录>/ · 只对这个项目生效」。项目未受信任 → 项目层变暗「项目未受信任，暂不能复制到这里」；某层整体「已复制」→ 变暗「已全部复制，和样例一致」。两层都暗时不弹窗，提示「<中文名>样例在用户层已全部复制，和样例一致；项目未受信任，不能复制到项目层。」或「<中文名>样例在用户层和项目层都已全部复制，和样例一致。」。
- 窗口三（确认）：标题「把 <中文名>样例复制到<层>？」，正文三块：
  - 「 skills → <目标 skills 目录>/」，下面「新复制 N：a、b」「已一致 N：…」「被改过，跳过 N：…」，数量 0 的不写，名字太长时按窗口宽度折行（窗口自身折行即可）。
  - 「 角色定义 → <目标 agents 目录>/」，分类同上；有新复制的定义时加一行灰色「复制后替换同名的<内置|用户层>定义。开关按定义名记，<…>。」：目标是用户层写「内置」；目标是项目层且用户层 `agents/<名>.md` 存在写「用户层」，否则「内置」。开关状态用 `readAgentSettings(...).disabledAgents` + `agentSwitchOf(名).enabled`：全开写「a、b 现在都是开启」，全关写「a、b 现在都是关闭」，不同时写「a 现在是关闭，b 是开启」。
  - 目标是用户层、项目受信任、项目层 `.pi/agents/<名>.md` 存在时，对每个这样的新复制定义加一行黄色「项目层已有 <名>，在这个项目里用的是项目层那份，用户层这份不生效。」。
  - 「 AGENTS.md → <目标 AGENTS.md>」，下面一句：目标不存在「还没有 AGENTS.md，新建一份，下一步给你看全文再写」；那一段 missing 且不超限「追加「<标题>」一段，下一步给你看差异再写」；same「已有「<标题>」一段，和样例一致，不动」；changed（黄色）「已有「<标题>」一段，和样例不一样，不动」；超限（黄色两行）「合并后 <N> 字节，超过 16 KB 上限 <M> 字节，这次不写。」「精简 AGENTS.md 后再运行 /one:examples，会只补写这一段。」。
  - 「被改过，跳过」那一行用黄色。选项「复制」「不复制」，默认停在「复制」，Esc 说明「不复制」。
- 任一窗口 Esc，或确认窗口选「不复制」：不写任何文件，提示「已取消，没有复制任何文件」。
- 选「复制」：先复制缺的文件。失败时提示两行「✗ 复制没有完成：<原因> <失败目录，~ 写法，末尾 />」「  已复制的 N 个文件保留，AGENTS.md 没有动；解决后再运行 /one:examples 会接着补。」，原因：EACCES/EPERM 写「没有权限写入」，其他写错误信息第一行；AGENTS.md 不动。
- 文件都写好后，只有「新建」或「追加」两种情况弹窗口四（差异）：标题用户层「把这些改动写入用户规范 <~ 写法路径>？」，项目层「把这些改动写入项目规范 AGENTS.md？」；第一行灰色：不存在「还没有 AGENTS.md，要写入的全文如下：」，存在「与现有的 AGENTS.md 相比的改动：」；下面用 `lineDiff(原内容, 合并后)` 逐行显示（`+ ` 行为新增色，其余灰色）；空一行后灰色「写入后，此后派出的 PM、worker、reviewer 都按新内容工作。」；选项「写入」「不写入」，Esc 说明「不写入」。选「写入」后重读目标：和弹窗前一样才写（原子写入），否则不写。
- 结果提示（一条，多行用 `\n` 连接）：
  - 第一行「✓ <中文名>样例已复制到<层>：新复制 N 个文件」+ 写入 AGENTS.md 时「，AGENTS.md 已写入「<标题>」」+「。」。
  - 有被改过没覆盖的文件：「  被改过、没有覆盖：<~ 路径>、<~ 路径>」，那一段 changed 时接「；AGENTS.md 的「<标题>」一段也没动」。
  - AGENTS.md 没写：选了不写入「  AGENTS.md 没有写入；想补上就再运行 /one:examples。」；超限「  AGENTS.md 合并后超过 16 KB 上限，没有写入；精简后再运行 /one:examples 补写。」；确认期间被改动「  确认期间 <~ 路径> 被别处改动，这次没有写入；再运行 /one:examples 补写。」。
  - AGENTS.md 已写入且没有跳过的文件：末行「  此后派出的代理按新规范工作。」。
- 程序窗口的黄色：`WindowLine` 加 `warning` 色调，渲染用主题的 `warning` 颜色。

## 涉及文件
- `src/modules/settings/examples-extension.ts`（新建）
- `src/core/host/question-window.ts`（修改：`LineTone` 加 `warning`）
- `src/app/extension/commands.ts`（修改：注册 `one:examples`）
- `tests/examples-command.test.ts`（新建）、`tests/commands.test.ts`（修改）

## 函数清单
### src/modules/settings/examples-extension.ts
| 函数名 | 职责 |
|---|---|
| `openExamplesPage` | 命令主流程：算两层目标与信任 → 窗口一 → 窗口二 → 窗口三 → 复制 → 窗口四 → `ctx.ui.notify` 结果 |
| `layerStatusText` | 一层的状态文字（含「未受信任」） |
| `confirmLines` | 拼确认窗口正文三块（含替换、开关、项目层同名、AGENTS.md 句子） |
| `conventionsWindow` | 拼差异窗口的标题、正文、选项 |
| `resultText` | 拼结果提示 |
| `copyFailureText` | 把 `ExampleCopyError` 转成两行失败提示 |
### src/app/extension/commands.ts
| 函数名 | 职责 |
|---|---|
| `registerCommands` | 加 `one:examples`（说明「复制设计规范样例」），非交互终端时提示后返回，异常时 notify 第一行；`RegisterCommandsOptions` 加 `openExamplesPage` |
| `commandsExtension` | 传入 `openExamplesPage` |
### src/core/host/question-window.ts
| 函数名 | 职责 |
|---|---|
| `LineTone` / `TONE_COLOR` | 加 `warning` → 主题 `warning` 色 |

## 协作关系
`openExamplesPage` 调 `spec-examples.ts` 的 `listExamples`、`layerTargets`、`inspectExample`、`mergeConventions`、`copyExampleFiles`；窗口用 `chooseWindow`、`mutedLines`；开关用 `readAgentSettings`、`agentSwitchOf`（`agent-settings.ts`）；差异用 `lineDiff`（`verification/project-conventions.ts`）；写文件用 `writeFileAtomic`（`core/storage/store.ts`）；路径显示用 `tilde`（`settings-page-ui.ts`）；信任用 `ProjectTrustStore`，主仓库目录用 `primaryWorktreeRoot`，代理目录用 `dataRoot`。

## 验证方式
- 测试入口：`openExamplesPage(ctx)`（`src/modules/settings/examples-extension.ts`）；`registerCommands(pi, options)` 的 `one:examples` handler。
- 测试输入：照 `tests/agent-definition-copy.test.ts` 末尾那个用例的写法——`PI_CODING_AGENT_DIR` 指向临时代理目录，`<代理目录>/trust.json` 写 `{ "<realpath 仓库>": true }` 表示受信任；`ctx = { hasUI: true, mode: "tui", cwd: 仓库, ui: { custom, notify } }`，`custom` 按脚本逐个窗口渲染（宽 200）、记屏幕文字、喂按键（↓ `\x1b[B`、回车 `\r`、Esc `\x1b`）。样例用包里真实的 `examples/`。
- 预期结果：
  - [ ] handler：`hasUI` 为 false 或 mode 不是 tui 时，只 notify「需要交互终端才能打开样例」，不调 `openExamplesPage`。
  - [ ] 空代理目录 + 未受信任仓库：窗口一出现「golang」「Go 后端 · 用户层：未复制 · 项目层：未受信任」和 vue 一行；窗口二项目层写「项目未受信任，暂不能复制到这里」。
  - [ ] 选 golang → 用户层 → 复制 → 写入：用户层多出 10 个 skill 目录、`go-worker.md`、`go-reviewer.md`、`AGENTS.md`（等于样例全文）；确认窗口含「新复制 10：」「新复制 2：go-worker、go-reviewer」「复制后替换同名的内置定义。开关按定义名记，go-worker、go-reviewer 现在都是开启。」「还没有 AGENTS.md，新建一份，下一步给你看全文再写」；差异窗口标题「把这些改动写入用户规范 …/AGENTS.md？」只有「写入」「不写入」；notify 为「✓ Go 后端样例已复制到用户层：新复制 12 个文件，AGENTS.md 已写入「## 后端设计约定」。」加「此后派出的代理按新规范工作。」。
  - [ ] 再运行：窗口一 golang「用户层：已复制」；选 golang 后（未受信任）不弹窗口二，notify「Go 后端样例在用户层已全部复制，和样例一致；项目未受信任，不能复制到项目层。」。
  - [ ] vue 用户层已有：改过 `vue-constraints/SKILL.md` 和 `vue-worker.md`、删掉 `frontend-constraints/`、AGENTS.md 那一段改过一条：确认窗口含「新复制 1：frontend-constraints」「已一致 1：version-policy」「被改过，跳过 1：vue-constraints」「新复制 1：vue-reviewer」「被改过，跳过 1：vue-worker」「已有「## 前端设计约定」一段，和样例不一样，不动」；不弹差异窗口；两个改过的文件不变；notify 含两个文件路径和「AGENTS.md 的「## 前端设计约定」一段也没动」。
  - [ ] 受信任且 `.pi/agents/vue-reviewer.md` 存在，复制 vue 到用户层：出现「项目层已有 vue-reviewer，在这个项目里用的是项目层那份，用户层这份不生效。」；未受信任时同样布局不出现。
  - [ ] 受信任、用户层已有 golang 定义，复制到项目层：写「复制后替换同名的用户层定义。」；用户设置里关掉 go-worker 时写「go-worker 现在是关闭，go-reviewer 是开启」。
  - [ ] 仓库根 AGENTS.md 预置 12186 字节，复制 golang 到项目层：确认窗口写「合并后 17024 字节，超过 16 KB 上限 640 字节，这次不写。」；不弹差异窗口；AGENTS.md 不变；notify 含「AGENTS.md 合并后超过 16 KB 上限，没有写入」。
  - [ ] 差异窗口选「不写入」或 Esc：文件已复制，AGENTS.md 不变，notify 含「AGENTS.md 没有写入；想补上就再运行 /one:examples。」；之后再运行 golang 显示「用户层：部分复制」。
  - [ ] 差异窗口打开期间改写目标 AGENTS.md 后选「写入」：保持被改后的内容，notify 含「被别处改动，这次没有写入」。
  - [ ] 窗口一、二、三分别 Esc 和确认窗口选「不复制」：notify「已取消，没有复制任何文件」，没有文件变化。
  - [ ] 用户层 `skills/` 设成只读后复制：notify 第一行以「✗ 复制没有完成：没有权限写入」开头，第二行含「AGENTS.md 没有动」；AGENTS.md 不存在。
  - [ ] `WindowLine` 用 `tone: "warning"` 时，渲染调用主题 `fg("warning", …)`。
