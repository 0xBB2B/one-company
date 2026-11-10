---
name: 06-conventions-draft
description: 修改 AGENTS.md 必须跟着一个草稿需求，写进这条对话线上的需求文件仓库，窗口文字换成"写进草稿"
---
# 项目规范写进需求草稿

## 目标
主代理改 AGENTS.md 时，改动记进当前对话线上某个草稿需求的文件状态，主仓库根目录的 AGENTS.md 不动；窗口按新文字显示。

## 业务规则（来源：PRD 01-line-bound-draft 约束 10、11；OVERVIEW 决策记录）
- `conventions-update` 必须带一个草稿需求编号（从需求工具结果里抄来的引用编号），不带或需求不是草稿时被拒，给模型的原因写清"要先指定一个草稿需求"。
- 用户在窗口选「写进草稿」后，用 02-requirement-file-repo 的 `commitDraftFiles` 把 AGENTS.md 记进这条线上这个需求的文件状态；这条线第一次改 AGENTS.md 时同时存 `AGENTS.base.md`（当时主仓库根目录的内容，没有就不存）。生成一个 conventions 锚点（父 = 线尖），写进对话。
- 主仓库根目录的 AGENTS.md 字节不变。
- AGENTS.base.md 存的是窗口弹出时作为对比对象的主仓库根目录内容（用户看到的那份）。确认期间主仓库根目录 AGENTS.md 被别处改动不拦，批准后进需求分支时由 08 三方合并处理。
- 窗口 Esc 提示行写 `Esc 不写`（用窗口组件的 escapeHint）。
- 窗口里的改动对比：这条线上草稿里已有 AGENTS.md 时和它比，没有时和主仓库根目录的比。和对比对象相同时返回 unchanged，不弹窗。
- 窗口文字：
  - 标题：`把这些改动写进需求「<需求标题>」的草稿？`
  - 改动对比下面的说明行：`批准需求后随需求分支写入，此后这个需求派出的 PM、worker、reviewer 都按新内容工作。`
  - 选项：`写进草稿`、`不写`、`其他（自己输入修改意见）`
  - 按 Esc 的说明：`Esc 不写`
  - 软链接提示行、对比头一行（"仓库里还没有 AGENTS.md，要写入的全文如下：" / "与仓库里现有的 AGENTS.md 相比的改动："）不变。
- 用户输入修改意见时照旧返回 `status=revise`；选「不写」返回 cancelled。
- 工具说明（给模型看的 description）改成：conventions-update 要带 requirementId，内容记进这个需求的草稿，批准需求、工作区建好后随需求分支写入。
- 写入保护（主窗口用 edit、write 直接改主仓库根目录的 AGENTS.md、DESIGN.md 时拦下）不变。

## 涉及文件
- 修改 `src/modules/verification/project-conventions.ts`
- 修改 `src/modules/project-index/project-manage-tool.ts`
- 修改 `rules/01-main-session.md` 里讲 conventions-update 的那段，改成"要带一个草稿需求、内容记进这个需求的草稿"
- 修改 `tests/project-conventions.test.ts`、`tests/project-manage-tool.test.ts`

## 函数清单
### src/modules/verification/project-conventions.ts
| 函数名 | 职责 |
|---|---|
| `updateConventions` | 改：入参多出需求标题、对比底稿（线上的 AGENTS.md 或主仓库的）和"写进草稿"回调；窗口文字换成上面规定的；选「写进草稿」后调回调，不写主仓库文件 |

### src/modules/project-index/project-manage-tool.ts
| 函数名 | 职责 |
|---|---|
| `conventions-update` 参数 schema | 改：加必填 `requirementId` |
| `conventions-update` 执行分支 | 改：核对需求是草稿、取当前线、读线上 AGENTS.md、调 `updateConventions`，回调里 `commitDraftFiles` 并写锚点进对话 |
| 工具 description | 改：按上面的说法更新 conventions-update 一段 |

## 成品定义

`project-manage-tool.ts` 里 conventions-update 的参数：
```ts
"conventions-update": Type.Object({
  action: Type.Literal("conventions-update"),
  repoId,
  requirementId: id,
  content: Type.String({ maxLength: MAX_CONVENTIONS_BYTES }),
}, { additionalProperties: false }),
```

## 协作关系
- 主代理调 `one_company_project_manage conventions-update` → 主窗口进程 → 读当前线（03 的 `currentLine`）→ `updateConventions` 弹窗 → 回调里 `commitDraftFiles`（02）+ `createLineAnchorIn`（01）→ `recordLineAnchor`（03）。
- 08-approved-files-into-branch 负责批准后把 AGENTS.md 提交进需求分支。
- 依赖 01、02、03。

## 验证方式
- 测试入口：`updateConventions`（`decide` 用桩）；`one_company_project_manage` 工具的 conventions-update 动作（沿用现有工具测试的假 ctx）。
- 测试输入：一个草稿需求「订单导出」；主仓库根目录有 AGENTS.md；新内容改了一行。
- 预期结果与验证项：
  - [ ] 不带 requirementId 调用，参数校验失败；带已批准需求的编号，返回原因"要先指定一个草稿需求"。
  - [ ] 窗口标题、说明行、三个选项、Esc 说明和规定的一字不差。
  - [ ] 选「写进草稿」后主仓库根目录 AGENTS.md 字节不变；这条线的文件状态里有新 AGENTS.md 和 AGENTS.base.md；对话里多一条锚点记录。
  - [ ] 同一条线上再改一次，窗口对比的是上一次写进草稿的内容。
  - [ ] 回到第一次修改之前的那一步，这个需求的文件状态里没有 AGENTS.md。
  - [ ] 选「其他」写意见返回 revise；选「不写」返回 cancelled，什么都不写。
