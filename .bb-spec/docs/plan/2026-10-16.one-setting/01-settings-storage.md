---
name: settings-storage
description: pi 设置文件 one-company 字段新增 git-delivery 开关的读、写、清除与写错检查
---
# 设置文件支持 Git 交付开关

## 目标
`runtime/agent-settings.ts` 能读出 Git 交付开关在两层合并后的值和来源，能把开关写进或清出某一层，写错时给出问题条目。

## 业务规则（来源：PRD git-delivery-switch、layout-navigation）
- 设置文件：用户层 `<agentDir>/settings.json`，项目层 `<仓库根>/.pi/settings.json`；one-company 的设定都在 `"one-company"` 对象下。开关的键名是 `git-delivery`，值只能是 JSON 的 `true` 或 `false`。
- 取值顺序：项目层（`projectTrusted` 为真时才读）> 用户层 > 内置默认值。内置默认值是关闭（false），来源记为 default。
- 某一层的 `git-delivery` 不是布尔值时：这一层的这一项不生效、改用下一层；问题列表里加一条，`display` 是"git-delivery 只能写 true 或 false"，并带上文件里的原样写法（用 `JSON.stringify` 写出，例如 `"yes"`），供页面在详情里显示"现在是"。
- `one-company` 下出现不认识的键时，问题的 `display` 改成"不认识的设定 <键名>，只能是 pm、interpreter、draft-verifier、git-delivery"（原来写"不认识的角色"）。
- 保存只改所选那一层文件里 `one-company.git-delivery` 这一项，文件里其他内容原样保留；文件不存在时新建；文件读不了、不是合法 JSON、顶层不是对象时不写，抛出的错误信息沿用现有的写法（例如"设置文件不是合法的 JSON，没有改动：<路径>"）。
- 清除只删所选那一层的 `git-delivery`；删完 `one-company` 变空时把 `one-company` 整个去掉（和现有清除角色设定一样）；这一层本来就没有这一项时不写文件。
- 角色设定（pm、interpreter、draft-verifier）的读法、写法、问题文字都不变；守护进程读 PM 设定的地方不受影响。

## 涉及文件
- 修改 `runtime/agent-settings.ts`
- 修改 `tests/agent-settings.test.ts`（补开关的用例，改"不认识的角色"的期望）

## 函数清单
### runtime/agent-settings.ts
| 函数名 | 职责 |
|---|---|
| `parseSettingsLayer` | 修改：除三个角色外还认 `git-delivery`，读出这一层的开关值；非布尔值记问题并带原样写法；不认识的键改用新文字 |
| `readAgentSettings` | 修改：返回值多一项 Git 交付开关合并后的结果（是否开启 + 来源 project/user/default） |
| `saveGitDeliverySetting` | 新增：把开关写进指定那一层文件的 `one-company.git-delivery`，复用现有的 `rewriteSettings` |
| `clearGitDeliverySetting` | 新增：删掉指定那一层文件里的 `one-company.git-delivery`，复用 `rewriteSettings` |
| `SettingsProblem`（类型） | 修改：加一个可选字段放文件里的原样写法 |

## 协作关系
- `readAgentSettings` 由设置页（`extensions/settings.ts`）、交付工具（`extensions/git-delivery.ts`）、守护进程（`daemon/lifecycle.ts`）调用；后者只用角色设定部分。
- 读写都只碰本地文件，没有外部服务。

## 验证方式
- 测试入口：`runtime/agent-settings.ts` 导出的 `readAgentSettings({ agentDir, repositoryRoot, projectTrusted })`、`saveGitDeliverySetting({ path, enabled })`、`clearGitDeliverySetting({ path })`、`userSettingsPath(agentDir)`、`projectSettingsPath(repositoryRoot)`。`readAgentSettings` 的返回值里新增字段名为 `gitDelivery`，形如 `{ enabled: boolean, source: "project" | "user" | "default" }`；问题条目新增可选字段 `value`（原样写法字符串）。
- 测试输入：在临时目录（单层 `/tmp/pi-t-XXXXXX`）里写两层设置文件。
- 预期结果：
- [ ] 两层都没写：`gitDelivery` 是 `{ enabled: false, source: "default" }`。
- [ ] 用户层 true、项目层 false、受信任：`{ enabled: false, source: "project" }`；不受信任：`{ enabled: true, source: "user" }`。
- [ ] 用户层写 `"yes"`：`gitDelivery` 是默认值；`problems` 里有一条 `display` 为"git-delivery 只能写 true 或 false"、`value` 为 `"\"yes\""`、`layer` 为 user。
- [ ] `one-company` 下有键 `foo`：问题 `display` 为"不认识的设定 foo，只能是 pm、interpreter、draft-verifier、git-delivery"。
- [ ] `saveGitDeliverySetting` 写入后，文件里原有的其他键（包括 `one-company.pm`）不变，`one-company.git-delivery` 为所写的布尔值；文件不存在时新建。
- [ ] 文件不是合法 JSON 时 `saveGitDeliverySetting` 抛错，信息含"设置文件不是合法的 JSON，没有改动"和文件路径，文件内容不变。
- [ ] `clearGitDeliverySetting` 删掉这一项；`one-company` 只剩这一项时整个 `one-company` 被去掉；这一层没有这一项时文件不被改动（修改时间不变）。
- [ ] 角色设定的现有测试全部照样通过（除"不认识的角色"文字改成新文字）。
