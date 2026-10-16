---
name: git-delivery-tool
description: 交付工具改按设置文件判断开关，删除 /one:git-delivery 和全局数据库开关
---
# 交付工具按设置文件开关

## 目标
交付工具是否出现、能否调用，都按 pi 设置文件里 `one-company.git-delivery` 的生效值决定；删掉 `/one:git-delivery` 命令和全局数据库里的开关读写。

## 业务规则（来源：PRD git-delivery-switch）
- 生效值：项目层（项目受信任时）> 用户层 > 内置默认值关闭。项目层的仓库根按设置页现有做法取：`git rev-parse --show-toplevel`，失败就用当前目录。用户层目录是 `dataRoot(process.env)` 的上一级。
- 每个窗口在 `session_start` 时按生效值决定工具列表里有没有交付工具（开启就加上，关闭就去掉，其他工具不动）。
- 设置页保存或清除开关后，当前窗口立刻按新的生效值更新工具列表（由设置页调本计划导出的函数）。
- 每次调用交付工具都重新读一次生效值；关闭时拒绝，原因"Git 交付已关闭"，建议"请用户在 /one:setting 的开关里开启 Git 交付后再交付"。
- 不再注册 `/one:git-delivery`；`runtime/git-delivery.ts` 里读写全局数据库开关的两个函数和对应常量删掉，旧数据库记录不读、不迁移。
- 交付流程本身（参数检查、需求状态核对、`deliverRequirement`）不变。

## 涉及文件
- 修改 `extensions/git-delivery.ts`
- 修改 `runtime/git-delivery.ts`（删开关读写）
- 修改 `extensions/settings.ts`（把 `resolveRepoRoot` 导出，供本计划复用；不改其他逻辑）
- 修改 `tests/git-delivery-extension.test.ts`、`tests/git-delivery.test.ts`（删掉数据库开关用例）

## 函数清单
### extensions/git-delivery.ts
| 函数名 | 职责 |
|---|---|
| `gitDeliveryOn` | 新增：按当前目录和项目受信任状态读设置文件，返回开关生效值 |
| `showGitDeliveryTool` | 新增并导出：按传入的开关值把交付工具加进或移出工具列表（取代原 `showTool`） |
| `registerGitDelivery` | 修改：去掉命令注册；`session_start` 和 `execute` 改用 `gitDeliveryOn`；依赖里不再需要 `dataRoot` 做开关判断 |
### runtime/git-delivery.ts
| `gitDeliveryEnabled` / `setGitDeliveryEnabled` | 删除 |
### extensions/settings.ts
| `resolveRepoRoot` | 改为导出 |

## 协作关系
`gitDeliveryOn` → `readAgentSettings`（runtime/agent-settings.ts，含 `gitDelivery` 字段）+ `resolveRepoRoot`。`showGitDeliveryTool` 由本文件的 `session_start` 和设置页（settings-command 计划）调用。

## 验证方式
- 测试入口：`extensions/git-delivery.ts` 导出的 `registerGitDelivery(pi, deps)`、`showGitDeliveryTool(pi, enabled)`、`GIT_DELIVER_TOOL`；用假的 `pi`（`registerTool`、`registerCommand`、`on`、`getActiveTools`、`setActiveTools`）；`session_start` 处理器和工具 `execute` 收到的 ctx 带 `cwd`（临时仓库目录）、`isProjectTrusted()`、`hasUI`、`ui`。设置文件用环境变量 `PI_CODING_AGENT_DIR` 指向临时目录下的用户层。
- 测试输入：两层设置文件里 git-delivery 的不同取值；全局数据库里不放任何东西或放旧记录都一样。
- 预期结果：
- [ ] 没写或写 false 时，`session_start` 后工具列表里没有交付工具，其他工具保留；写 true 时有。
- [ ] 项目层 true、用户层没写、项目不受信任：没有交付工具。
- [ ] `showGitDeliveryTool(pi, true)` 后有、`(pi, false)` 后没有，其他工具顺序不变。
- [ ] `session_start` 时开启，之后把用户设置文件改成 false 再调用：拒绝，报错含"原因：Git 交付已关闭"和"建议：请用户在 /one:setting 的开关里开启 Git 交付后再交付"。
- [ ] 开启时，参数多字段、需求未以完成关闭的两条原有拒绝用例照样成立。
- [ ] 注册的命令里没有 `one:git-delivery`。
- [ ] `runtime/git-delivery.ts` 不再导出 `gitDeliveryEnabled`、`setGitDeliveryEnabled`；`deliverRequirement` 的现有测试全部通过。
