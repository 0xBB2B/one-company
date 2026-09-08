---
name: namespaced-entrypoints
description: 五个流程与设置入口使用 /pi-spec: 命名空间，独立 /ps 管理 Shell，不提供其他流程别名
---
# 命令命名空间

## 目的
让用户通过统一前缀发现需求流程与角色设置，并通过独立的 /ps 管理当前会话 Shell。

## 逻辑
本包提供 /pi-spec:new、/pi-spec:resume、/pi-spec:revise、/pi-spec:sync 与 /pi-spec:setting 五个流程与设置入口，另提供独立 Shell 管理入口 /ps。
new 接收需求描述并进入新需求流程，resume 续接已有需求并支持 --verify，revise 接收问题描述并进入修订流程，sync 接收可选域名范围并进入对账流程，setting 打开角色设置页面。
命令参数保留各自的业务语义；名称统一不改变流程阶段、验收门禁或配置页面功能。
/ps 打开当前主会话及其子运行的 Shell 管理列表，不映射成流程或设置别名。
命令候选、帮助说明和流程内的继续操作指引使用统一入口，不提供其他流程别名。
入口无法加载目标流程、设置页面或 Shell 管理页时明确报告失败，不自动转到其他入口或误报调用成功。

## 约束
- C-1：当用户发现或调用本包命令时，系统应提供 /pi-spec:new、/pi-spec:resume、/pi-spec:revise、/pi-spec:sync、/pi-spec:setting 五个流程与设置入口及独立 Shell 管理入口 /ps，并在帮助和后续操作指引中使用各自名称。
- C-2：当用户调用四个流程入口时，系统应将需求描述、问题描述、--verify 或域名范围传给对应流程，保持其业务语义，不混淆流程目标或丢失参数。
- C-3：当本包注册命令时，系统应不提供上述五个入口之外的流程别名，不注册 /spec-new、/spec-resume、/spec-revise 或 /spec-sync。
- C-4：如果入口无法加载目标流程、角色设置页面或 Shell 管理页，系统应显示具体失败原因，不自动调用其他入口或报告调用成功。

## 例子
用户执行 /pi-spec:resume --verify，系统进入断点续接并仅对已完成任务重跑验证；执行 /pi-spec:sync agents 时，对账范围仅为指定功能域。五个流程与设置入口均以 /pi-spec: 开头，/ps 只打开 Shell 管理页。

## 验收
### AC-1 流程设置与 Shell 入口均可发现  ← C-1
- 触发: 操作 加载本包后打开命令候选，并查看帮助和流程中的继续操作指引
- Given: 本包已加载，宿主支持交互命令
- When: 检索本包命令
- Then: 五个流程与设置入口为 /pi-spec:new、/pi-spec:resume、/pi-spec:revise、/pi-spec:sync、/pi-spec:setting，另有独立 /ps 打开 Shell 管理页；帮助和继续操作指引使用对应名称

### AC-2 流程路由与参数保持语义  ← C-2
- 触发: 操作 分别执行 /pi-spec:new 增加订单导出、/pi-spec:revise 导出内容缺失、/pi-spec:resume --verify 和 /pi-spec:sync agents
- Given: 对应流程所需环境已准备，续接场景中存在已完成任务，对账场景中存在指定功能域
- When: 各入口处理命令
- Then: 新需求与修订流程分别收到完整描述，续接对已完成任务重跑验证，对账仅处理指定功能域，没有路由到其他流程或丢失参数

### AC-3 不注册其他流程别名  ← C-3
- 触发: 操作 在本包加载后的注册命令列表中检索 /spec-new、/spec-resume、/spec-revise 与 /spec-sync
- Given: 本包命令注册已完成
- When: 查看检索结果
- Then: 四个名称均没有注册为本包命令，也没有映射到 /pi-spec: 入口的别名

### AC-4 入口加载失败不被绕过  ← C-4
- 触发: 操作 在目标流程、设置页面或 Shell 管理页无法加载的环境调用对应 /pi-spec: 命令或 /ps
- Given: 其他入口仍可加载，但用户没有请求它们
- When: 入口处理调用
- Then: 显示目标入口的具体失败原因，没有调用其他入口或报告调用成功
