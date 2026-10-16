---
name: move-into-src
description: 所有源文件按功能搬进 src/core、src/modules、src/app，删除三个旧目录，包照常安装运行
date: 2026-10-16
---

# 按模块搬进 src/

模块：`src/core/<名>/` 或 `src/modules/<名>/` 下的一个目录，放同一个功能的全部源文件。组装层：`src/app/extension/`（pi 加载的入口、命令注册、主会话规则）和 `src/app/daemon/`（守护进程的启动和组装代码），本身没有业务逻辑。

## 用户故事
### P0：作为维护这个仓库的开发者，我想要一个功能的代码只在一个目录里，以便改功能时不用在 150 多个平铺文件里翻
**用例（主路径）**
- 场景：开发者要改 Git 交付。
- 操作：打开 `src/modules/delivery/`。
- 预期：Git 交付的主窗口注册代码、交付逻辑、关闭需求、工作区管理都在这个目录里；仓库根上没有 `runtime/`、`extensions/`、`daemon/`。

**用例（边界：装好的包）**
- 场景：用户用 `pi install` 装上搬家后的包。
- 操作：打开 pi，输入 `/one:setting`、`/one:ps`，提一个需求让主代理派 PM。
- 预期：和搬家前一样能用；守护进程能启动；角色定义、规则、技能、语法解析资源都能找到。

**用例（边界：查历史）**
- 场景：开发者想知道 `requirement-state.ts` 里某个函数为什么这样写。
- 操作：在新路径上执行 `git log -L :<函数名>:src/modules/requirement/requirement-state.ts`。
- 预期：能列出搬家之前改过这个函数的提交。

## 约束
- C-1：源文件按下表放置，每个模块放的内容如下（从下层到上层）：
  | 目录 | 放什么 |
  |---|---|
  | `src/core/policy` | 内容和权限规则、时钟、文字清洗 |
  | `src/core/exec` | 外部命令的报错格式、读 git、目标分支、git 快照、分支保护、安装前检查 git |
  | `src/core/storage` | 本机数据库、数据目录、本机身份、操作日志 |
  | `src/core/host` | 主窗口生命周期、守护进程客户端和通信格式、守护进程的通信服务端、程序窗口、底部面板、后台 shell 登记表、网络暂停 |
  | `src/modules/agents` | 角色定义与复制、模型引用、职责规矩、MCP、检索排除、子代理会话、会话和运行记录 |
  | `src/modules/requirement` | 需求草稿、批准清单、状态、事件、备份恢复、需求文档、短决定、prod 存储、主窗口授权、原型记录 |
  | `src/modules/prototype` | 派原型设计师、原型确认窗口 |
  | `src/modules/verification` | 检查轮、改动应用、写入保护、命令边界、项目规范 |
  | `src/modules/explore` | explore 检索的约定、派发、会话，联网，agent_manage 工具 |
  | `src/modules/settings` | 设置页、模型设定、内部代理的模型 |
  | `src/modules/pm` | 计划、派工、提交、同步、PM 收件、需求读取工具、核验、子代理结果提交、子代理工具 |
  | `src/modules/delivery` | 关闭需求、需求流程管理、Git 交付、工作区管理 |
  | `src/modules/panel` | 状态面板、PM 概览、决定卡片、裁决 |
  | `src/modules/interaction` | 主代理提问、用户回答的整理、主窗口的需求交互、@需求补全、requirement_manage 工具 |
  | `src/modules/project-index` | 项目索引、语法解析、知识查询、项目维护、project_manage 工具 |
  | `src/modules/shell` | `/one:ps` 页面、后台 shell 工具、shell 摘要 |
  | `src/app/extension` | pi 入口、命令注册、主会话规则 |
  | `src/app/daemon` | 守护进程的启动、加载器、生命周期、运行管理、PM 工具注册、启动配置 |
- C-2：`src/` 下每个 `.ts`、`.mjs` 源文件都在 C-1 表里的某个目录中，不直接放在 `src/`、`src/core/`、`src/modules/`、`src/app/` 下；仓库根上没有 `runtime/`、`extensions/`、`daemon/`。
- C-3：包照常安装、加载和运行：pi 从包里找到入口并加载；守护进程能启动；按自身位置查找的文件（随包分发的角色定义、技能、语法解析资源、守护进程启动脚本、项目索引规则文件）在新位置都能找到；安装前的 git 检查照常执行。
- C-4：不改行为：除了 import 路径、按自身位置拼的相对路径，以及为单向引用挪动的 4 处代码，源文件里的函数体不改。
- C-5：现有测试只改 import 路径和读取源码的位置。会扫描源码目录的测试改成递归扫描 `src/`，扫到的源文件数不少于搬家前同一个测试扫到的数量。
- C-6：在新路径上用 `git log --follow <新路径>` 和 `git log -L :<函数名>:<新路径>`，能查到搬家之前的提交。

## 验收
- [ ] AC-1 ← C-1：`src/modules/delivery/` 里有 Git 交付的主窗口注册代码和交付逻辑；`src/modules/settings/` 里有设置页；`src/core/exec/` 里有外部命令的报错格式和读 git 的代码；其余模块的内容和 C-1 表一致。
- [ ] AC-2 ← C-2：列出 `src/` 下所有 `.ts`、`.mjs`，每个都在 C-1 表的某个目录里；仓库根上 `runtime/`、`extensions/`、`daemon/` 都不存在。
- [ ] AC-3 ← C-3：安装测试和集成测试全部通过；`pi install` 本地包后打开 pi，`/one:setting`、`/one:ps` 能打开，守护进程能启动。
- [ ] AC-4 ← C-4：对比搬家前后，除 import 行、相对路径和 4 处挪动外，没有函数体改动；真实模型验收 P1–P13、M9-AC12、M9-AC2/AC3/AC11 全部通过。
- [ ] AC-5 ← C-5：类型检查和单元测试全部通过；扫描源码的测试扫到的文件数不少于搬家前。
- [ ] AC-6 ← C-6：`git log -L :<函数名>:src/modules/requirement/requirement-state.ts` 能列出搬家之前的提交。

## 验证路径
1. 列出 `src/` 下所有源文件，对照 C-1 表（AC-1、AC-2）。
2. 跑四项纯代码测试（AC-3、AC-5）。
3. `pi install` 本地包，打开 pi 试 `/one:setting`、`/one:ps`（AC-3）。
4. 在新路径上跑 `git log -L`（AC-6）。
5. 跑全部真实模型验收（AC-4）。
