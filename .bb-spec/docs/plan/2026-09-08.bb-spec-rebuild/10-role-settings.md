---
name: role-settings
description: 按角色目录解析模型、思考等级与 MCP 服务集合：项目覆盖全局、MCP 整体覆盖且默认为空、失效项保留、启动时冻结、无效显式配置报错、原子保存
---
# 角色配置解析与保存

## 目标
任一角色（含需求代理）在任务启动时得到确定的模型、思考等级与 MCP 集合；配置来自全局与项目两个范围并可安全保存。

## 业务规则（来源：spec）
- role-settings：角色目录中每个角色各有模型、思考等级与 MCP 集合三项配置；项目显式值优先于全局；未显式指定模型或沿用主会话时用启动时的主会话模型；未显式配置思考时沿用主会话当前等级，不固定任何角色等级，可用等级受有效模型支持范围约束；MCP 两个范围都未保存为空，项目保存过即整体覆盖全局不取并集，已勾选服务被移除或禁用时保留配置、启动只提供当前可用子集；保存只影响后续启动任务；显式模型不可用或显式思考不受支持必须报错，不悄悄替换。
- settings-page：保存只在持久化成功后提示成功，失败显示原因且不破坏原配置。

## 涉及文件
- 新建：runtime/settings.ts
- 新建：tests/role-settings.test.ts

## 成品定义

设置文件形状（全局 `~/.pi/agent/settings.json`，项目 `<仓库>/.pi/settings.json`，仅项目受信任时读写项目层）：

```json
{
  "piCompany": {
    "roles": {
      "pi-company.worker": {
        "model": "anthropic/claude-sonnet-5",
        "thinking": "high",
        "mcp": ["context7", "chrome-devtools"]
      },
      "pi-company.requirement-agent": {
        "model": "inherit"
      }
    }
  }
}
```

字段规则：`model` 为 `provider/modelId` 或 `inherit`，缺省等同 `inherit`；`thinking` 为 off、minimal、low、medium、high、xhigh、max 之一，缺省表示沿用主会话；`mcp` 为服务标识数组，缺省表示该范围未保存；对象只允许这三个键；角色键为 `pi-company.<角色名>`，角色名须在角色目录中。其他顶层键原样保留。

## 函数清单

### runtime/settings.ts
| 函数名 | 职责 |
|---|---|
| `settingsPaths` | 返回全局与项目设置文件路径，项目不受信任时项目路径为空 |
| `loadRoleSettings` | 读取两层文件的 piCompany.roles 并逐项校验形状，非法条目抛出带角色名与原因的错误 |
| `resolveRoleSettings` | 合并两层并按主会话模型、主会话思考等级、模型能力与当前可用 MCP 集合解析出有效配置；显式模型不存在或显式思考不受支持抛错 |
| `effectiveMcp` | 项目保存过则取项目列表否则全局，再与当前可用服务求交，返回可用子集与不可用项 |
| `saveRoleSettings` | 在锁内读取目标层、写前 CAS 比对原文、原子写入更新后的文件，保留其他键；符号链接或非普通文件拒绝 |
| `clearRoleField` | 删除某角色某字段（回到沿用/未保存） |
| `thinkingCandidatesFor` | 返回某模型支持的思考等级 |

## 协作关系
- 模型列表、当前模型、当前思考等级与模型能力由调用方（窗口用 pi 的模型注册表，守护进程用 SDK 模型运行时）作为上下文对象传入，本模块不直接依赖 SDK。
- 角色名合法性经 `runtime/roles.ts` 的目录校验；当前可用 MCP 集合来自 `runtime/mcp.ts`。
- 守护进程在创建会话前调用 `resolveRoleSettings` 并把结果冻结到运行记录。

## 验证方式
- 测试入口：`runtime/settings.ts` 导出函数
- 测试输入：隔离 HOME 下的全局与项目设置文件；假模型上下文（可用模型甲/乙、支持等级映射）；可用 MCP 集合
- 预期结果：
  - 全局 worker 为模型甲 + high，项目只设模型乙：解析得模型乙 + high；另一项目得模型甲 + high；其他角色不受影响
  - 四角色均未显式配置：主会话 high 时四者均 high，改为 medium 后新解析均 medium；模型为主会话模型
  - 全局 mcp 为 [context7, chrome-devtools]、项目为 [codegraph]：解析得 [codegraph]；可用集合不含 codegraph 时得空集合且原配置未变；两层都未保存得空集合
  - 显式模型不存在或显式 xhigh 超出模型能力：抛出含角色名与原因的错误，不返回替代值
  - 保存后文件保留其他顶层键；保存期间文件被外部修改则 CAS 失败并提示重新打开；目标是符号链接时拒绝；写入失败时原文件不变
  - 项目不受信任时项目路径为空，保存到项目范围被拒绝
- [ ] 逐项覆盖与继承
- [ ] MCP 整体覆盖、默认空与失效保留
- [ ] 无效显式配置报错
- [ ] 原子保存与 CAS
