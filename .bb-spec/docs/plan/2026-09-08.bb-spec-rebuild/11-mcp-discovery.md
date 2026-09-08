---
name: mcp-discovery
description: 窗口探测已安装的 MCP 适配器扩展并枚举其配置的服务；守护进程按角色勾选集合过滤后装载到角色会话，三类入口拦截集合外服务
---
# MCP 探测与按角色装载

## 目标
设置页能列出宿主实际配置的 MCP 服务作为候选；守护进程内的每个角色会话只装载其勾选且当前可用的服务，通过任何入口都访问不到集合外服务。

## 业务规则（来源：spec）
- mcp-access：每个角色的 MCP 集合来自其配置中勾选的服务，候选限于宿主当前已配置的服务；只提供已勾选且当前已配置、可用的服务，被移除或禁用的不成为启动前提也不自动替换；发现、查看说明、调用三类入口同受该集合约束；任务不依赖缺失能力可继续，确实需要的能力未勾选、缺失、认证失败或调用失败时如实报告阻塞，不虚报通过；MCP 不改变角色职责与文件访问边界；MCP 能力在守护进程内该角色的会话中装载，适配器入口与配置由派出窗口探测后随派工传入。
- mcp-selection：候选为当前窗口探测到的适配器配置中的全部服务，未探测到适配器时没有候选。

## 涉及文件
- 新建：runtime/mcp.ts
- 新建：tests/mcp-discovery.test.ts

## 函数清单

### runtime/mcp.ts
| 函数名 | 职责 |
|---|---|
| `detectMcpAdapter` | 遍历宿主当前已注册工具的来源路径，向上找到包名为 pi-mcp-adapter 的包目录，读取宿主启动参数中的配置文件路径；找不到返回"未安装"而非抛错 |
| `listMcpServers` | 读取适配器配置文件，返回服务标识、是否禁用与传输类型；配置缺失或损坏返回带原因的错误结果 |
| `filterMcpConfig` | 只保留角色勾选且未禁用的服务，并强制安全选项（延迟连接、关闭直连工具与调试输出、关闭自动认证） |
| `loadMcpForRole` | 在守护进程内用 SDK 自带的 jiti（别名分支）加载适配器入口，以过滤后的配置装载到角色会话；失败降级为空集合并返回原因供写入角色提示 |
| `checkMcpCall` | 拦截角色的 MCP 发现/查看/调用请求，目标服务不在该角色集合内即拒绝；审查与验收角色额外拒绝写文件类参数 |
| `describeMcpStatus` | 生成"已装载 X，缺失 Y，原因 Z"的状态文本供面板与角色提示使用 |

## 协作关系
- 窗口：`detectMcpAdapter` 与 `listMcpServers` 在设置页与派工时调用，结果（适配器目录、配置路径、服务清单）随 `dispatch.requirement` 传给守护进程。
- 守护进程：`loadMcpForRole` 在 role-session 的子扩展工厂中调用；`checkMcpCall` 挂在子会话的工具调用钩子。
- 勾选集合来自 `runtime/settings.ts` 的 `effectiveMcp`。
- 依赖：SDK 目录下的 jiti（经 daemon/sdk.ts 解析），不新增依赖。

## 验证方式
- 测试入口：`runtime/mcp.ts` 导出函数；装载测试用真实 SDK 会话与一个最小的假适配器包（测试夹具内的本地目录，导出与 pi-mcp-adapter 同名的入口）
- 测试输入：假适配器配置含 context7、chrome-devtools、codegraph（其中一个 disabled）；角色勾选集合
- 预期结果：
  - 工具来源中不存在适配器包时 `detectMcpAdapter` 返回未安装且不抛错；存在时返回包目录与配置路径
  - `listMcpServers` 返回三个服务并标出 disabled；配置文件损坏返回错误结果
  - worker 勾选 [context7]、acceptance 勾选 [chrome-devtools]、reviewer 未勾选：三个会话分别只能发现与调用各自集合内的工具，reviewer 没有任何 MCP，codegraph 无人可访问
  - 勾选了 disabled 的服务：不成为启动前提，任务照常启动，状态文本标明缺失
  - 通过通用入口请求集合外服务被拒绝且该服务未被调用（假适配器记录调用次数为 0）
  - reviewer 请求带写文件参数的 MCP 调用被拒绝
  - 适配器入口加载失败时会话仍创建成功，集合为空，原因出现在状态文本
- [ ] 探测与枚举
- [ ] 按角色过滤装载
- [ ] 三类入口拦截
- [ ] 缺失与失败降级
