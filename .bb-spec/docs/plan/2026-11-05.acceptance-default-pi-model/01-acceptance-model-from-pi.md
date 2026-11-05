---
name: 01-acceptance-model-from-pi
description: 验收配置默认从 pi 配置读模型和思考等级，并行脚本只要求证据目录并在汇总里写明模型，文档跑法同步
---
# 验收默认读 pi 配置的模型

## 目标
不写 `ONE_COMPANY_ACCEPTANCE_MODEL` 时，真实模型验收用 pi 配置里的默认模型和思考等级；`summary.txt` 写明实际用的模型；AGENTS.md、CONTRIBUTING.md 的跑法同步。

## 业务规则（来源：PRD 01-default-from-pi-settings）
"pi 配置"指凭据目录里的 `settings.json`。凭据目录：写了 `ONE_COMPANY_ACCEPTANCE_CREDENTIALS` 就是它，否则是 `~/.pi/agent`。只读这一份，不读任何项目目录下的 `.pi/settings.json`，也不改它。
1. 有 `ONE_COMPANY_ACCEPTANCE_OUTPUT`、没有 `ONE_COMPANY_ACCEPTANCE_MODEL` → 模型取 pi 配置的 `defaultProvider` + `defaultModel`。
2. 有 `ONE_COMPANY_ACCEPTANCE_MODEL` → 用它，不看 pi 配置的模型；不是 `<提供方>/<模型>` 格式时报错（沿用现有报错）。
3. 思考等级取第一个有的：`ONE_COMPANY_ACCEPTANCE_THINKING` → pi 配置 `defaultThinkingLevel` → `medium`。取到的值不在 `off/minimal/low/medium/high/xhigh/max` 里时报错，报错含这个值。
4. 没有 `ONE_COMPANY_ACCEPTANCE_OUTPUT` → `acceptanceConfig()` 返回 null（用例跳过），不管有没有模型变量；`node tests/acceptance/run-parallel.ts` 报错只要求设 `ONE_COMPANY_ACCEPTANCE_OUTPUT`。
5. 有证据目录、没有模型变量，pi 配置缺 `defaultProvider` 或 `defaultModel`、或文件不存在 → 报错，报错含 pi 配置文件完整路径、`defaultProvider`、`defaultModel`、`ONE_COMPANY_ACCEPTANCE_MODEL`。pi 读配置文件出错（如 JSON 坏了）时也报错，带上 pi 给的错误原因和文件路径。
6. 并行脚本"同时跑开始"那一行写出实际 `<提供方>/<模型>` 和思考等级。
7. 跑完 pi 配置文件内容不变。
8. AGENTS.md、CONTRIBUTING.md 跑法命令不带 `ONE_COMPANY_ACCEPTANCE_MODEL=`，写明默认用 pi 配置的模型和思考等级、`ONE_COMPANY_ACCEPTANCE_MODEL` 和 `ONE_COMPANY_ACCEPTANCE_THINKING` 可临时覆盖。
决策理由：开发者已在 pi 配好模型，验收再手写会对不上；保留环境变量是为了判断模型波动时临时换模型重跑，不用改 pi 配置；pi 没配思考等级时用 pi 自己的默认 `medium`，与直接打开 pi 一致（用户 2026-11-05 决定）。

## 涉及文件
- 新建 `tests/acceptance/helpers/acceptance-model.ts`
- 修改 `tests/acceptance/helpers/installed-host.ts`（`acceptanceConfig` 与 `THINKING_LEVELS` 所在处，约 20–43 行）
- 修改 `tests/acceptance/run-parallel.ts`（15 行的检查、40 行的开始日志）
- 新建 `tests/acceptance-config.test.ts`
- 修改 `tests/user-documentation.test.ts`（加文档跑法检查）
- 修改 `AGENTS.md`（68 行跑法）、`CONTRIBUTING.md`（「真实模型验收」节 33–40 行）

## 函数清单
### tests/acceptance/helpers/acceptance-model.ts
| 函数名 | 职责 |
|---|---|
| `resolveAcceptanceModel` | 按规则 1–3、5 决定提供方、模型、思考等级和凭据目录；用 pi 的 `SettingsManager.create(凭据目录, 凭据目录, { projectTrusted: false })` 读配置，只读全局那份；读出错（`drainErrors()` 非空）或缺项时按规则 5 报错 |

`THINKING_LEVELS` 与 `Thinking` 类型从 installed-host.ts 挪到这里并导出，installed-host.ts 改为从这里引用，不留两份。

### tests/acceptance/helpers/installed-host.ts
| 函数名 | 职责 |
|---|---|
| `acceptanceConfig` | 没有证据目录返回 null；证据目录不是绝对路径照旧报错；其余字段来自 `resolveAcceptanceModel`。函数上方的注释改成"只有给出证据目录时才跑"的意思 |

### tests/acceptance/run-parallel.ts
| 位置 | 职责 |
|---|---|
| 顶部检查 | 只要求 `ONE_COMPANY_ACCEPTANCE_OUTPUT`；随后调用 `resolveAcceptanceModel` 取模型（取不到直接报错退出，此时还没建证据目录里的任何文件也可以） |
| "同时跑开始"日志 | 文本里加上 `模型 <提供方>/<模型>，思考等级 <等级>` |

## 协作关系
`run-parallel.ts` 和 `installed-host.ts` 的 `acceptanceConfig` 都调用 `resolveAcceptanceModel`；它依赖 `@earendil-works/pi-coding-agent` 的 `SettingsManager`（项目已在用）。`run-parallel.ts` 启动的每个 vitest 子进程继承同样的环境变量，各自再算一遍，结果一致。

## 验证方式
- 测试入口 A：`acceptanceConfig()`（`tests/acceptance/helpers/installed-host.ts` 导出），在单元测试里设置/清除环境变量后调用；凭据目录用 `ONE_COMPANY_ACCEPTANCE_CREDENTIALS` 指向测试里用 `temporaryRoot()` 下新建的目录，在里面写 `settings.json`。每个用例结束恢复原环境变量。
- 测试入口 B：用 `node tests/acceptance/run-parallel.ts` 起子进程（环境里去掉 `ONE_COMPANY_ACCEPTANCE_OUTPUT`），看退出码和 stderr。
- 测试入口 C：读仓库根 `AGENTS.md`、`CONTRIBUTING.md` 原文。
- 预期结果：
- [ ] settings 写 `{"defaultProvider":"5x-test","defaultModel":"gpt-6.1-sol"}`、有证据目录、无模型变量 → `provider` 为 `5x-test`、`modelId` 为 `gpt-6.1-sol`、`thinking` 为 `medium`、`credentialsDir` 为该目录
- [ ] 同上再加 `ONE_COMPANY_ACCEPTANCE_MODEL=5x/gpt-6.1-sol` → `5x` / `gpt-6.1-sol`；改成 `ONE_COMPANY_ACCEPTANCE_MODEL=5x` → 抛错，信息含 `<provider>/<model>`
- [ ] settings 加 `"defaultThinkingLevel":"high"` → `high`；再设 `ONE_COMPANY_ACCEPTANCE_THINKING=low` → `low`；设 `ONE_COMPANY_ACCEPTANCE_THINKING=huge` → 抛错且信息含 `huge`
- [ ] 不设证据目录、设了模型变量 → 返回 null
- [ ] settings 缺 `defaultModel` / 缺 `defaultProvider` / 凭据目录里没有 settings.json 三种情况、无模型变量 → 都抛错，信息含 `<凭据目录>/settings.json` 完整路径、`defaultProvider`、`defaultModel`、`ONE_COMPANY_ACCEPTANCE_MODEL`
- [ ] 凭据目录下另建 `.pi/settings.json` 写别的模型 → 结果不受影响（只读全局那份）
- [ ] 调用前后 settings.json 内容逐字节相同
- [ ] 入口 B：退出码非 0，stderr 含 `ONE_COMPANY_ACCEPTANCE_OUTPUT`，不含 `ONE_COMPANY_ACCEPTANCE_MODEL`
- [ ] 入口 C：两份文档里搜不到 `ONE_COMPANY_ACCEPTANCE_MODEL=`；都含 `ONE_COMPANY_ACCEPTANCE_MODEL`、`ONE_COMPANY_ACCEPTANCE_THINKING` 和"pi"字样的默认说明
- [ ] 真实运行：只设 `ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径>` 跑 `pnpm run test:acceptance:parallel --only P11` → `summary.txt` "同时跑开始"那一行含 `5x-test/gpt-6.1-sol` 和 `high`（本机 pi 当前配置），P11 判定通过
