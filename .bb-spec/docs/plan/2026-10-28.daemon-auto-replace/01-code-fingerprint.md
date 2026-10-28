---
name: code-fingerprint
description: 算 one-company 安装目录的代码指纹，并给出提示里用的项目目录名
---
# 代码指纹与项目目录名

## 目标
程序能算出一个安装目录当前的代码指纹，能从仓库的 Git 公共目录得出提示里用的项目目录名。

## 业务规则（来源：PRD replace-when-idle、wait-then-replace）
- 代码指纹：根据安装目录里 `src/`、`resources/` 两个目录下的全部文件（递归），以及 `package.json` 的内容算出的摘要。这三项写死在程序里，不读 `package.json` 的 `files`。任一文件的内容变化、增删或改名都会让指纹变化。
- 只改这三项以外的文件（如 `tests/`、`README.md`、`LICENSE`、`role-rules/`、`skills/`、`agents/`、`docs/`）不改变指纹。理由（用户 2026-10-28 定）：只看守护进程读进内存后一直用到退出的内容；`role-rules`、`shared`、`agents` 每次派子代理都从磁盘重读，`rules`、`examples` 只有主窗口用，`assets`、`README.md`、`LICENSE` 程序不读。
- 同一份内容不论按什么顺序遍历目录，算出的指纹都相同（按相对路径排序后再算）。
- `src/` 或 `resources/` 不存在时当作空目录，不抛错；`package.json` 不存在时抛错。
- 实测仓库的 `src/` 加 `resources/` 约 180 个文件、6MB，读一遍远低于 1 秒。
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
| `codeFingerprint` | 递归收集给定安装目录下 `src/`、`resources/` 的全部文件并按相对路径排序，把每个文件的相对路径和内容依次喂进 sha256，最后加上 `package.json` 内容，返回十六进制摘要 |

### src/core/storage/identity.ts
| 函数名 | 职责 |
|---|---|
| `repoDisplayName` | 按上面的规则从 `commonDir` 得出项目目录名 |

## 协作关系
- `codeFingerprint` 只依赖 `node:fs/promises`、`node:crypto`、`node:path`，不依赖其他业务模块；由计划 02 的守护进程启动与比较逻辑调用。
- `repoDisplayName` 是纯函数，由计划 03（窗口端提示与错误）和计划 04（Shell 汇总前缀）调用。

## 验证方式
- 测试入口：`codeFingerprint(<临时安装目录>)`、`repoDisplayName(<commonDir>)`
- 测试输入：在 `temporaryRoot()` 下建一个假的安装目录：`package.json`（内容任意），`src/a.ts`、`src/sub/b.ts`、`resources/x/p.wasm`、`README.md`、`role-rules/pm.md`、`tests/t.test.ts`
- 预期结果：
  - 不改任何文件时连算两次，指纹相同，且是 64 位十六进制串
  - 改 `src/sub/b.ts` 一个字符 → 指纹变化；改回原内容 → 指纹恢复成原值
  - 在 `src/` 下新增一个文件、删除 `resources/x/p.wasm`、把 `src/a.ts` 改名为 `src/c.ts`（内容不变）→ 各自都让指纹变化
  - 改 `resources/x/p.wasm` 内容 → 指纹变化
  - 改 `package.json` → 指纹变化
  - 只改 `README.md`、`role-rules/pm.md`、`tests/t.test.ts`，或新增 `docs/x.md`、`skills/s.md` → 指纹不变
  - 没有 `resources/` 目录的安装目录 → 不抛错，正常返回指纹；之后补建空的 `resources/` 目录 → 指纹不变
  - 没有 `package.json` → 拒绝
  - `repoDisplayName("/x/企微BOT/.git")` 为 `企微BOT`；`repoDisplayName("/x/repo.git")` 为 `repo`
- [ ] 上述用例全部通过
- [ ] 对仓库本身调用 `codeFingerprint(installedPackageRoot())` 能在 2 秒内返回 64 位十六进制串
