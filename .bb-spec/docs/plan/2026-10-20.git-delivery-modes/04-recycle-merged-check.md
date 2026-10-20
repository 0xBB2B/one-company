---
name: 04-recycle-merged-check
description: 回收工作区改用"再合一次不带来任何改动"判断已合并，任何合并方式都能回收；被拦时给三种办法，通过后强制删分支
---
# 回收工作区按改动判断是否已合并

## 目标
需求分支用压缩合并、普通合并、快进、改写提交号的 rebase 合并进主仓库当前分支后都能回收；没合并或合并后又被改动时拦下并给出处理办法。

## 业务规则（来源：PRD 02-recycle-merged-check）
- C-1：已合并 = 在主仓库对"主仓库当前分支 HEAD"和"需求分支末端"做一次只计算不落盘的合并（`git merge-tree --write-tree <主分支 HEAD> <需求分支末端>`），没有冲突（退出码 0）而且得到的树等于主分支 HEAD 的树（`rev-parse HEAD^{tree}`）。末端已在主分支历史里时也满足。只在本机做，不联网、不改文件、不动任何分支。
- C-2：压缩、普通合并、快进、逐个 cherry-pick 后都判为已合并；没合并、有冲突、合并后主分支又改了需求改过的同一处 → 未合并（已在临时仓库实测）。
- C-3：未合并时拦下（现有 `WorkspaceManageError("recycle_blocked", blockers)`），原因加一条"需求分支 <需求分支名> 还有改动没进主仓库当前分支 <主仓库分支名>"（主仓库没检出分支时写"……没进主仓库当前提交 <短提交号>"）；worktree 目录已不存在但本地分支还在时，用分支末端照样判断；下一步写三种办法（替换现有的"按原因逐项处理后再回收"，其他原因同时存在时三种办法前仍保留这句）：
  1. 远端已经合并的，先在主仓库把目标分支拉到本地（例如 `git pull`）再回收；
  2. 还没合并的，先交付或自己合并；
  3. 合并后主分支又改了同一处代码、确认改动都已进去的，自己运行 `git worktree remove <worktree 路径>` 和 `git branch -D <分支名>`（填实际值）。
- C-4：本机 Git 版本低于 2.38（Git 2.38.0 发布说明：merge-tree 新增这种模式）时拦下，原因"本机 Git 版本 <版本号> 低于 2.38，判断不了需求是否已合并"，下一步"升级 Git 后再回收"。
- C-5：通过并确认后，本地需求分支用 `branch -D` 删除（替换 `src/modules/delivery/workspace-manage.ts:201` 的 `-d`）。其他检查和确认窗口不变。
- 主仓库当前没检出分支（detached）时照现有"无法读取分支提交"处理即可。

## 涉及文件
- src/core/exec/git-read.ts（修改：新增读版本函数）
- src/modules/delivery/workspace-manage.ts（修改）
- tests/workspace-manage.test.ts（修改）、tests/project-manage-tool.test.ts（如断言了旧文字则同步）

## 函数清单
### src/core/exec/git-read.ts
| 函数名 | 职责 |
|---|---|
| `gitVersion` | 运行 `git --version`，取出 `x.y.z` 数字部分 |
| `versionAtLeast` | 比较两个点分版本号 |
### src/modules/delivery/workspace-manage.ts
| 函数名 | 职责 |
|---|---|
| `mergedInto` | 新增：按 C-1 判断需求分支末端是否已并入主仓库 HEAD |
| `recycleBlockers` | 改：:227-230 的祖先判断换成先查版本（C-4），再用 `mergedInto`；未合并时记下需要三种办法 |
| `WorkspaceManageError` | 改：`recycle_blocked` 能带上 C-3 的下一步文字 |
| `recycle` | 改：删分支用 `-D` |
| `WorkspaceManageServiceOptions` | 改：可选注入 `gitVersion`，默认用 git-read 的实现（测试用来模拟 2.37.0） |

## 协作关系
- 结果经 `src/modules/project-index/project-manage-tool.ts:785-799` 原样转成 `{status:"blocked", reason, next}` 给主代理，不用改。

## 验证方式
- 测试入口：`WorkspaceManageService.recycle`（现有 `tests/workspace-manage.test.ts` 的 `world()`）。
- 测试输入：需求 worktree 上有提交；在主仓库分别执行 `merge --squash`+提交、`merge --no-ff`、`merge --ff-only`、逐个 `cherry-pick`；另造"压缩后主分支又改同一行"和"完全没合并"；注入 `gitVersion` 返回 `2.37.0`。
- 预期结果：
- [ ] 四种合并后回收成功，worktree 目录和本地分支都不存在。
- [ ] 判断前后主仓库 `git status --porcelain` 与 `git for-each-ref` 输出不变。
- [ ] 没合并、合并后又改同一行：抛 `recycle_blocked`，reason 含"需求分支还有改动没进主仓库当前分支 <分支名>"，next 含三种办法且命令里是实际路径和分支名。
- [ ] 版本 2.37.0：被拦，reason 含"本机 Git 版本 2.37.0 低于 2.38，判断不了需求是否已合并"，next 含"升级 Git 后再回收"。
- [ ] 压缩合并后 worktree 里有未跟踪文件 → 仍被拦，原因含"存在未提交或未跟踪的文件"。
