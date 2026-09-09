---
name: commands
description: 注册五个 /pi-company: 流程与设置入口和独立 /ps，参数透传给对应技能正文，不注册别名，加载失败不绕过
---
# 命令入口

## 目标
用户能通过统一前缀发现并调用五个流程与设置入口，用 /ps 打开 Shell 管理页，任何入口失败都如实报告。

## 业务规则（来源：spec）
- namespaced-entrypoints：提供 `/pi-company:new`、`/pi-company:resume`、`/pi-company:revise`、`/pi-company:sync`、`/pi-company:setting` 五个入口及独立 `/ps`；帮助与继续操作指引使用各自名称。
- namespaced-entrypoints：需求描述、问题描述、`--verify`、域名范围按业务语义传给对应流程，不混淆、不丢参数。
- namespaced-entrypoints：不提供其他流程别名，不注册 `/spec-new`、`/spec-resume`、`/spec-revise`、`/spec-sync`。
- namespaced-entrypoints：入口无法加载目标流程、设置页或 Shell 管理页时显示具体失败原因，不自动调用其他入口或报告成功。

## 涉及文件
- 新建 `extensions/commands.ts`
- 新建 `extensions/index.ts`（本包唯一扩展入口）
- 修改 `package.json`（`pi.extensions` 指向 `./extensions/index.ts`）
- 修改 `extensions/settings.ts`（去掉默认导出的命令注册，只导出打开函数；打开失败以抛出表达，不自吞）
- 新建 `tests/commands.test.ts`、`tests/extension-entry.test.ts`

## 成品定义
| 命令 | 参数提示 | 行为 |
|---|---|---|
| `/pi-company:new <一句话需求>` | 需求描述 | 读取 spec-flow 技能正文，以用户消息形式发送"从阶段一开始处理：<描述>" |
| `/pi-company:resume [--verify]` | 可选 `--verify` | 读取 spec-flow 技能正文，发送"执行断点续接，参数：<原样>" |
| `/pi-company:revise <问题描述>` | 问题描述 | 读取 spec-revise 技能正文，发送"处理这个问题：<描述>" |
| `/pi-company:sync [域名 ...]` | 可选域名列表 | 读取 spec-sync 技能正文，发送"执行对账，范围：<原样>" |
| `/pi-company:setting` | 无 | 打开角色设置页 |
| `/ps` | 无 | 打开 Shell 管理页 |

## 函数清单
### extensions/commands.ts
| 函数名 | 职责 |
|---|---|
| `commandsExtension` | 注册六个命令（唯一注册点；`/pi-company:setting` 在无交互终端时通知原因不打开） |
| `index.ts` 默认导出 | 本包唯一扩展入口：以固定顺序（lifecycle → decision-record → workflow → rules → dispatch → relay → agents-ui → shell-ui → commands）用同一个 `pi` 调用各子扩展工厂；pi 对每个扩展入口各起一次 jiti 导入且不共享模块实例，只有单一入口才能让 `extensions/lifecycle.ts` 等模块级共享状态在各子扩展间成立 |
| `registerCommands` | 可注入包根与打开设置页/Shell 页的回调，便于测试 |
| `loadSkillBody` | 读取指定技能文档正文（去 frontmatter），缺失或不可读时返回具体错误 |
| `sendFlowPrompt` | 把技能正文与原样参数组合为用户消息发送 |
| `openSettingOrReport` | 调用设置页打开回调，失败时通知具体原因 |
| `openShellPageOrReport` | 调用 Shell 页打开回调，失败时通知具体原因 |

## 协作关系
- 依赖 SDK 的 `stripFrontmatter`、`pi.registerCommand`、`pi.sendUserMessage`。
- 设置页由 `extensions/settings.ts` 提供打开函数（失败抛出，由本模块 notify）；Shell 页由 `extensions/shell-ui.ts` 提供；本模块只路由。
- `extensions/index.ts` 是 package.json `pi.extensions` 唯一声明的入口；各子扩展文件不再被逐个发现，其默认导出只由 index.ts 调用。技能正文经 `stripFrontmatter` 解析失败时与文件不可读同样报告含路径的原因。
- 技能文档位于 `skills/spec-flow`、`skills/spec-revise`、`skills/spec-sync`。

## 验证方式
- 测试入口：`registerCommands`（假 pi 收集 `registerCommand` 与 `sendUserMessage`，可注入失败的打开回调与临时包根）。
- 测试输入：各命令的参数字符串；缺失技能文档的包根；打开回调抛错。
- 预期结果：
  - 注册的命令名集合精确为六个，不含任何 `/spec-*`。
  - `new`、`revise` 发送的消息包含完整描述；`resume --verify` 保留 `--verify`；`sync agents` 保留域名。
  - 技能文档缺失或 frontmatter 损坏时通知具体路径与原因，未发送消息；设置页或 Shell 页打开失败时通知原因，未调用其他入口；无交互终端时 `/pi-company:setting` 通知原因且不调用打开函数。
  - 用假 pi 调用 `extensions/index.ts` 默认导出：注册的命令名无重复且恰为六个流程/设置/Shell 命令加各子扩展自身命令，各子扩展的工具/事件只注册一次；package.json `pi.extensions` 恰为 `./extensions/index.ts`。
- [ ] 命令集合与无别名
- [ ] 参数透传
- [ ] 加载失败不绕过
