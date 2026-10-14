---
name: settings-resolution
description: PM 与两个内部代理改按设定取模型和思考等级；删掉它们的定义文件，留着的旧文件列进问题栏
---
# 按设定取 PM 与内部代理的模型

## 目标
启动 PM、调用解释器和草稿核验器时，按设定（项目层 > 用户层 > 内置默认值）取模型和思考等级；PM、解释器、草稿核验器不再有定义文件，用户层或项目层留着的旧文件不生效，问题栏写明原因。

## 业务规则（来源：PRD settings-tab、settings-recovery）
- PM：设定的模型为 null（跟随主会话，内置默认就是 null）时用派出 PM 那一刻主窗口的模型，否则按模型写法在本机找；思考等级为 null 时用派出时主窗口的思考等级，否则用设定值。模型找不到、没有凭据、思考等级不受这个模型支持时直接报错并写明原因，不换别的模型（沿用现在 `resolveAgent` 的报错文字和错误码）。
- PM 的提示词只由程序给：正文为空，职责规矩是 role-rules/pm.md；PM 不再有 mcp 和 skills（原来可以写在 pm.md 里，用户已决定 PM 不可编辑）。PM 运行记录不再带定义指纹，暂停期间改设定不会停掉 PM，也不影响正在运行的 PM。
- 解释器、草稿核验器：设定的模型为 null 时用主窗口当前的模型；思考等级为 null 时用主窗口当前的思考等级（经 `pi.getThinkingLevel()` 取，由 extensions/requirement-manage.ts 构造 `MainRequirementInteraction` 时传入取值函数）；最终等级为 off 时不思考（沿用现在的处理）。模型不可用时的报错原因写明是哪个角色、哪个模型、为什么（沿用现在 `internal_model_unavailable` 的写法）。
- 每次启动 PM、每次调用内部代理都重新读设定，所以改完下次就生效。
- 定义文件只认 worker、reviewer、qa、explore 四种职责。头部 role 写成 pm、interpreter、draft-verifier 的文件不生效，问题栏写一条，原因是"已不再使用定义文件，请在设定栏修改"；它们也不再顶掉任何定义。
- 删除包内 `agents/pm.md`、`agents/interpreter.md`、`agents/draft-verifier.md`。不做兼容：同名覆盖、内部定义加载的代码一并删除。
- /one:agents 去掉 pm 分类栏（pm 定义文件删掉后这一栏就空了，从计划 07 挪到这里做，避免中间状态留一个空栏）：左边只剩 worker、reviewer、qa、explore，打开页面默认停在 worker 栏，右上角计数只算这四种职责的定义。界面以用户确认的预览为准。
- 仓库根 AGENTS.md「测试」一节里"PM 与主代理的提示词（`agents/pm.md`、`rules/*.md`）"改为 `role-rules/pm.md`，因为 pm.md 被删、PM 规矩已在 role-rules 下。

## 涉及文件
- 删除 `agents/pm.md`、`agents/interpreter.md`、`agents/draft-verifier.md`
- 修改 `runtime/roles.ts`、`runtime/agent-resolve.ts`、`runtime/internal-model.ts`
- 修改 `daemon/run-manager.ts`、`daemon/lifecycle.ts`、`daemon/agent-session.ts`
- 修改 `runtime/main-requirement-interaction.ts`、`extensions/requirement-manage.ts`（传入主窗口思考等级）
- 修改 `runtime/agent-copy.ts`（删内部定义的同名复制分支，保证编译）
- 修改 `runtime/agent-catalog-ui.ts`（`ROLE_TABS` 去掉 pm；右上角计数只算四种职责）
- 修改 `AGENTS.md`（上面那一处路径）
- 修改测试：`tests/role-catalog.test.ts`、`tests/internal-model.test.ts`、`tests/agent-selection.test.ts`、`tests/model-ref.test.ts`、`tests/main-requirement-interaction.test.ts`、`tests/question-window.test.ts`、`tests/prototype.test.ts` 里依赖这三份定义文件的部分

## 成品定义
问题栏里旧定义文件那一条的原因：
```text
已不再使用定义文件，请在设定栏修改
```
程序内置的 PM 定义（不再来自文件）：
```ts
export const PM_DEFINITION = { name: "pm", description: "活动需求的唯一负责人，通过接手复核后负责 plan/task 拆分、依赖、覆盖映射与增量调度", role: "pm", body: "" } as const;
```

## 函数清单
### runtime/roles.ts
| 函数名 | 职责 |
|---|---|
| `DEFINITION_ROLES` | 新增：定义文件可写的四种职责；删除 `INTERNAL_ROLES`、`InternalRole`、`DefinitionRole` 里的内部职责 |
| `readRoleDefinition` | 修改：role 只认四种；删掉"pm 只能叫 pm""内部定义不接受 mcp、skills"等分支 |
| `loadLayerEntries` | 修改：头部 role 是 pm、interpreter、draft-verifier 的文件记为新的问题类型 retired（原因见成品），不进入目录 |
| `sameNameOnly` | 修改：只剩 pm 时恒为否，06 连同调用方一起删掉 |

### runtime/agent-resolve.ts
| 函数名 | 职责 |
|---|---|
| `resolveModelChoice` | 新增：由"模型写法或 null + 思考等级 + 主窗口模型"解析出模型并核验凭据和思考等级；`resolveAgent` 里同样的那段改为调用它 |

### runtime/internal-model.ts
| 函数名 | 职责 |
|---|---|
| `resolveInternalModel` | 修改：改读 `readAgentSettings` 里对应角色的生效值，不再读角色目录；入参不变 |

### daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `dispatchPmExclusive` | 修改：读设定里 PM 的生效值 → `resolveModelChoice`（fallback 为本次派出带来的主窗口模型）；会话用 `PM_DEFINITION`；运行记录不带 agent 指纹，mcp 为空 |
| 构造选项 | 新增 `loadAgentSettings`：每次派出 PM 时调用，返回 `readAgentSettings` 的结果 |

### daemon/lifecycle.ts
| 函数名 | 职责 |
|---|---|
| RunManager 装配处 | 修改：传入 `loadAgentSettings`，项目是否受信任用现有 `ProjectTrustStore` 判断 |

### daemon/agent-session.ts
| 函数名 | 职责 |
|---|---|
| `createAgentRoleSession` | 修改：删掉"内部定义不能开会话"的检查（内部职责已不存在） |

### runtime/agent-copy.ts
| 函数名 | 职责 |
|---|---|
| `copyAgentDefinition` | 修改：删掉内部定义相关分支 |

### runtime/main-requirement-interaction.ts、extensions/requirement-manage.ts
| 函数名 | 职责 |
|---|---|
| `MainRequirementInteraction` 构造选项 | 新增取主窗口思考等级的函数 |
| `#internalModel` | 修改：把主窗口思考等级交给 `resolveInternalModel` |

### runtime/roles.ts（问题栏）
| 函数名 | 职责 |
|---|---|
| `RoleCatalogProblem` | 新增 retired 类型；/one:agents 问题栏显示原因与文件 |

## 协作关系
- `dispatchPmExclusive` → `loadAgentSettings` → `readAgentSettings`（03）→ `resolveModelChoice` → `createAgentRoleSession`（职责规矩由 01 注入）。
- `MainRequirementInteraction.#internalModel` → `resolveInternalModel` → `readAgentSettings`。

## 验证方式
- 测试入口：`RunManager.dispatchPm`（现有派工测试的假模型运行时）；`resolveInternalModel`；`loadRoleCatalog`；`/one:agents` 页面（问题栏）。测试目录用单层 `/tmp/pi-t-XXXXXX`。
- 测试输入：两层都没有设定；用户层设 PM 为 A、项目层设为 B，项目受信任与不受信任；PM 设为 null；解释器设定的模型没有凭据；用户层角色目录里放一份 role 为 pm、model 为 C 的旧文件。
- 预期结果：
  - [ ] 没有设定时，PM 用派出时主窗口的模型和思考等级；解释器、草稿核验器用主窗口当前的模型和思考等级
  - [ ] 项目受信任时 PM 用 B；不受信任时用 A
  - [ ] PM 的思考设为 null、模型设为 A 时，用 A 和派出时主窗口的思考等级；主窗口思考等级为 off 时内部代理不思考
  - [ ] PM 运行期间改设定，这个 PM 的模型不变；下次派出用新值
  - [ ] 解释器模型没有凭据时报错，原因含"解释器"和模型名，不换模型
  - [ ] 旧的 pm 定义文件不生效：问题栏有"已不再使用定义文件，请在设定栏修改"，PM 用的不是 C
  - [ ] 包里不再有 agents/pm.md、interpreter.md、draft-verifier.md；PM 提示词仍含 pm 职责规矩
  - [ ] 写 role: pm 的新定义文件进不了 PM 的定义目录查询结果
