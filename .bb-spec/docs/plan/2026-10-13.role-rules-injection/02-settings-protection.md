---
name: settings-protection
description: 项目里的 pi 设置文件不能经受控写文件、PM 提交或验证命令改动；验证命令也改不了用户层的 pi 设置文件
---
# 设置文件受保护

## 目标
子代理改不了项目里的 pi 设置文件（仓库内 `.pi/settings.json`），验证命令也改不了用户层的 pi 设置文件（`<agentDir>/settings.json`）；用户在设定栏保存不受影响。

## 业务规则（来源：PRD settings-protection）
- 子代理用受控写文件写项目设置文件时拒绝，写明是哪个文件、为什么不能改；写入范围里列了它也一样（计划提交时，写入范围里精确写了这个文件的会被拒）。
- 验证命令写项目设置文件或用户层设置文件时写入失败，文件内容不变。
- PM 的本地提交也不能提交项目设置文件，否则这个文件会随交付进入目标分支。
- 用户在设定栏保存走的是主窗口进程，不经过这几道检查，不受影响。
- 理由：设定栏的模型设定和 pi 的扩展包设置都在这两份文件里，模型输出能改它们就违反威胁模型"模型输出不可信"。比较文件名时不区分大小写，和现有的 AGENTS.md 判定一致（文件系统可能不区分大小写）。

## 涉及文件
- 修改 `runtime/core-permissions.ts`
- 修改 `runtime/pm-commit.ts`
- 修改 `runtime/verification-run.ts`
- 修改测试：`tests/core-permissions.test.ts`、`tests/change-apply.test.ts`、`tests/verification-run.test.ts`、`tests/pm-commit.test.ts`

## 成品定义
写入路径分类新增一种（加在现有联合类型里）：
```ts
export type ManagedWritePathClass = "code" | "prod_archive" | "git_metadata" | "agent_definition" | "host_settings" | "project_conventions" | "outside";
```
验证命令禁写清单新增的三条路径（相对说明）：
```text
<本次命令的工作区根>/.pi/settings.json
<主仓库根>/.pi/settings.json
<agentDir>/settings.json
```

## 函数清单
### runtime/core-permissions.ts
| 函数名 | 职责 |
|---|---|
| `classifyManagedWritePath` | 修改：`.pi/settings.json`（逐段小写比较）归为 `host_settings` |
| `writePathAllowed` | 不改：只有 `code` 才允许，`host_settings` 自然被拒 |

### runtime/pm-commit.ts
| 函数名 | 职责 |
|---|---|
| `createPmCommitTool` 的 execute | 修改：`host_settings` 和现有禁止的几类一样报 forbidden_path |

### runtime/verification-run.ts
| 函数名 | 职责 |
|---|---|
| `launchFor` | 修改：protectedPaths 加上成品定义里的三条路径（工作区根与主仓库根各一条 `.pi/settings.json`，加 agentDir 下的 `settings.json`） |

## 协作关系
- 受控写文件：`change-apply.ts` 调 `writePathAllowed` → 拒绝时报 `forbidden_path`（现有原因文字已写明不能写）。
- 计划提交：`plan-manage.ts` 已用 `writePathAllowed` 拒绝不可写的写入范围，无需改。
- 验证命令：`launchFor` → `writeGuardLaunch` 的 deniedWrites（现有的链接真实路径解析 `resolvedTarget` 同样作用于新增路径）。

## 验证方式
- 测试入口：`classifyManagedWritePath`、`writePathAllowed`；受控写文件工具（tests/change-apply.test.ts 的入口）；PM 提交工具；验证命令（tests/verification-run.test.ts 在 macOS 沙箱里实际跑命令的入口）。
- 测试输入：路径 `.pi/settings.json`、`.PI/Settings.json`、`.pi/other.json`；往项目设置文件和 `<agentDir>/settings.json` 追加一行的 shell 命令。
- 预期结果：
  - [ ] `.pi/settings.json` 与大小写变体归为 `host_settings`，`writePathAllowed` 为 false；`.pi/other.json` 仍是 `code`
  - [ ] 受控写文件写项目设置文件报 forbidden_path，文件不变
  - [ ] PM 提交的 paths 含项目设置文件时报 forbidden_path，没有执行提交
  - [ ] 验证命令写项目设置文件、写用户层设置文件都失败，两个文件内容不变；写工作区里的普通文件仍然成功
