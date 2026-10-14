---
name: archive
description: 需求完成归档时，最终批准版本的原型 HTML 和正文一起写进需求归档目录并随交付提交；身份校验与项目索引先放行 html
---
# 归档带上原型

## 目标
需求完成时，最终批准版本里的每份原型 HTML 和需求正文一起写进项目的需求归档目录，随交付一起提交。用户在仓库里双击就能用浏览器打开。

## 业务规则（来源：PRD backup-archive）
- 文件名是 `<需求编号>.<原型名称>.html`，和正文 `<需求编号>.<标题>.md` 放在同一目录。内容和用户通过的那一版逐字节相同。
- 最终批准版本没有原型时，归档结果和现在一样，只有正文。
- 归档位置已有同名、但内容不同的 html 时，按现有的"归档位置已有内容不同的文件"处理，标为受阻。
- 交付检查把"正文 + 本需求的原型 html"当成同一组归档：这组文件可以是未提交的改动，可以一起暂存、一起提交；别的需求的归档、或不属于这一组的文件，照样拒绝。
- 需求身份校验在归档目录里遇到 `<需求编号>.*.html` 时放过：不当成正文，不算多份正文冲突，也不报格式无效。项目索引同样跳过这些 html。
- 落地顺序：先放宽身份校验和项目索引，再让关闭流程写 html，最后改交付。顺序反了，中间的提交会让该需求的读取全部被拦下。

## 涉及文件
- runtime/requirement-identity.ts（修改：`inspectProdArchives` 放过本需求的 html）
- runtime/project-index-service.ts（修改：`archiveSummary` 跳过 html，不记为 invalid_archive_name）
- runtime/workflow-close.ts（修改：Archive 记录加原型文件清单；`archive` 写 html）
- runtime/git-delivery.ts（修改：四处检查改成"正文 + 原型 html"这一组）
- extensions/git-delivery.ts（修改：交付确认窗口的"将提交归档"一行列出原型文件数）
- tests/requirement-identity.test.ts、tests/project-index-service.test.ts、tests/workflow-close.test.ts、tests/git-delivery.test.ts（修改）

## 成品定义
关闭记录里的 Archive 新增字段（其余字段不变）：
```ts
prototypes: Type.Array(object({ path: Type.String({ minLength: 1, maxLength: 512 }), name: Type.String({ minLength: 1, maxLength: 40 }),
  version: positive, hash: sha256Hex }), { maxItems: 50 }),
```

## 函数清单
### runtime/requirement-identity.ts
| 函数名 | 职责 |
|---|---|
| `inspectProdArchives`（修改） | 以 `<需求编号>.` 开头、以 `.html` 结尾的普通文件跳过；其余规则不变 |
| `prototypeArchivePathFor`（新增） | 按需求编号和原型名称算出归档路径 |
### runtime/project-index-service.ts
| 函数名 | 职责 |
|---|---|
| `archiveSummary`（修改） | `.html` 不计入正文归档，也不报名称错误 |
### runtime/workflow-close.ts
| 函数名 | 职责 |
|---|---|
| close 时组装 archive（修改） | 用 `prototypesAtRevision(最终 revision)` 填 prototypes 清单 |
| `archive`（修改） | 正文之后逐个写原型 html：已存在且相同的跳过，不同的报 archive_conflict；先核对源文件指纹 |
### runtime/git-delivery.ts
| 函数名 | 职责 |
|---|---|
| `deliverRequirement`（修改） | 改 dirty 检查、foreign_prod_archive 检查、`git add` 加逐个核对指纹、unexpected_staged 检查四处，全部按"正文 + 原型 html"这一组判断；`ownChanges` 的排除列表也把这些 html 算进去 |

## 协作关系
- 依赖 06 的 `prototypesAtRevision` 和 02 的 `prototypeFilePath`。
- `core-permissions.ts` 已经把归档目录整体列为 PM 和 worker 不可写，html 只由关闭流程写，不用改。

## 验证方式
- 测试入口：需求身份核验（create、read、update 前的归档检查）、项目索引刷新、`RequirementCloseService.archive`、`deliverRequirement`（临时 git 仓库）。
- 测试输入：最终批准版本带"设置页" v3 和"命令行输出" v1 的已完成需求。
- 预期结果：
  - [ ] 归档目录里有本需求的 `.md` 和两个 `.html` 时，读取、更新照常进行，没有报身份冲突；项目索引里没有 html 的错误条目。
  - [ ] 归档后目录里有正文和两个 html，文件名含需求编号和原型名称，内容和原型文件逐字节相同。
  - [ ] 目标位置已有内容不同的 html 时，归档受阻，原因是"归档位置已有内容不同的文件"。
  - [ ] 交付：三个文件一起提交，交付检查通过；如果多了一个别的需求的 html，或改动了本组外的文件，交付被拒。
  - [ ] 没有原型的需求：归档和交付与现在一样，现有测试全部通过。
