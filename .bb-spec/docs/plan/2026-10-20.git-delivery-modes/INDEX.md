# git-delivery-modes 实施计划
## 阶段 1：底层与设置
- [01-git-host-login](01-git-host-login.md) — origin 主机与本机 gh/glab 登录记录，得出内置默认档位
- [02-delivery-settings](02-delivery-settings.md) — 设置文件与设置页：档位、合并方式勾选；交付工具一直可用 [依赖: 01-git-host-login]
- [03-archive-commit](03-archive-commit.md) — 归档写好后立即提交进需求分支，交付只核对
- [04-recycle-merged-check](04-recycle-merged-check.md) — 回收工作区按"再合一次不带来任何改动"判断已合并
## 阶段 2：目标分支与交付
- [05-target-branch-mode](05-target-branch-mode.md) — 目标分支按档位决定，守护进程传档位给同步和检查 [依赖: 02-delivery-settings]
- [06-remote-delivery](06-remote-delivery.md) — 远程交付：认平台、PR 描述、合并选项与合并 [依赖: 01-git-host-login, 02-delivery-settings, 03-archive-commit, 05-target-branch-mode]
- [07-local-delivery](07-local-delivery.md) — 仅本地交付：在本机合进主仓库当前分支 [依赖: 06-remote-delivery]
## 阶段 3：规矩与文档
- [08-trace-rules](08-trace-rules.md) — 查找规矩两个来源、主会话交付说法、验收 P14
- [09-readme](09-readme.md) — README 提示框与交付各处改写 [依赖: 07-local-delivery, 08-trace-rules]
