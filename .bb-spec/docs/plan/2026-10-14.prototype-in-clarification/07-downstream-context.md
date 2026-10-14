---
name: downstream-context
description: worker、reviewer、qa 的任务说明带上所依据批准版本的全部原型；改写四份职责规矩，PM 遇到缺原型的界面任务就上报
---
# 下游从需求读原型

## 目标
PM 派出的 worker、reviewer、qa 都拿到这个任务所依据的那一版需求里的全部原型，能读这些文件，并照原型实现、审查、验收。PM 遇到要改界面、却没有原型的任务时，不派这个任务，上报用户。

## 业务规则（来源：PRD downstream-reads）
- 任务说明里加一段"需求第 N 版附带的原型（界面以它们为准）"，下面每份一行：名称、第几版、文件位置、指纹前 12 位。没有原型时这一段不出现。
- 版本怎么取：worker 和 reviewer 用派出时需求当前的批准版本（派工时没有待复核的版本，所以这就是计划依据的那一版）；检查轮里的 qa 用这一轮基线里的版本。
- 派出时就把这一版的原型写进任务说明，之后批准了新版本，已派出的任务也不变。
- 读取权限：worker 和 reviewer 本来就不限读取范围；qa 继续按现有方式，只给 read，并且只能读这几份原型文件。
- 职责规矩：
  - worker：任务说明里有原型时，先读原型，实现与它一致。
  - reviewer：改动与需求里的原型不一致，列为阻塞；改了界面但需求里没有原型，列为阻塞，写明"改了界面但需求里没有用户通过的原型"。
  - qa：任务说明里有原型时，对照原型逐项验收界面，不一致的列为阻塞。
  - pm：拆计划时发现某个任务要改用户看得到的界面，而批准版本里没有对应原型，就不派这个任务，用上报写明哪个任务、哪块界面缺原型，以及用户的处理办法只有一个：回主窗口补原型，再批准新版本。
- 现有规矩里"没有浏览器就在 summary 写一句没在浏览器里看过"这类说法保留，只改原型的来源。

## 涉及文件
- daemon/run-manager.ts（修改：`taskContext`、`reviewContext` 加原型段；QA 的 readRoots 改成从快照取）
- runtime/prototype-dispatch.ts（修改：加 `requirementPrototypeLines`，拼原型段文字）
- role-rules/worker.md、role-rules/reviewer.md、role-rules/qa.md、role-rules/pm.md（修改）
- tests/role-rules.test.ts（修改）、tests/downstream-prototypes.test.ts（新建）

## 函数清单
### runtime/prototype-dispatch.ts
| 函数名 | 职责 |
|---|---|
| `requirementPrototypeLines` | 按版本快照拼原型段文字，没有原型时返回空 |
### daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `dispatchTask`（修改） | 按角色取 revision（qa 取检查轮基线，其余取当前批准版本），用 `prototypesAtRevision` 和 `prototypeFilePath` 拼原型段；qa 的 readRoots 用这些文件 |
| `taskContext` / `reviewContext`（修改） | 接收原型段文字，替换掉旧的 `approvedPrototypeLine` 和 `approvedPrototypes` |

## 协作关系
- 依赖 06 的 `prototypesAtRevision` 和 02 的 `prototypeFilePath`。
- 检查轮基线的版本，从现有检查轮记录里读（和 `requirement-read-tool.ts` 取 QA 读取版本是同一个来源）。

## 验证方式
- 测试入口：守护进程 `dispatchTask`，用假模型读取会话提示词；`loadRoleRules`。
- 测试输入：第 1 版快照里有"设置页" v2 和"命令行输出" v1。
- 预期结果：
  - [ ] worker、reviewer、qa 三份提示词里都有两份原型的名称、版本、位置和"界面以它们为准"。qa 能读这两个文件，读别的文件被拒。
  - [ ] 批准版本没有原型时，三份提示词里都没有原型段。
  - [ ] 先按第 1 版派出 worker 甲；批准第 2 版，把"设置页"换成 v3；PM 复核后派出 worker 乙。甲的提示词是 v2，乙的是 v3。
  - [ ] 四份职责规矩含上面列出的原型要求；pm 规矩不再含"ui 写成 true""带 prototype 派"。
