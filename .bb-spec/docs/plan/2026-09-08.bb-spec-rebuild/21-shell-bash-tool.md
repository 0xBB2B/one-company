---
name: shell-bash-tool
description: 包装 bash 工具增加 background 与超时语义，等待模式返回真实结果，后台模式返回任务回执；窗口覆盖内置 bash 并接管手动命令
---
# 受管理 bash 工具

## 目标
完成后主会话、需求代理与角色的 bash 及用户的手动命令都经注册表执行，只有显式后台才提前返回，回执只表示已启动。

## 业务规则（来源：spec）
- managed-execution：主会话与守护进程内角色的 bash 以及手动 `!`、`!!` 都是受管理入口；省略 background 或为 false 时等待真实结果，失败不得显示为成功；background 为 true 时命令未结束即返回任务编号与状态，已启动不等于成功；手动入口不增加后台选项，保持原输入与等待行为及输出是否进入模型上下文的区别；后台可同时指定超时，按秒从启动计时；无法登记或启动返回具体失败，不改用未受管理入口。
- role-catalog / role-settings：不扩大既有命令权限，不改变工作目录与环境。

## 涉及文件
- 新建：`runtime/shell-bash.ts`
- 修改：`runtime/shell-registry.ts` — `spawn` 的 wait 模式改为 stdio pipe 并经 `onOutput` 转发，接受调用方 `env`
- 新建：`tests/shell-bash-tool.test.ts`

## 成品定义

工具参数：

```ts
import { Type } from "typebox";
export const BASH_PARAMETERS = Type.Object({
  command: Type.String({ minLength: 1, description: "要执行的命令" }),
  timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 2147483, description: "秒，从进程启动计时" })),
  background: Type.Optional(Type.Boolean({ description: "true 时立即返回任务编号，不等待结束" })),
}, { additionalProperties: false });
```

后台回执文本：`Background shell task <taskId> (<host>) is <status>.`；details 含 `{ taskId, host, status, startedAt }`。

## 函数清单
### runtime/shell-bash.ts
| 函数 | 职责 |
|---|---|
| `createManagedBashOperations` | 生成 SDK `BashOperations`（选项 `{ registry, host, runToken }`，runToken 由会话/运行身份注入而非每次生成）：`exec(command, cwd, { onData, signal, timeout, env })` 以 `sh -c <command>` 原样交给注册表 wait 模式（不包装命令串），`onOutput` 逐块转发到 `onData`；等待终态或 uncertain：exited → 退出码；stopped（无论由本次 abort 还是外部停止触发）→ 抛 aborted/stopped；abort 监听在 spawn 前注册、已 aborted 不启动、abort 后 `registry.stop` 再按 SDK 惯例抛 aborted；timed_out 抛 `Command timed out after N seconds`；uncertain 抛无法确认并提示用户裁定 |
| `createManagedBashTool` | `createBashToolDefinition(cwd, { operations })` 为基底，替换 `parameters` 为 BASH_PARAMETERS；execute 在 `background` 为 true 时走 `runBackground`，否则原样委托基底 execute（失败抛出、截断、onUpdate 流式与 fullOutputPath 全部沿用 SDK） |
| `runBackground` | 登记并启动后短暂观察，返回回执（details.host 为 { kind, id }，文本用 kind:id，startedAt 为数值或 null），不等待结束；登记失败抛出含原因的错误 |
| `handleUserBash` | 返回 `{ operations }` 交给 pi 自行驱动执行（signal、截断、cancelled、excludeFromContext 全部保持原语义）；签名只接 `{ registry, host, runToken }`，手动入口不接受 background 由事件形状结构性保证 |
| `formatBackgroundReceipt` | 生成回执文本与 details |

工具不暴露 PI_* 会话环境变量（`exposeSessionEnvironment: false`），与内置 bash 有别；工具定义显式标注 `ToolDefinition<typeof BASH_PARAMETERS, …>`，不套用基底的 execute 类型。

## 协作关系
窗口 `extensions/shell-ui.ts` 用 `createManagedBashTool` 注册同名 `bash` 覆盖内置，并注册 `user_bash` 处理器；`daemon/role-session.ts` 与 `daemon/requirement-agent.ts` 把该工具作为 customTools 传入会话；执行层依赖 `runtime/shell-registry.ts`。

## 验证方式
- 测试入口：工具定义的 `execute`（等待与后台两种参数）、`handleUserBash`
- 测试输入：延迟 1 秒成功命令、延迟失败命令、`background:true` 的持续命令、`background:true, timeout:1` 的持续命令、注册失败的注册表桩、abort 信号
- 预期结果：等待模式在结束后返回真实输出（流式经 onUpdate/onData 到达）与退出码，失败时 execute 抛出（框架只以抛出判定失败）；参数 schema 拒绝额外字段、空命令与越界超时；后台模式在 300 毫秒内返回回执且任务在注册表中 running；超时后任务 timed_out 且后代停止；注册失败返回具体错误且未启动进程；abort 后任务停止且工具抛 aborted；`handleUserBash` 不新增参数且结果进入或不进入上下文与原语义一致
- [ ] 等待模式真实结果
- [ ] 后台回执不等待
- [ ] 后台超时
- [ ] 登记失败不绕过
- [ ] 手动入口语义不变
