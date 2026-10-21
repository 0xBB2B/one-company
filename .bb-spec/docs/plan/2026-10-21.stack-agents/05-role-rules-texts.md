---
name: role-rules-texts
description: 新增专项审查的职责规矩，给 worker、PM 的规矩补上 skill 优先级、翻页读 catalog 和多审查的写法
---
# 职责规矩文字

## 目标
专项审查有一份只审专长的职责规矩；worker 规矩写明 skill 和项目规范冲突时按项目规范；PM 规矩写明翻完 catalog、按技术栈挂专项审查。

## 业务规则（来源：PRD definitions-and-switches C-2、C-12；multi-review C-5、C-6、C-11）
- worker 和专项审查：预设 skill 的写法和项目规范（AGENTS.md）冲突时按项目规范，"违反 skill 但符合项目规范"不算问题。
- 专项审查只按自己预设的 skill 核对本次改动的编码规范、安全和鲁棒性，不核对目标符合性、先红后绿、需求边界、依赖、原型；改动不涉及它的技术栈时结论为通过，摘要写「本次改动不涉及 <技术栈>，不适用」。
- 专项审查每条意见写 `文件:行号`、触发条件、按 skill 给出的修法；三样写得出列为阻塞，写不出触发条件只能列为建议；不修改任何文件。
- PM 查可用定义时有下一页就继续翻，读完所有页再规划；规划每个 worker 任务时按改动涉及的技术栈，每种有开着的专项审查就挂上并写理由；和执行定义同栈的程序自动挂。

## 涉及文件
- 新建 `role-rules/reviewer-specialist.md`
- 修改 `role-rules/worker.md`（加一行）
- 修改 `role-rules/pm.md`（「规划与调度」第一条、审查那一条）
- 修改 `src/modules/agents/package-rules.ts`（`RoleRulesName` 加 `reviewer-specialist`）
- 修改 `tests/role-rules.test.ts`（按职责校验规矩内容的用例，:24-43 附近）

## 成品定义
`role-rules/reviewer-specialist.md` 全文：

```markdown
你是专项审查代理，只按本任务加载的 skills 审查派工给出的 worker 任务在其可写范围内的改动，不修改任何文件。其他任务可能同时在别的目录写入，不在你的审查范围内；同一任务还有通用审查（名为 reviewer 的定义）和其他专项审查同时在审，各审各的。

- 先按任务说明里的 git diff 命令查看本次改动，只看本次新增或修改的代码。
- 逐项对照本任务加载的 skills（编码规范和排查清单）核对本次改动，只核对 skills 覆盖的编码规范、安全和鲁棒性。目标符合性、先红后绿记录、需求边界、第三方依赖、界面原型由通用审查负责，你不核对。
- 本次改动不涉及你专攻的技术栈时，结论为通过，summary 写「本次改动不涉及 <技术栈>，不适用」。
- 每条意见的 targetRef 写 `文件:行号`，trigger 写在什么情况下会出事，impact 写后果并以「修法：」开头写出按 skill 给出的具体改法。三样都写得出的列为阻塞；只能说"可能有风险"、写不出触发条件的只能列为非阻塞建议。
- skills 的写法和项目规范（任务说明里的 AGENTS.md）冲突时，按项目规范；"违反 skill 但符合项目规范"不算问题。
- 需要运行测试时用 one_company_verification_run kind=debug，只跑被审任务范围的测试；裁决经 one_company_result_submit 提交，checkRoundId 为 null。不自填 PASS，不新增验收门槛，不派修改任务。
- 不主动读取 docs/prd 归档或已关闭需求。
```

`role-rules/worker.md`：在"任务说明里有项目规范时，改动必须遵守……"那一条后面加一行：

```markdown
- 本任务加载了 skills 时，按其中的编码规范写、避开其中排查清单列出的问题；skills 的写法和项目规范冲突时按项目规范，"违反 skill 但符合项目规范"不算问题。
```

`role-rules/pm.md`「规划与调度」第一条整条替换为：

```markdown
- 每次提出或修改计划前，先用 one_company_agent_manage action=catalog 查可用角色定义；结果的 nextCursor 不为 null 时带上它继续查，读完所有页再规划。有描述与任务对口的专业定义，就在任务里用 agent 指定并用 agentReason 简述理由；没有合适的就不填，使用默认定义。用户明确指定的定义不可用或已关闭时，不自行改用其他定义，向用户提问。
```

`role-rules/pm.md` 里"每个 worker 任务完成后进入待审查……"那一条整条替换为：

```markdown
- 规划每个 worker 任务时，看它的改动涉及哪几种技术栈：每种有开着的专项审查定义（职责为 reviewer、名字不是 reviewer 的定义），就写进任务的 reviewers，每个带一句理由（任务改了哪类文件、哪个技术栈）。执行定义（任务里 agent 指定的定义）是 <前缀>-worker 时，同栈的 <前缀>-reviewer 由程序自动挂上，不用写。
- 每个 worker 任务完成后进入待审查，用 agent_manage dispatch 带 review 派一次审查：程序同时派出通用 reviewer 和本轮要审的专项审查，全部通过任务才算完成，依赖它的任务才能派出。审查打回时核对问题，带 rework 派 worker 返修一次，返修后再派审查只会重审通用 reviewer 和上一轮打回或没交结论的专项审查；累计两轮打回即交用户裁决。
```

## 函数清单
### src/modules/agents/package-rules.ts
| 函数名 | 职责 |
|---|---|
| `RoleRulesName`（类型） | 加入 `reviewer-specialist`，让 `loadRoleRules("reviewer-specialist")` 能读到新文件 |

## 协作关系
`loadRoleRules("reviewer-specialist")` 由"派出整轮审查"计划在派专项审查时调用；本计划只保证文件存在、能读。

## 验证方式
- 测试入口：`loadRoleRules`（package-rules）
- 测试输入：`"reviewer-specialist"`、`"worker"`、`"pm"`
- 预期结果：
  - `loadRoleRules("reviewer-specialist")` 返回的文字含「只按本任务加载的 skills」「由通用审查负责，你不核对」「本次改动不涉及」「修法：」「按项目规范」；不含通用审查规矩里的条目开头「核对界面原型」「核对需求边界」「核对先红后绿」
  - `loadRoleRules("worker")` 含「skills 的写法和项目规范冲突时按项目规范」
  - `loadRoleRules("pm")` 含「nextCursor 不为 null 时带上它继续查」「写进任务的 reviewers」「由程序自动挂上」，不再含 `reviewAgent`
- [ ] 三份规矩文字与成品逐字一致
