---
name: code-fingerprint
description: 算 one-company 安装目录的代码指纹，并给出提示里用的项目目录名
---
# 代码指纹与项目目录名

## 目标
程序能算出一个安装目录当前的代码指纹，能从仓库的 Git 公共目录得出提示里用的项目目录名。

## 业务规则（来源：PRD replace-when-idle、wait-then-replace）
- 代码指纹：根据安装目录里 `package.json` 的 `files` 列出的每一项（目录就递归包含其中所有文件，文件就只算它本身），以及 `package.json` 本身的内容算出的摘要。任一文件的内容、增删或改名都会让指纹变化。
- 只改不在 `files` 里的文件（如 `tests/`、`README.md`、`AGENTS.md`、`.bb-spec/`）不改变指纹。
- 同一份内容不论在哪台机器、按什么顺序遍历目录，算出的指纹都相同（按相对路径排序后再算）。
- 当前 `files` 列出的是 `agents`、`assets`、`examples`、`resources/tree-sitter`、`role-rules`、`rules`、`shared`、`skills`、`src`、`README.md`、`LICENSE`；实测约 250 个文件、7MB，整体读一遍约 0.2 秒。
- 项目目录名：守护进程所属仓库的主仓库目录名。Git 公共目录（`commonDir`）末段是 `.git` 时取它的上一级目录名（`/x/企微BOT/.git` → `企微BOT`）；末段不是 `.git`（裸仓库，如 `/x/repo.git`）时取末段并去掉结尾的 `.git`（→ `repo`）。worktree 的 `commonDir` 指向主仓库的 `.git`，所以得到主仓库目录名。

## 涉及文件
- `src/core/host/code-fingerprint.ts` 新建
- `src/core/storage/identity.ts` 修改
- `tests/code-fingerprint.test.ts` 新建
- `tests/local-identity.test.ts` 或现有 identity 测试文件 修改（补项目目录名用例）

## 函数清单
### src/core/host/code-fingerprint.ts
| 函数名 | 职责 |
|---|---|
| `installedPackageRoot` | 返回本模块所在的 one-company 安装目录（`src/core/host` 往上三级），窗口和守护进程用同一个算法定位 |
| `codeFingerprint` | 读给定安装目录的 `package.json`，按 `files` 收集文件并按相对路径排序，把每个文件的相对路径和内容依次喂进 sha256，最后加上 `package.json` 内容，返回十六进制摘要；`files` 缺失或不是字符串数组时抛错，错误信息写明哪个文件、缺什么 |

### src/core/storage/identity.ts
| 函数名 | 职责 |
|---|---|
| `repoDisplayName` | 按上面的规则从 `commonDir` 得出项目目录名 |

## 协作关系
- `codeFingerprint` 只依赖 `node:fs/promises`、`node:crypto`、`node:path`，不依赖其他业务模块；由计划 02 的守护进程启动与比较逻辑调用。
- `repoDisplayName` 是纯函数，由计划 03（窗口端提示与错误）和计划 04（Shell 汇总前缀）调用。
- `files` 里列出的路径不存在时跳过该项，不抛错（安装产物里本来就可能没有某个可选目录）。

## 验证方式
- 测试入口：`codeFingerprint(<临时安装目录>)`、`repoDisplayName(<commonDir>)`
- 测试输入：在 `temporaryRoot()` 下建一个假的安装目录：`package.json` 写 `"files": ["src", "rules", "README.md"]`，再建 `src/a.ts`、`src/sub/b.ts`、`rules/r.md`、`README.md`、`tests/t.test.ts`
- 预期结果：
  - 不改任何文件时连算两次，指纹相同
  - 改 `src/sub/b.ts` 一个字符 → 指纹变化；改回原内容 → 指纹恢复成原值
  - 在 `src/` 下新增一个文件、或删除 `rules/r.md` → 指纹变化
  - 改 `package.json`（例如改 `version`）→ 指纹变化
  - 只改 `tests/t.test.ts`，或新增不在 `files` 里的 `docs/x.md` → 指纹不变
  - `files` 里列了不存在的 `assets` → 不抛错，指纹与没列它时相同
  - `package.json` 没有 `files` 字段 → 抛错，信息里有 `package.json` 和 `files`
  - `repoDisplayName("/x/企微BOT/.git")` 为 `企微BOT`；`repoDisplayName("/x/repo.git")` 为 `repo`
- [ ] 上述用例全部通过
- [ ] 对仓库本身调用 `codeFingerprint(installedPackageRoot())` 能在 2 秒内返回 64 位十六进制串
