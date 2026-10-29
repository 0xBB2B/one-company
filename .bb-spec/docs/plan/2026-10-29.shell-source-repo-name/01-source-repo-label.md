---
name: source-repo-label
description: 算出工作区各仓库在「来源」行的显示名（同名带上层目录），Shell 详情页「来源」行用它替换截短的仓库编号
---
# 「来源」行显示仓库名

## 目标
子代理开的 Shell，详情页「来源」行写成 `<代理>（仓库 <显示名>）`；显示名是仓库名，工作区里有同名仓库时带上层目录区分。

## 业务规则（来源：PRD source-repo-name）
- Shell 任务详情页：`/one:ps` 打开的页面里选中一条按 Enter 看到的页面，「来源」行写开这个 Shell 的是谁，例如 `worker#a1b2c3`。子代理的 Shell 来自某个仓库的守护进程，主会话的 Shell 来自本窗口。
- 仓库名：仓库主目录的目录名；工作区里的仓库是附加工作目录（git worktree）时取所属主仓库的目录名。程序里每个仓库有一个 git 公共目录路径 `commonDir`（如 `/w/企微BOT/.git`），仓库名取它的上一层目录名；`commonDir` 本身以 `.git` 结尾的目录名（裸仓库，如 `/w/api.git`）时取去掉 `.git` 后缀的名字。
- C1：工作区里没有别的仓库和它同名时，「来源」行是 `<代理>（仓库 <仓库名>）`，整页不出现仓库编号的任何片段。
- C2：工作区里几个仓库仓库名相同时，它们都写成 `仓库 <上层目录>/…/<仓库名>`：从仓库主目录往上逐层加目录名，用 `/` 隔开；这几个加同样多层，加到互不相同为止。只和当前工作区的仓库比；名字不同的仓库仍只写仓库名。同一个仓库在工作区里出现多次（同一个 `commonDir`，例如主目录和它的 worktree 都在工作区里）算一个仓库，不算同名。
- C3：主会话开的 Shell，「来源」行是 `<代理>（本窗口）`，不变。
- C4：一行放不下时和详情页其他行一样折行，续行对齐到值那一列，文字不丢。
- C5：仓库名和上层目录名里的控制字符（换行、ESC 等）显示时去掉。
- 非目标：Shell 列表页、状态栏、页面报错文字里的仓库名不改（报错仍用不带上层目录的仓库名）；守护进程换新提示不改。

## 涉及文件
- 修改 `src/core/storage/identity.ts`
- 修改 `src/modules/shell/shell-page.ts`
- 修改 `src/modules/shell/shell-ui-extension.ts`

## 函数清单
### src/core/storage/identity.ts
| 函数名 | 职责 |
|---|---|
| `repoDisplayLabels`（新增，导出） | 输入工作区全部仓库的 `commonDir`，返回每个 `commonDir` 在「来源」行的显示名：不同名的只写仓库名；同名组按 C2 统一加层数直到互不相同；同一 `commonDir` 去重；每段目录名去控制字符（复用 `sanitizeText`，与 `repoDisplayName` 一致） |
| `repoDisplayName`（不改） | 已有：单个仓库的仓库名 |

### src/modules/shell/shell-page.ts
| 函数名 | 职责 |
|---|---|
| `ShellPageRepo`（接口，新增字段 `label`） | 「来源」行用的显示名；`name` 保持原样，仍给报错文字用 |
| `ShellPage.rowOwner`（修改） | 子代理 Shell 返回 `仓库 <repo.label>`；本窗口不变 |
| `shortIdentity`（删除） | 改动后不再被使用 |

### src/modules/shell/shell-ui-extension.ts
| 函数名 | 职责 |
|---|---|
| 组装 `repos` 的那段（修改） | 用 `repoDisplayLabels` 一次算出全部仓库的显示名，填进每个 `ShellPageRepo.label` |

## 协作关系
`shellUiExtension` 打开页面时，拿 `window.workspace.repos` 的全部 `commonDir` 调 `repoDisplayLabels`，按 `commonDir` 取出 label 填进 `ShellPageRepo`；`ShellPage.renderDetail` 经 `rowOwner` 读 `repo.label`。无外部依赖，不涉及窗口与守护进程的通信，不升协议版本号。

## 验证方式
- 测试入口 1：`src/core/storage/identity.ts` 导出的 `repoDisplayLabels(commonDirs: string[])`，返回 `Map<commonDir, 显示名>`。
  - `["/w/企微BOT/.git", "/w/admin-web/.git"]` → `企微BOT`、`admin-web`。
  - `["/w/client/api/.git", "/w/server/api/.git", "/w/企微BOT/.git"]` → `client/api`、`server/api`、`企微BOT`。
  - `["/w/a/client/api/.git", "/w/b/client/api/.git"]` → `a/client/api`、`b/client/api`。
  - `["/w/x/client/api/.git", "/w/y/client/api/.git", "/w/server/api/.git"]` → 三个都加两层：`x/client/api`、`y/client/api`、`w/server/api`。
  - 同一 `commonDir` 出现两次 → 只写仓库名，不加上层目录。
  - 目录名含 `\n`、`\x1b` → 结果里没有这些字符。
- 测试入口 2：`shellUiExtension` + `openShellUiPage`（写法同 `tests/shell-ui.test.ts`「openShellUiPage：保留缺连接仓库」用例）：`window.workspace.repos` 给出带 `commonDir` 的仓库，假客户端的 `shells.list` 返回一条 `host` 为 worker 的任务；打开页面、`refresh()`、按 Enter，`render(80)`：
  - 单个仓库 `commonDir: "/workspace/企微BOT/.git"`，`repoId` 为 64 位十六进制 → 「来源」行包含 `（仓库 企微BOT）`，整页不含 `repoId` 的前 7 位和后 4 位。
  - 两个仓库 `/workspace/client/api/.git`、`/workspace/server/api/.git`，各一条 worker 任务 → 两条详情的「来源」行分别含 `（仓库 client/api）`、`（仓库 server/api）`。
  - 主会话在 `shellRegistry` 登记的 Shell → 详情「来源」行为 `主 agent（本窗口）`。
  - 仓库名 60 个字符 → 「来源」值折成两行，第二行以 11 个空格开头，两行去掉前导空格后拼起来含完整的 `（仓库 <长名字>）`。
- [ ] `pnpm run typecheck` 通过；`vitest run tests/shell-ui.test.ts tests/shell-page.test.ts tests/code-fingerprint.test.ts` 和新测试通过
