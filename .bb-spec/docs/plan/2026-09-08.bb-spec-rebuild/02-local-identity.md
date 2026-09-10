---
name: local-identity
description: 仓库身份、需求身份与工作区发现，以及本机用户数据区的目录布局，供窗口与守护进程共用
---
# 本机身份与数据布局

## 目标
任何窗口或守护进程都能从当前目录稳定得到同一仓库身份与需求身份，找到本机数据区中的对应位置，并按启动路径确定工作区成员仓库。

## 业务规则（来源：spec）
- local-ownership：流程数据以仓库身份和需求身份归属，不以对话目录或分支名代替；同仓库多个 worktree 定位同一份记录；不同仓库或不同需求即使同名也不得混用；身份缺失、冲突或无法核对时拒绝写入并说明原因；删除 worktree 或分支不删除数据；数据不随 Git 同步。
- workspace-coordination：窗口的工作区由启动目录决定，启动目录及其子目录内发现的全部 Git 仓库都是成员；在仓库或其 worktree 内启动时工作区只有该仓库；启动目录之外的仓库不可见。
- daemon-host：一个仓库对应一个守护进程，以仓库身份区分；同仓库各 worktree 连接同一个守护进程。

## 涉及文件
- 新建：runtime/identity.ts — 身份、工作区与路径
- 新建：tests/local-identity.test.ts

## 成品定义

本机数据区目录布局（根目录随 HOME，agentDir 可被 pi 的环境变量覆盖）：

```text
~/.pi/agent/pi-company/
├── global.sqlite                 全局角色设置、主会话 Shell 登记
├── sock/<repoId前16位>.sock      仓库守护进程通信资源
└── repos/<repoId>/data.sqlite     仓库身份、需求、运行、决策、会话、中继、窗口、占用、诊断
```

数据库及 WAL/SHM 仅允许当前用户读写，每条记录主键为 UUIDv7。仓库 SHA256、需求名称、任务编号属于业务键。同仓 worktree 共享数据库，删除开发现场不删除数据库。

目录权限 0o700，文件权限 0o600。

## 函数清单

### runtime/identity.ts
| 函数名 | 职责 |
|---|---|
| `repositoryIdentity` | 由任意目录解析所属 Git 仓库的 common dir 实际路径并生成仓库身份；非 Git 目录或解析失败抛出含原因的错误 |
| `requirementIdentity` | 由需求目录名解析需求身份（日期 + slug），格式不合法抛错 |
| `discoverWorkspace` | 从启动目录向下扫描（不设固定深度上限，跳过 node_modules 与 .git）收集 Git 仓库；启动目录本身在仓库或 worktree 内时只返回该仓库 |
| `isInsideRepository` | 判断目录是否位于某个 Git 工作树或 linked worktree 内 |
| `listWorktrees` | 列出仓库的全部 worktree 路径 |
| `dataRoot` | 本机数据根路径 |
| `repoDataDir` | 仓库数据目录，首次访问时创建并写 SQLite 仓库记录 |
| `daemonSocketPath` | 守护进程 socket 路径 |

## 协作关系
- `repositoryIdentity` 与 `discoverWorkspace` 调用 git 命令读取 common dir 与 worktree 列表；数据目录登记通过 SQLite 完成。
- 后续 store、run-store、decisions、windows、ranges、daemon-client、daemon-lifecycle 经 identity 取得业务身份，再由 database 统一定位数据库。
- 依赖：Node 内置 fs、path、crypto、child_process；不依赖 pi SDK。

## 验证方式
- 测试入口：`runtime/identity.ts` 导出函数；测试夹具由 `createRepoFixture`、`addWorktree`、`createWorkspaceFixture` 提供
- 测试输入：临时仓库 A 及其 worktree A2；同名的另一仓库 B；含 A、B 与 node_modules/伪仓库的父目录；非 Git 临时目录
- 预期结果：
  - A 与 A2 的仓库身份相同；A 与 B 不同；重命名 A 的分支或从 A 内子目录调用，身份不变
  - 非 Git 目录调用仓库身份抛出含"不是 Git 仓库"的错误
  - 需求身份接受 `2026-09-08.order-export`，拒绝 `order-export` 与 `2026-9-8.x`
  - 从父目录发现工作区得到 A 与 B，不含 node_modules 下的伪仓库；深度 5 层的仓库仍被发现；从 A 内或 A2 内发现只得到 A
  - 首次取 `repoDataDir` 时创建目录并写 SQLite 仓库记录，第二次不改写 firstSeenAt；目录权限为 0o700
- [x] 仓库身份跨 worktree 一致且跨仓库隔离
- [x] 工作区发现的三种启动位置
- [x] 数据目录创建与权限
- [x] 非法输入拒绝
