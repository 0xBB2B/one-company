---
name: 01-default-from-pi-settings
description: 不写环境变量时，验收从 pi 配置读默认模型和思考等级，读不到就报错说明去哪配
date: 2026-11-05
---

# 验收默认读 pi 配置的模型

下文的"pi 配置"指凭据目录里的 `settings.json`。凭据目录是验收复制 `models.json`、`auth.json` 的那个目录：写了 `ONE_COMPANY_ACCEPTANCE_CREDENTIALS` 就是它，没写就是 `~/.pi/agent`。

## 用户故事
### P0：作为开发者，我想要不写模型就能跑真实模型验收，以便验收和我平时用的 pi 是同一个模型

**用例（主路径）**
- 场景：开发者的 pi 配置里写着 `defaultProvider: 5x-test`、`defaultModel: gpt-6.1-sol`、`defaultThinkingLevel: high`。
- 操作：执行 `ONE_COMPANY_ACCEPTANCE_OUTPUT=/tmp/acc pnpm run test:acceptance:parallel --only P11`。
- 预期：验收用 `5x-test/gpt-6.1-sol`、思考等级 `high` 跑；`/tmp/acc/summary.txt` 里"同时跑开始"那一行写着 `5x-test/gpt-6.1-sol` 和 `high`。

**用例（临时换模型）**
- 场景：同上的 pi 配置，开发者判断上次失败是模型波动，想换 `5x/gpt-6.1-sol` 重跑。
- 操作：执行 `ONE_COMPANY_ACCEPTANCE_MODEL=5x/gpt-6.1-sol ONE_COMPANY_ACCEPTANCE_OUTPUT=/tmp/acc2 pnpm run test:acceptance:parallel --only P11`。
- 预期：验收用 `5x/gpt-6.1-sol`、思考等级 `high`；pi 配置文件内容不变。

**用例（pi 没配模型）**
- 场景：pi 配置里没有 `defaultModel`，开发者也没写 `ONE_COMPANY_ACCEPTANCE_MODEL`。
- 操作：执行 `ONE_COMPANY_ACCEPTANCE_OUTPUT=/tmp/acc pnpm run test:acceptance:parallel`。
- 预期：报错退出，报错里写出 pi 配置文件的完整路径、要配的 `defaultProvider` 和 `defaultModel`，以及也可以改用 `ONE_COMPANY_ACCEPTANCE_MODEL`。

## 约束
1. 写了 `ONE_COMPANY_ACCEPTANCE_OUTPUT`、没写 `ONE_COMPANY_ACCEPTANCE_MODEL` → 验收用 pi 配置里的 `defaultProvider` 和 `defaultModel`。
2. 写了 `ONE_COMPANY_ACCEPTANCE_MODEL` → 用它，不看 pi 配置里的模型；格式不是 `<提供方>/<模型>` 时照现在一样报错。
3. 思考等级按这个顺序取第一个有的：`ONE_COMPANY_ACCEPTANCE_THINKING` → pi 配置里的 `defaultThinkingLevel` → `medium`。取到的值不是 pi 认识的思考等级时报错，报错里写出这个值。
4. 没写 `ONE_COMPANY_ACCEPTANCE_OUTPUT` → 所有真实模型验收跳过，不管写没写模型；直接跑 `pnpm run test:acceptance:parallel` 时报错，说明要设 `ONE_COMPANY_ACCEPTANCE_OUTPUT`，报错里不再要求设 `ONE_COMPANY_ACCEPTANCE_MODEL`。
5. 写了 `ONE_COMPANY_ACCEPTANCE_OUTPUT`，没写 `ONE_COMPANY_ACCEPTANCE_MODEL`，pi 配置里 `defaultProvider` 或 `defaultModel` 缺一项、或者 pi 配置文件不存在 → 报错，报错里写出 pi 配置文件的完整路径、要配的两项名字，并说明也可以改用 `ONE_COMPANY_ACCEPTANCE_MODEL`。
6. `pnpm run test:acceptance:parallel` 在 `summary.txt` 里写的"同时跑开始"那一行，写出这次实际用的 `<提供方>/<模型>` 和思考等级。
7. 验收只读 pi 配置，不改它：跑完后 pi 配置文件内容和跑之前一样。
8. 仓库 `AGENTS.md`、`CONTRIBUTING.md` 里的验收跑法写成不带 `ONE_COMPANY_ACCEPTANCE_MODEL` 的命令，并写明默认用 pi 配置的模型和思考等级、两个环境变量可临时覆盖。

## 验收
- [ ] 约束 1：pi 配置写 `5x-test` / `gpt-6.1-sol`、不写模型环境变量 → 取到的模型是 `5x-test/gpt-6.1-sol`。
- [ ] 约束 2：同样的 pi 配置、写 `ONE_COMPANY_ACCEPTANCE_MODEL=5x/gpt-6.1-sol` → 取到 `5x/gpt-6.1-sol`；写 `ONE_COMPANY_ACCEPTANCE_MODEL=5x` → 报格式错误。
- [ ] 约束 3：环境变量写 `low`、pi 写 `high` → `low`；只有 pi 写 `high` → `high`；两边都没写 → `medium`；环境变量写 `huge` → 报错且报错里有 `huge`。
- [ ] 约束 4：不写证据目录、写了模型 → 验收配置为空、用例跳过；不写证据目录直接跑并行脚本 → 报错只提 `ONE_COMPANY_ACCEPTANCE_OUTPUT`。
- [ ] 约束 5：pi 配置缺 `defaultModel`、缺 `defaultProvider`、文件不存在三种情况 → 都报错，报错里有配置文件完整路径、`defaultProvider`、`defaultModel`、`ONE_COMPANY_ACCEPTANCE_MODEL`。
- [ ] 约束 6：跑一次 `--only P11` → `summary.txt` 的"同时跑开始"那一行含实际模型和思考等级。
- [ ] 约束 7：跑完验收后 pi 配置文件内容不变。
- [ ] 约束 8：`AGENTS.md`、`CONTRIBUTING.md` 的跑法命令里没有 `ONE_COMPANY_ACCEPTANCE_MODEL=`，并写着默认用 pi 配置、环境变量可临时覆盖。

## 验证路径
1. `pnpm test` → 约束 1–5、7 对应的单元测试通过。
2. 只写证据目录跑 `pnpm run test:acceptance:parallel --only P11` → `summary.txt` 开始那一行写着 pi 配置的模型和思考等级，P11 通过。
3. `grep -n "ONE_COMPANY_ACCEPTANCE_MODEL=" AGENTS.md CONTRIBUTING.md` → 没有结果。
