---
name: 06-remote-delivery
description: 远程交付按本机登录记录认平台，PR 描述带 Requirement 行，只列仓库允许且已勾选的合并方式，压缩和普通合并由程序写提交说明
---
# 远程交付

## 目标
远程档位下，交付工具按登录记录选 gh 或 glab，建立或复用 PR/MR 并写好描述，弹窗按设置和仓库规则列出合并方式，按用户选择合并；合并失败时把原因写进结果而不是报错退出。

## 业务规则（来源：PRD 04-remote-delivery；已确认预览画面 11–14）
- C-1 认平台：origin 主机先看 gh、再看 glab 的登录记录（plan 01 `providerForHost`）。没有 origin → 拒绝，原因"仓库没有名为 origin 的远端"，建议"配置 origin 后再交付，或在 /one:setting 把 Git 交付改成仅本地"；都没登录 → 原因"本机 gh 和 glab 都没登录 <主机>"，建议"登录后再交付，或在 /one:setting 把 Git 交付改成仅本地"。拒绝时什么都不推送。按地址字样判断的 `providerFor` 和 `unknown_host` 删掉。
- C-1a 推送前真连一次：认出平台后、推送之前，GitHub 跑 `gh api user --hostname <主机>`，GitLab 跑 `glab api user --hostname <主机>`；失败就拒绝、什么都不推送，原因"<gh 或 glab> 连不上 <主机>：<报错>"，建议"检查网络和登录状态（gh auth status 或 glab auth status）后再交付"。
- C-2 PR 标题"<需求标题> [<编号>]"（现状）。描述逐行：`需求 <编号>`、`交付提交 <推送的提交>`、`最终检查代码 <codeHead>`、（自动 rebase 过时）`验收后已自动 rebase，这部分未重新验证。`、空行、`Requirement: <编号>`。复用已有 PR/MR 时把描述换成这份（gh `pr edit <号> --body`，glab `mr update <号> --description`）。
- C-3 GitHub 窗口：标题"PR 已就绪，怎么合并？"；正文需求标题、PR 链接（灰）、一行灰字：仓库开了 Allow auto-merge 写"仓库要求的检查通过后合并"，没开写"仓库没开自动合并，选了就现在合并"。选项：先"自己 review"（"PR 留着等你看，合并由你在网页上操作"），再按 squash、merge、rebase 顺序列出设置里勾了的："压缩合并"（"所有提交压成一个；标题是“需求标题 [编号] (#<号>)”，正文末行 Requirement: <编号>"）、"普通合并"（"保留每个提交，另加一个合并提交"）、"rebase 合并"（"保留每个提交，接到目标分支后面"）。仓库不允许的变暗，原因"仓库不允许<压缩合并/普通合并/rebase 合并>"；查不到仓库设置时这些项全变暗，原因"查不到仓库允许的合并方式：<原因>"。
- 仓库设置用一次 `gh api repos/{owner}/{repo}` 取 `allow_squash_merge`、`allow_merge_commit`、`allow_rebase_merge`、`allow_auto_merge`（实测这些字段存在）；现有的 `gh repo view --json squashMergeAllowed,…` 查询删掉。
- C-4 压缩合并带"推荐"，可选时光标默认停在它上面，否则停在"自己 review"；Esc 等于自己 review（`cancelNote` 照旧）。
- C-5 GitHub 合并：`gh pr merge <号> --squash|--merge|--rebase --match-head-commit <推送的提交>`；开了 Allow auto-merge 加 `--auto`。压缩和普通合并加 `--subject "<需求标题> [<编号>] (#<号>)" --body <C-2 描述>`；rebase 不加。
- C-6 GitLab 窗口：标题"MR 已就绪，怎么合并？"；正文需求标题、MR 链接、灰字"有流水线时等流水线通过后合并"。选项："自己 review"（"MR 留着等你看，合并由你在网页上操作"）；"压缩合并"（勾了 squash 才出现，带"推荐"，"所有提交压成一个；说明是“需求标题 [编号]”、空一行、MR 描述（末行 Requirement: <编号>）"；项目 `squash_option` 为 `never` 时变暗"项目不允许压缩"）；"不压缩（按项目设置）"（勾了 merge 或 rebase 才出现，"按项目设置的合并方式合并：普通合并、半线性或快进"；`always` 时变暗"项目要求压缩"）。用 `glab api projects/:fullpath` 读 `squash_option`（取值 never/always/default_on/default_off，GitLab API 文档）；读不到时后两项变暗"查不到项目的压缩设置：<原因>"。光标和 Esc 同 C-4。
- C-7 GitLab 合并：`glab mr merge <号> --auto-merge --sha <推送的提交> --yes --squash-message "<需求标题> [<编号>]\n\n<C-2 描述>"`；选压缩合并时再加 `--squash`，选"不压缩（按项目设置）"时不加（项目默认压缩时 GitLab 若照样压缩，用的就是这份说明）。先用 glab 源码或帮助核实"只传 --squash-message 不会强制压缩"，核实不了就把 `default_on` 当成 `always`（"不压缩"变暗，原因"项目默认压缩"）。`:fullpath` 占位符和"没有流水线时直接合并"在实施时用 glab 帮助或实际调用核实，不成立就停下报告。
- C-8 合并命令失败：结果仍是已交付，`merge` 里写明用的方式、"合并没成功"、平台报错原文、建议"处理后在网页上合并，或修好后重新交付"；工具不抛错。
- C-9 其余步骤保持：完成凭据核对、`head_changed`、外来归档、子模块、验收后目标前进的 rebase 与冲突停止、推送前确认、不强推。目标分支用现有 `fetchRemoteTarget`。

## 涉及文件
- src/modules/delivery/git-delivery.ts（修改）
- src/modules/delivery/git-delivery-extension.ts（修改：调用时读设置，把档位和合并方式传入）
- tests/git-delivery.test.ts、tests/git-delivery-extension.test.ts（修改）

## 函数清单
### src/modules/delivery/git-delivery.ts
| 函数名 | 职责 |
|---|---|
| `DeliveryOptions` | 新增类型：`{ mode, mergeMethods }` |
| `DeliveryResult` | 改：`delivered` 的 `merge` 改为 `{ method: "review"\|"squash"\|"merge"\|"rebase"\|"project"; state: "review"\|"queued"\|"merged"\|"failed"; reason?; next? }` |
| `deliveryTitle` / `deliveryBody` | 新增：按 C-2 生成标题和描述（plan 07 复用） |
| `prepareDelivery` | 新增：把 C-9 的公共核对和 rebase 从 `deliverRequirement` 抽出来，参数里带目标分支（plan 07 复用） |
| `deliverRequirement` | 改：远程流程：C-1 认平台 → `prepareDelivery` → 确认 → 推送 → 建立或复用并更新描述 → 合并窗口 → 合并 |
| `githubMergeOptions` / `gitlabMergeOptions` | 由 `autoMergeOptions` 改写：按 C-3/C-6 生成选项、正文那行灰字和"选项 → 方式"映射 |
| `mergeRequest` | 由 `enableAutoMerge` 改写：按 C-5/C-7 拼命令；失败返回 C-8 的结果 |
| `updateRequestBody` | 新增：复用时更新描述 |
### src/modules/delivery/git-delivery-extension.ts
| 函数名 | 职责 |
|---|---|
| `registerGitDelivery` 的 `execute` | 改：按 `facts.worktree` 所在主仓库（`rev-parse --path-format=absolute --git-common-dir` 的上级目录）调 `readAgentSettings`，把 `mode`、`mergeMethods` 交给 `deliverRequirement` |

## 协作关系
- 依赖 plan 01（`originHost`、`providerForHost`）、plan 02（设置值）、plan 03（交付只核对归档）。plan 07 复用 `prepareDelivery`、`deliveryTitle`、`deliveryBody`。
- gh/glab 调用保持 `cli()` 现有环境变量 `GH_PROMPT_DISABLED=1`、`NO_PROMPT=1`。

## 验证方式
- 测试入口：`deliverRequirement`；扩展工具 `execute`。
- 测试输入：沿用 `tests/git-delivery.test.ts` 的假 gh/glab 脚本，扩展：`auth token --hostname`（按 `FAKE_GH_HOSTS`）、`api repos/...`（按 `FAKE_SQUASH`/`FAKE_MERGE_COMMIT`/`FAKE_REBASE`/`FAKE_AUTO_MERGE` 返回 JSON，`FAKE_REPO_VIEW_FAILS` 时失败）、`pr edit`、`glab api projects/:fullpath`（按 `FAKE_SQUASH_OPTION`）、`mr update`、`FAKE_MERGE_FAILS`。origin 改用 `https://<主机>/team/app.git` 写法，并用 `url.<本地 bare 路径>.insteadOf` 让推送落到本地 bare 仓库；glab 登录用临时 `GLAB_CONFIG_DIR`。
- 预期结果：
- [ ] 假 gh 的 `api user` 失败（`FAKE_API_USER_FAILS=1`）→ 拒绝，原因含"gh 连不上 <主机>"，bare 仓库里没有需求分支。
- [ ] gh 登录 → 调 gh；只有 glab 登录、主机名不含 gitlab → 调 glab；都没登录、没有 origin → 拒绝文字如 C-1，bare 仓库里没有需求分支。
- [ ] 新 PR 的 `--body` 逐行如 C-2；分支已有 PR 时调用了 `pr edit <号> --body`。
- [ ] 三种都允许并勾选、开了 auto-merge：选项和灰字如 C-3，光标在"压缩合并"；`FAKE_REBASE=0` 时 rebase 变暗；只勾 merge 时只有"自己 review"和"普通合并"且光标在前者；仓库查询失败时方式全变暗；Esc → `merge.method` 为 review。
- [ ] 选压缩合并：调用参数含 `--squash --match-head-commit <sha> --auto --subject "<标题> [<编号>] (#<号>)" --body`；关掉 auto-merge 时没有 `--auto`；选 rebase 时没有 `--subject`。
- [ ] GitLab：`FAKE_SQUASH_OPTION` 为 never/always/default_on 时变暗项如 C-6；选压缩时参数含 `--squash --squash-message` 且说明第一行是"<标题> [<编号>]"；选"不压缩（按项目设置）"时参数含 `--squash-message`、不含 `--squash`。
- [ ] `FAKE_MERGE_FAILS=1`：结果 `status:"delivered"`、`merge.state:"failed"`、带平台报错和 C-8 建议，工具没有抛错。
