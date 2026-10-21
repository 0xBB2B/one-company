---
name: catalog-dispatch-gating
description: 守护进程读关闭名单：关闭的定义不进 PM 的可用定义清单和原型设计师清单，派工时拦下并给出建议
---
# 可用定义清单与派工拦截

## 目标
关闭的定义 PM 查不到、派不出；派工被拦时原因和建议说清楚怎么办。

## 业务规则（来源：PRD definitions-and-switches C-11）
- 关闭的定义不出现在 PM 查到的可用定义清单里。
- 派 worker 时它指定的定义已被关闭：派工被拒，原因「<名字> 已关闭」，建议「改用开着的定义，或不指定（用通用 <职责>）后重新派；用户点名要这个定义时先问用户」，<职责> 是被拒定义的职责（用户 2026-10-21 决定，在 10 号修订时一并改）。
- 关闭判断：用户层列表，或受信任项目的项目层列表里有这个名字；通用定义永远不算关闭（由 `readDisabledAgents` + `disabledAgentNames` 给出）。守护进程每次查清单、每次派工都按设置文件当时的内容判断，不缓存。
- 原型设计师清单（主窗口派原型时列出的候选）同样不列关闭的定义，派出被关闭的原型设计师同样被拒。
- 专项审查被关闭时不在这里拒绝：由"派出整轮审查"计划跳过并记录（本计划提供可区分的错误码）。

## 涉及文件
- 修改 `src/app/daemon/run-manager.ts`
- 修改 `src/app/daemon/lifecycle.ts`
- 修改 `src/core/host/protocol.ts`（协议错误码清单若在此登记，见 run-manager.ts:1496 附近实际位置）
- 修改 `tests/helpers/run-manager-fixture.ts`（`createPmRunWorld` 支持传入关闭名单）
- 修改 `tests/agent-selection.test.ts`

## 函数清单
### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `RunManagerOptions`（改） | 新增 `loadDisabledAgents`：返回当前生效的关闭名单 |
| `agentCatalog`（改，:876 附近） | 过滤掉关闭名单里的定义，分页和返回结构不变 |
| `prototypeDesigners`（改，:869 附近） | 过滤掉关闭的定义 |
| 私有 `resolveAgent`（改，:886 附近） | 解析前先查关闭名单：名字被关闭时抛协议错误 `agent_disabled`，消息「<名字> 已关闭」 |
| `PROTOCOL_NEXT`（改，:225-244） | 新增 `agent_disabled` 的建议文字：「改用开着的定义，或不指定（用通用 worker）后重新派；用户点名要这个定义时先问用户」 |
| 协议错误码清单（改，:1496 附近） | 登记 `agent_disabled` |

### src/app/daemon/lifecycle.ts
| 函数名 | 职责 |
|---|---|
| 构造 RunManager 处（改，:504-513 附近） | 传入 `loadDisabledAgents`：调用 `readDisabledAgents({ agentDir, repositoryRoot, projectTrusted })` 再经 `disabledAgentNames` 得到名单；受信任判断沿用同处 `ProjectTrustStore` 的写法 |

### tests/helpers/run-manager-fixture.ts
| 函数名 | 职责 |
|---|---|
| `createPmRunWorld`（改） | 新增可选项 `loadDisabledAgents`，默认返回空名单 |

## 协作关系
依赖"定义开关的存储与解析"计划的 `readDisabledAgents`、`disabledAgentNames`。PM 工具 `one_company_agent_manage action=catalog` 经 `agentCatalog` 返回清单；派 worker、qa、原型都经私有 `resolveAgent`。"计划字段与校验"计划会复用关闭名单在计划提交时拦截。

## 验证方式
- 测试入口：`tests/agent-selection.test.ts` 的 `world()`（`define(name, extra, body)` 写用户层定义，`w.manager.agentCatalog(role, cursor)`、`w.manager.dispatchTask(...)`）；`createPmRunWorld` 的 `loadDisabledAgents` 选项
- 预期结果：
  - 用户层定义 py-worker、名单含 py-worker → `agentCatalog("worker", 0)` 的 items 里没有它，total 相应减少；名单清空后重新出现（同一个 manager，不重启）
  - 计划里任务指定 agent 为 py-worker、确认后把它关掉，派这个任务 → 被拒，错误码 `agent_disabled`，消息含「py-worker 已关闭」，建议是上面的原文；没有创建运行记录
  - 名单里写了 worker（通用）→ 不影响派通用 worker
  - 原型设计师清单不含被关闭的原型定义
- [ ] 现有 agent-selection、pm-settings 的 catalog 用例不回归
