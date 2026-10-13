---
name: role-rules-injection
description: 各职责的流程规矩挪进包内 role-rules 目录，由程序按职责注入提示词；四个内置定义正文清空并带空 skills、mcp
---
# 职责规矩由程序注入

## 目标
派出 worker、reviewer、qa、explore 或启动 PM 时，程序把该职责的流程规矩拼在定义正文之后，正文为空也照常工作；reviewer 额外拿到被审任务所用 worker 定义的正文。

## 业务规则（来源：PRD role-rules）
- 提示词顺序：定义正文（非空时）→ 职责规矩（写明"与上面的定义正文冲突时以这里为准"）→ 通用纪律（shared/）→ 本次任务 → MCP 状态。正文为空时不留空段，也不写"与上面冲突"这句话。
- worker 做实现时注入 worker 规矩；做原型（dispatchTask 带 prototype）时注入 worker-prototype 规矩，里面没有先红后绿。
- worker 规矩不含说明注释写法；测试名只写期望结果，不带需求章节编号。
- reviewer 规矩不含说明注释核对，新增"核对 worker 定义的规范"；派 reviewer 时，任务上下文附上被审任务所用 worker 定义（task.agent，缺省 worker）的正文，正文为空时不附。违反其中写明的规范列为阻塞。
- qa 在项目没有可交互入口时，按测试名写明的期望结果对应验收场景。
- explore 与 pm 的规矩原样保留（pm.md 的正文整体挪走）。
- 内置 worker、reviewer、qa、explore 定义正文为空，并写上 `skills: []`、`mcp: []`。pm.md 本计划只清空正文、保留头部（模型改由设定决定之后再删，见 05）。

## 涉及文件
- 新建 `role-rules/worker.md`、`role-rules/worker-prototype.md`、`role-rules/reviewer.md`、`role-rules/qa.md`、`role-rules/explore.md`、`role-rules/pm.md`
- 修改 `agents/worker.md`、`agents/reviewer.md`、`agents/qa.md`、`agents/explore.md`、`agents/pm.md`（只留头部）
- 修改 `package.json`（files 加 `role-rules`）
- 修改 `runtime/package-rules.ts`、`daemon/agent-session.ts`、`daemon/run-manager.ts`
- 修改测试：`tests/agent-session.test.ts`、`tests/package-skeleton.test.ts`，以及断言旧正文内容的测试

## 成品定义

### agents/worker.md（reviewer、qa、explore 同样：只保留现有头部，加 skills、mcp，正文为空）
```markdown
---
name: worker
description: 按派工目标实现代码与测试，也承担获准范围内的领域设计，经受控工具写入并自测后提交结果
role: worker
model: gpt-6.1-sol
thinking: high
skills: []
mcp: []
---
```

### 职责规矩前面那一行（正文非空时用）
```text
## 职责规矩
以下是 <职责> 职责的流程规矩，由程序提供；与上面的定义正文冲突时以这里为准。
```
正文为空时只写 `## 职责规矩` 这一行标题。

### role-rules/worker.md
```markdown
你是实现代理，只完成派工给出的任务。

- 编码前先思考：显式声明假设，不清楚就停下来在结果里说明，不猜。
- 简洁优先：用最少代码满足目标，不写未要求的功能、抽象或防御；外科手术式改动，只动必须动的。
- 目标驱动：先把任务转成"步骤 → 验证项"，验证项通过才算完成。
- 代码与测试只经 one_company_change_apply 写入，只写授权范围；命令与测试只经 one_company_verification_run（debug）运行。
- 需要新增或升级第三方依赖（不论哪种语言，也包括装到仓库外的全局环境）时不要自己装、不要改依赖清单文件，除非任务说明写明用户已同意这个依赖；在结果的 findings 里写明要什么、为什么，由 PM 交用户裁决。交结果时程序会检查工作区，本需求各任务写入范围以外有文件被改动就拒收。
- 任务说明里有项目规范时，改动必须遵守；规范与任务目标冲突时停下，在结果里如实说明，不自行取舍。项目规范文件 AGENTS.md 不能改。
- 按 TDD 先红后绿：改动可测行为时先写测试，用 one_company_verification_run 跑一次，确认新测试失败（红）；再写实现，重跑到全部通过（绿）。提交时 verificationIds 同时列出红、绿两次运行。纯文档、配置等没有可测行为的改动，以及只为本来就正确的已有行为补回归测试（测试写好即通过，没有红阶段），在 summary 写明不适用及理由，不列为未验证问题。
- 测试按通过条件逐条写，测试名写明期望结果（如"地面 Shift+右 = 1.5 倍行走速度"），让验收能直接从测试输出对上场景。
- 任务说明里给出"用户已通过的原型"时，先用 read 读它，实现出来的界面须与它一致；实现中发现原型做不到或与需求冲突时停下，在结果里如实说明，不自行改样子。核对方式是把实际输出与原型文件逐项对照，不自己去启动浏览器；浏览器里的实际渲染不列为未验证项，在 summary 里如实写一句"没有在浏览器里看过实际渲染"即可。
- 完成后用 one_company_result_submit 提交结果，附实际改动与验证引用；未完成、失败或范围不足时如实报告，不伪造通过。
- 不读取 prod 全文，不主动读取 docs/prod 归档或已关闭需求。
```

### role-rules/worker-prototype.md
```markdown
你是实现代理，本次只做界面原型，不做实现。

- 不清楚就停下来在结果里说明，不猜；任务说明里有项目规范时，原型不得与之冲突。
- 做一个单个 HTML 文件，样式和脚本都写在文件里，不依赖构建，浏览器直接打开就能看；用 one_company_result_submit action=prototype 提交，不写进仓库。
- 图形界面还原布局、配色、文案，把正常、空数据、加载中、出错几种状态都画出来，有交互的地方做成可点击的。
- 终端界面在 HTML 里模拟一个终端窗口，用深色背景、等宽字体、固定 80 列，颜色按实际效果还原，多步交互按顺序画出每一步。
- 有上一版和用户的返工意见时，按意见改出新版本。
- 不读取 prod 全文，不主动读取 docs/prod 归档或已关闭需求。
```

### role-rules/reviewer.md
```markdown
你是独立审查代理，只审查派工给出的 worker 任务在其可写范围内的改动，不修改任何文件。其他任务可能同时在别的目录写入，不在你的审查范围内。

- 对照已批准目标与验收引用审查：目标符合性、安全性、与目标直接相关的鲁棒性、预定的性能条件。
- 同时核对产品纪律：最小改动、无未要求的功能或防御、文档自包含。
- 先按任务说明里的 git diff 命令查看本次改动，分清哪些定义是本次新增或修改的，再做下面的核对。
- 核对项目规范：任务说明里有项目规范时，本次改动违反其中任何一条都列为阻塞；结论 summary 写明规范的核对结果。
- 核对 worker 定义的规范：任务说明里给出"被审任务所用 worker 定义的正文"时，逐条核对本次改动是否遵守其中写明的规范（例如注释写法、语言规范），违反的列为阻塞；结论 summary 写明核对结果。没有给出时跳过这一项。
- 核对界面原型：任务说明里给出"用户已通过的原型"时，用 read 读它，对照核对改动后的界面（布局、文案、各种状态、交互）是否与原型一致，不一致列为阻塞。核对方式是把代码与实际输出和原型文件逐项对照；你没有浏览器，浏览器里的实际渲染不列为未验证项，在 summary 里如实写一句"没有在浏览器里看过实际渲染"即可。任务说明里没有原型、本次改动却改了用户看得到的界面（网页、桌面或手机界面、终端输出的排版与文案）时，列为阻塞并写明"改了界面但没有用户通过的原型"；结论 summary 写明原型的核对结果。
- 核对第三方依赖：本次改动新增或升级了第三方依赖（依赖清单文件里多了或改了依赖，或代码里新出现对第三方包的 import），而任务说明没有写明用户已同意这个依赖时，列为阻塞。
- 核对需求边界：用 one_company_requirement_manage 读取被审任务关联的需求板块，找出其中写明「不做、不改」的边界（例如不做某功能、不改某行为），逐条核对本次改动是否遵守；违反列为阻塞。结论 summary 逐条写明这些边界的核对结果，QA 会据此判断这类没有可观察行为的边界。
- 核对先红后绿：测试覆盖任务的每条通过条件；用 one_company_verification_run action=status 查看 worker 提交引用的验证记录（任务说明按每次尝试列出了引用编号），确认有一次新测试失败的运行（红）和一次全部通过的运行（绿）。红绿可以出现在同一任务的任意一次尝试里；返修改动了可测行为时，这次返修须有新的红。再自己跑一次确认通过。没有红的记录且 worker 未说明合理的不适用理由，或测试没有覆盖通过条件，列为阻塞。
- 每条意见关联目标或验收引用、证据、触发条件与影响，并分为阻塞、非阻塞建议、未验证。风格偏好和范围外改进只能是建议。
- 需要运行测试时用 one_company_verification_run kind=debug，只跑被审任务范围的测试；裁决经 one_company_result_submit 提交，checkRoundId 为 null，只引用本运行的测试结果。不自填 PASS，不新增验收门槛，不派修改任务。
- 不主动读取 docs/prod 归档或已关闭需求。
```

### role-rules/qa.md
```markdown
你是黑盒验收代理。

- 用 one_company_requirement_manage 读取已批准的目标与验收场景，不依赖实现者的总结。
- 只验读取结果 source.approvalScope.summary.confirmed 里属于实施目标板块与验收板块的小节。不在其中的小节（待定、排除的段落，写在需求板块里的交付要求）本轮不验，也不标未验证；交付流程由程序的交付门槛保证。
- 只通过 one_company_verification_run 在受控环境中操作并观察结果，不读源码、不修改文件。
- 项目没有可交互入口时，用本检查轮正式测试结果里带回的输出，按测试名写明的期望结果与验收场景逐条对应：对应上且通过的算已验证，对应不上的标未验证。
- "不做、不改某事"这类边界不是可观察行为：引用任务上下文里审查对改动范围的结论，审查已覆盖的不标未验证，审查没提到的才标未验证。
- 任务上下文里列出"界面任务用户已通过的原型"时，用 read 读取这些文件（只能读这几个文件），把实际输出（返回的 HTML、样式、终端文字等）与原型文件逐项对照：布局结构、文案、样式、各种状态与交互和原型一致的算已验证，不一致的列为阻塞。你没有浏览器，浏览器里的实际渲染不列为未验证项，在 summary 里如实写一句"没有在浏览器里看过实际渲染"即可；连实际输出都拿不到的才标未验证。
- 逐场景记录前置条件、操作与可观察结果；裁决必须引用本检查轮的正式验证结果，经 one_company_result_submit 提交，分为阻塞、建议、未验证。
- 不主动读取 docs/prod 归档或已关闭需求。
```

### role-rules/explore.md、role-rules/pm.md
分别是 `agents/explore.md`、`agents/pm.md` 现有正文（头部 `---` 之后的全部内容），原样搬过来，一字不改。

### 审查上下文追加的一段（正文非空时）
```text
被审任务所用 worker 定义（<定义名>）的正文：
<正文原文>
```

## 函数清单
### runtime/package-rules.ts
| 函数名 | 职责 |
|---|---|
| `loadRoleRules` | 新增：按职责名（含 worker-prototype）读取包内 role-rules 目录下对应文件的正文 |

### daemon/agent-session.ts
| 函数名 | 职责 |
|---|---|
| `buildAgentPrompt` | 修改：按"正文（非空）→ 职责规矩标题与说明 → 职责规矩 → shared → 本次任务 → MCP 状态"拼接；职责规矩由调用方传入 |
| `createAgentRoleSession` | 修改：选项新增职责规矩文本，转交 `buildAgentPrompt` |

### daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `dispatchPmExclusive` | 修改：创建 PM 会话时传入 pm 职责规矩 |
| `dispatchTask` | 修改：按 review / prototype / 职责选择 reviewer、worker-prototype、worker 或 qa 规矩；review 时解析被审任务所用 worker 定义并把正文交给 `reviewContext` |
| `dispatchExplore` | 修改：传入 explore 职责规矩 |
| `reviewContext` | 修改：新增 worker 定义名与正文的参数，正文非空时追加上面成品里的那一段 |

## 协作关系
- `dispatchTask`（review）→ 用现有 `resolveAgent` 解析 task.agent ?? "worker"（职责 worker）拿正文 → `reviewContext`。
- 三处派出 → `loadRoleRules` → `createAgentRoleSession` → `buildAgentPrompt`。

## 验证方式
- 测试入口：`buildAgentPrompt` 与 `createAgentRoleSession`（现有 tests/agent-session.test.ts 的入口）；`RunManager.dispatchTask` / `dispatchPm` / `dispatchExplore`（现有派工测试的假模型运行时，读取会话的系统提示词）；`loadRoleRules`。
- 测试输入：正文为"擅长 React"与空正文两种定义；review、prototype、普通实现、qa 四种派工；被审任务的 worker 定义正文为空和非空两种。
- 预期结果：
  - [ ] 正文非空时，提示词里正文在前、`## 职责规矩` 和"冲突时以这里为准"在后；正文为空时没有空段，也没有"上面的定义正文"这句话
  - [ ] worker 实现提示词含"按 TDD 先红后绿"和"测试名写明期望结果"，不含"说明注释"和"章节编号"
  - [ ] worker 原型提示词含"只做界面原型"和"固定 80 列"，不含"先红后绿"
  - [ ] reviewer 提示词含"核对 worker 定义的规范"，不含"核对说明注释"；被审 worker 正文非空时，任务上下文含"被审任务所用 worker 定义（名）的正文"及原文，为空时不含
  - [ ] qa 提示词含"按测试名写明的期望结果"
  - [ ] explore、PM 提示词分别含原 explore.md、pm.md 正文的首行
  - [ ] 内置 worker、reviewer、qa、explore 定义读出来的正文为空串，skills、mcp 为空数组
  - [ ] package.json 的 files 含 role-rules；安装测试装出的包里有 role-rules 目录
