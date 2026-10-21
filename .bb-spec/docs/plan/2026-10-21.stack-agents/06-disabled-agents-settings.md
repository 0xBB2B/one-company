---
name: disabled-agents-settings
description: 设置文件 one-company 下新增 disabled-agents 的解析、读写、生效判断和「问题」提示
---
# 定义开关的存储与解析

## 目标
设置文件能存"哪些定义被关了"，程序能读出每层的列表、算出一个定义当前开没开、写回关闭或开启，并把写错的地方列进「问题」。

## 业务规则（来源：PRD definitions-and-switches）
- 开关存在设置文件 one-company 字段下的 `"disabled-agents"`：被关闭的定义名列表，只记关闭的。用户层 `~/.pi/agent/settings.json`，项目层 `.pi/settings.json`。
- 生效：名字出现在用户层列表里，或出现在受信任项目的项目层列表里，就是关闭；都没有就是开启。项目未受信任时项目层列表不生效。通用定义（worker、reviewer、qa、explore、prototype）永远不算关闭。
- 写回：关闭 = 把名字加进指定层的列表；开启 = 从指定层列表删掉；列表空了就删掉 `"disabled-agents"` 键；文件其他内容保持原样（沿用现有 `saveOneCompanyKey` / `clearOneCompanyKey` 的写法）。
- 写错的处理（这一层这一项不生效，列进「问题」）：
  - 不是字符串列表 → 「disabled-agents 只能写定义名列表」，带原样写法；
  - 列表里有通用定义名 → 「<名字> 是通用定义，不能关闭」，忽略这个名字；
  - 列表里有不存在的定义名 → 「没有叫 <名字> 的角色定义」，忽略这个名字。
- 「不认识的设定 <键>，只能是 …」提示里的允许键清单加上 disabled-agents。
- 守护进程判断开关时只读这一项，不触发 Git 交付档位的自动探测（`detectDeliveryMode`）。

## 涉及文件
- 修改 `src/modules/settings/agent-settings.ts`
- 修改 `tests/agent-settings.test.ts`

## 函数清单
### src/modules/settings/agent-settings.ts
| 函数名 | 职责 |
|---|---|
| `parseSettingsLayer`（改） | :72 的允许键加 `disabled-agents`；:86 之前加分支：是字符串数组就记为本层列表，否则记一条「disabled-agents 只能写定义名列表」问题 |
| `readLayers`（改） | 项目未受信任时的空项目层也带空的关闭列表 |
| `readAgentSettings`（改） | 返回值新增 `disabledAgents: { user, project }`：两层各自原样的列表（未受信任时项目层为空） |
| `readDisabledAgents` | 轻量读取：只解析两层的 `disabled-agents`，返回同样的 `{ user, project }`，不做 Git 交付探测，供守护进程用 |
| `disabledAgentNames` | 由 `{ user, project }` 算出生效的关闭名单（两层并集，去掉通用定义名） |
| `agentSwitchOf` | 给一个定义名和 `{ user, project }`，返回：是否通用、是否开启、关闭时来自哪一层（用户层优先报） |
| `disabledAgentProblems` | 给 `{ user, project }`、两层设置文件路径和角色目录，返回通用名、不存在的名字两类问题（`SettingsProblem`，key 为 `disabled-agents`，value 为名字） |
| `saveDisabledAgentsSetting` | 把某层的关闭列表整体写入（复用 `saveOneCompanyKey`）；空列表时改为删键（复用 `clearOneCompanyKey`） |

## 协作关系
- `isGenericDefinition`（`src/modules/agents/roles.ts`，"内置专项定义"计划新增）判断通用名。
- 设置页（下一份计划）用 `readAgentSettings().disabledAgents`、`agentSwitchOf`、`disabledAgentProblems`、`saveDisabledAgentsSetting`。
- 守护进程（"目录与派工拦截"计划）用 `readDisabledAgents` + `disabledAgentNames`。

## 验证方式
- 测试入口：`tests/agent-settings.test.ts` 的 `world()`（`write(path, content)`、`read(trusted)`）调用 `readAgentSettings`；另直接调用 `readDisabledAgents`、`disabledAgentNames`、`agentSwitchOf`、`disabledAgentProblems`、`saveDisabledAgentsSetting`
- 测试输入与预期：
  - 用户层写 `{"one-company":{"disabled-agents":["go-worker"]}}` → `disabledAgents.user` 为 `["go-worker"]`，`disabledAgentNames` 含 go-worker，`agentSwitchOf("go-worker")` 为关闭、来自用户层
  - 只在项目层写 `["go-worker"]`：受信任时关闭、来自项目层；未受信任时开启，`disabledAgents.project` 为空
  - 写 `"disabled-agents": "go-worker"` → problems 里有「disabled-agents 只能写定义名列表」，value 为 `"go-worker"`（JSON 原样），这一层列表为空
  - 写 `["reviewer", "nope"]`，目录里没有 nope → `disabledAgentProblems` 返回「reviewer 是通用定义，不能关闭」「没有叫 nope 的角色定义」两条；`disabledAgentNames` 不含 reviewer；`agentSwitchOf("reviewer")` 为通用
  - one-company 下多写键 `foo` → 「不认识的设定」提示列出的允许键里含 disabled-agents
  - `saveDisabledAgentsSetting(用户层, ["go-worker"])` → 文件里 one-company 下其他键保留；再写空列表 → `disabled-agents` 键被删
  - `readDisabledAgents` 在两层都没写 git-delivery 时不调用 gh / git（沿用测试里 `installFakeGh` 的调用记录断言没有调用）
- [ ] 上述用例全部通过；现有 agent-settings 用例不回归
