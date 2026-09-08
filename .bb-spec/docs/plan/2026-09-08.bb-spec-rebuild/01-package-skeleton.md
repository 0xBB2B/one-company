---
name: package-skeleton
description: 清理 main 上被替代的外部子代理桥接、旧角色与旧命令入口，建立 pi-company 包声明、可剥离 TS 语法约定与隔离测试助手
---
# 包骨架与测试基础

## 目标
仓库成为 pi-company 包骨架：不再依赖任何外部子代理系统，三层代码目录（extensions / daemon / runtime）就位，守护进程代码可被 Node 直接加载，测试可在隔离的临时目录中运行。

## 业务规则（来源：spec）
- builtin-execution：只安装本包且守护进程与模型可用即可派出需求代理与角色，不得要求安装或加载其他子代理系统；故障时不启动替代执行方式。
- namespaced-entrypoints：本包不注册 /spec-new、/spec-resume、/spec-revise、/spec-sync 四个旧别名；旧的 prompts 入口整体删除，新入口在命令 plan 中注册。
- daemon-host：守护进程是独立于窗口的进程，用本机模型配置与凭据工作；本 plan 只建立它能被宿主 Node 直接运行的语法前提。
- role-catalog：包内附带默认角色定义；旧的六个角色文件与符号链接桥接被整体废弃，新定义在角色目录 plan 中建立。

## 涉及文件
- 删除：extensions/agents-bridge.ts — 外部子代理系统的符号链接桥接
- 删除：extensions/subagents-preflight.ts — 外部子代理系统探测
- 删除：prompts/spec-new.md、prompts/spec-resume.md、prompts/spec-revise.md、prompts/spec-sync.md — 旧命令入口
- 删除：agents/acceptance-reviewer.md、agents/impl-engineer.md、agents/pre-reviewer.md、agents/review-engineer.md、agents/test-engineer.md、agents/planner.md — 旧六角色定义
- 删除：skills/spec-docs/scripts/decision-ledger.ts、tests/decision-ledger.test.ts、tests/decision-record.test.ts、tests/helpers/requirement-fixture.ts — 需求目录内决策台账实现与测试，由本机决策记录取代
- 删除：tests/subagents-preflight.test.ts、tests/acceptance-direct-json.test.ts、tests/git-push-direct-json.test.ts、tests/git-push-auto-repair.test.ts、tests/review-failure-handling.test.ts、tests/spec-flow-auto-repair.test.ts、tests/task-file-line-limit-authoring.test.ts、tests/task-file-line-limit-planning-check.test.ts — 断言旧角色与旧流程文本的契约测试
- 修改：package.json — 按成品定义整体替换
- 修改：.gitignore — 追加 `.pi-company/.cache/`
- 新建：tests/helpers/temp-home.ts — 隔离 HOME、agentDir 与本机数据根
- 新建：tests/helpers/controlled-provider.ts — 不联网的脚本化模型 provider
- 新建：tests/helpers/repo-fixture.ts — 临时 Git 仓库、worktree 与多仓库工作区
- 新建：tests/helpers/virtual-terminal.ts — 用 pi-tui 的 VirtualTerminal 渲染组件并驱动按键
- 新建：tests/erasable-syntax.test.ts — 逐文件校验 runtime/ 与 daemon/ 可被 Node 直接加载
- 新建：tests/package-skeleton.test.ts — 包声明与删除项契约

## 成品定义

```json
{
  "name": "@0xbb2b/pi-company",
  "version": "0.1.0",
  "description": "pi 的需求驱动开发流程包：主会话对齐需求，守护进程内的需求代理按工作流形状调度角色子代理完成实施、审查与验收",
  "type": "module",
  "license": "MIT",
  "keywords": ["pi-package", "spec", "tdd", "workflow", "subagents"],
  "files": ["agents", "daemon", "extensions", "runtime", "rules", "skills", "README.md", "LICENSE"],
  "scripts": {
    "test": "bun test tests"
  },
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": []
  },
  "dependencies": {
    "typebox": "最新稳定版（exec 经官方渠道核实后填具体版本）"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-tui": "*"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "最新稳定版（exec 经官方渠道核实后填具体版本）",
    "@earendil-works/pi-ai": "与 pi-coding-agent 同版本",
    "@earendil-works/pi-tui": "与 pi-coding-agent 同版本"
  },
  "engines": {
    "node": ">=22.19.0"
  }
}
```

可剥离 TypeScript 语法约定（runtime/、daemon/ 全部文件，extensions/ 建议遵守）：不使用 `enum`、`namespace`、构造函数参数属性、装饰器、`import x = require()`；相对 import 必须带 `.ts` 后缀；仅类型导入用 `import type`；不依赖 tsconfig 路径别名。

## 函数清单

### tests/helpers/temp-home.ts
| 函数名 | 职责 |
|---|---|
| `createTempHome` | 在临时目录下建立 HOME、agentDir（含空 settings.json）与本机数据根，返回路径与环境变量映射 |
| `removeTempHome` | 递归删除临时目录，忽略不存在 |

### tests/helpers/controlled-provider.ts
| 函数名 | 职责 |
|---|---|
| `registerControlledProvider` | 向给定模型运行时注册一个不联网 provider，并返回可注入脚本的句柄 |
| `scriptReplies` | 为后续请求排队脚本化回复：文本、思考、工具调用、错误、连接失败、超长错误 |
| `requestLog` | 返回该 provider 收到的请求序列供断言 |

### tests/helpers/repo-fixture.ts
| 函数名 | 职责 |
|---|---|
| `createRepoFixture` | 初始化带一次提交的临时 Git 仓库 |
| `addWorktree` | 为夹具仓库创建 linked worktree |
| `createWorkspaceFixture` | 创建包含多个仓库的父目录，可带 node_modules 干扰目录 |
| `removeRepoFixture` | 清理仓库、worktree 与父目录 |

### tests/helpers/virtual-terminal.ts
| 函数名 | 职责 |
|---|---|
| `renderComponent` | 在指定宽高的虚拟终端中渲染组件并返回逐行文本 |
| `pressKeys` | 依次投递按键序列并返回每次之后的渲染结果 |

### tests/erasable-syntax.test.ts
| 函数名 | 职责 |
|---|---|
| `listSourceFiles` | 枚举 runtime/ 与 daemon/ 下全部 .ts 文件 |
| `checkErasable` | 以宿主 Node 的类型剥离模式做语法检查，返回退出码与输出 |

## 协作关系
- 测试助手被后续所有 plan 的测试复用；`createTempHome` 的环境变量映射供守护进程子进程与 SDK 使用。
- `registerControlledProvider` 依赖 SDK 的 provider 注册接口，返回句柄由角色会话、需求代理、断网续接等测试注入回复。
- `createWorkspaceFixture` 供工作区发现与多仓库协作测试。
- 本 plan 不新增任何生产模块；删除项与被替代实现的对应关系在各自 plan 中重新建立。

## 验证方式
- 测试入口：`bun test tests`；`node --experimental-strip-types --check <file>`；读取 package.json
- 测试输入：仓库工作树；临时目录
- 预期结果：
  - package.json 的 name 为 `@0xbb2b/pi-company`，`pi.prompts` 为空数组，`files` 含 agents、daemon、extensions、runtime、rules、skills，dependencies 含 typebox，peerDependencies 恰为三个 pi 包且值为 `*`
  - 被删除的十个源文件与十个测试文件均不存在；`agents/` 下不存在旧六角色文件名
  - runtime/ 与 daemon/ 下每个 .ts 文件的类型剥离语法检查退出码为 0；任一文件含 `enum ` 或 `namespace ` 关键字或无后缀相对 import 即失败
  - `createTempHome` 返回的目录互不重复，HOME 下无真实用户文件；`removeTempHome` 后目录不存在
  - `registerControlledProvider` 注册后，脚本化的文本回复、工具调用与"连接失败"能依次被取出；未排队时请求得到明确错误而非挂起
  - `createWorkspaceFixture` 生成的父目录含两个独立 Git 仓库与一个 node_modules 下的伪仓库
- [ ] 包声明契约
- [ ] 删除项不存在
- [ ] 可剥离语法逐文件通过
- [ ] 四个测试助手各自的正常与错误路径
