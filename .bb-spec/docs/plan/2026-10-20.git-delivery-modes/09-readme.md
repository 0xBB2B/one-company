---
name: 09-readme
description: README 前置条件加 Git ≥ 2.38 和仓库设置提示框，交付相关各处改写成两档和三种合并方式
---
# README

## 目标
README 写清 Git 交付两档、三种合并方式、回收怎么判断已合并、从代码怎么查需求；安装前在醒目位置提醒用户改仓库合并设置；旧的"推荐 rebase""开启 Git 交付"说法全部清掉。

## 业务规则（来源：PRD 06-requirement-trace-and-readme C-2、C-3）
- 「前置条件」列表加"Git ≥ 2.38"（回收工作区判断是否已合并要用）。
- 「前置条件」列表之后、「安装」之前放成品定义里的提示框。
- 「上手」第 7 条（`README.md:51`）：验收通过后需求关闭，代码和归档已提交在需求分支里；让主代理交付，远程档位推送并开 PR，仅本地档位直接合进主仓库当前分支，合并方式在窗口里选。
- 命令表（`README.md:55`）`/one:setting` 用途改为"查看和复制角色定义，改 PM 和两个内部代理的模型，选 Git 交付档位和合并方式"。
- 「Git 交付」一节（`README.md:195-216`）重写：两档区别；没设置时按 origin 主机是否在本机 gh/glab 登录过自动选；设置文件 `one-company` 下的 `git-delivery`（`"remote"`/`"local"`）和 `merge-methods`（`squash`/`merge`/`rebase` 的数组）、分层和信任规则；归档在需求关闭时提交进需求分支；远程交付步骤（认平台、PR 描述带 `Requirement:`、合并窗口只列仓库允许且已勾选的方式、开没开 Allow auto-merge 的区别、GitLab 按项目压缩设置）；仅本地交付步骤（主仓库须检出分支且无未提交改动、三种方式的结果）；目标分支规则（仅本地一律是主仓库当前分支）；回收工作区按"再合一次不带来任何改动"判断已合并，被拦时的三种办法。同步目标分支"能 rebase 就 rebase"的说明保留。
- 其他提到设置或回收的地方（`README.md:147`、`:259`、`:261`、`:279`）按两档改写措辞，不再说"开启/关闭 Git 交付"。
- 「常见问题」"怎么查某个需求改了哪些代码？"（`README.md:438-442`）按两个来源和两条命令改写；"PR 用哪种方式合并？"（`README.md:444-451`）整段删除。
- 全文搜不到"推荐用 rebase""PR 用哪种方式合并""开启 Git 交付""git-delivery 写 true"这类旧说法。

## 涉及文件
- README.md（修改）
- tests/user-documentation.test.ts（如需新增 README 必含句/禁用句断言则修改）

## 成品定义
「前置条件」之后的提示框：

```markdown
> [!IMPORTANT]
> **用远程交付前，先改好仓库的合并设置（需要仓库管理员权限）。** 有人在网页上合并时用的是这些默认设置，设成别的，主分支提交里的需求编号可能丢；丢了也能靠归档文件查回需求，只是慢一步。
>
> - **GitHub**：Settings → General → Pull Requests
>   - 勾选你要用的合并方式：Allow squash merging、Allow merge commits、Allow rebase merging。
>   - Allow squash merging 的默认说明选 Default to pull request title and description。
>   - 勾选 Allow auto-merge：交付时选了合并方式，会等仓库要求的检查通过后再合并；不勾时选了就立即合并。
>   - 主分支设了规则集（Settings → Rules → Rulesets）时，规则里允许的合并方式也要放行你勾的方式。
> - **GitLab**：Settings → Merge requests
>   - 要用压缩合并时，Squash commits when merging 不要选 Do not allow；选 Encourage 或 Require 时，交付窗口里只能选压缩合并。
>   - Squash commit message template 填 `%{title}`、空一行、`%{description}`。
```

## 函数清单
无代码函数，只改文档。

## 协作关系
- 内容以 plan 01–08 实现后的实际行为为准；与实现不符时以代码为准改文档。

## 验证方式
- 测试入口：`pnpm test`（`tests/user-documentation.test.ts`）；人工核对。
- 预期结果：
- [ ] 「前置条件」含"Git ≥ 2.38"；「安装」标题之前有 `> [!IMPORTANT]` 提示框，内容与成品一致。
- [ ] `grep -n "推荐用 rebase\|PR 用哪种方式合并\|开启 Git 交付\|true 或 false" README.md` 无输出。
- [ ] 「上手」第 7 条、命令表、「Git 交付」一节、常见问题按业务规则改写；"能 rebase 就 rebase"的同步说明仍在。
- [ ] `pnpm test` 中 README 只出现已注册的 `/one:` 命令的断言仍通过。
