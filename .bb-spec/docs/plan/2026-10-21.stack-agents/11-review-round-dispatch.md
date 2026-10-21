---
name: review-round-dispatch
description: PM 派一次审查时同时派出通用和专项审查代理，专项用专项规矩；打回意见合并并标来源；整轮结束给 PM 发一条按代理分段的结果
---
# 派出整轮审查

## 目标
PM 派一次审查，守护进程按本轮名单同时启动多个审查会话；被关闭或已删除的专项审查跳过并记下；返修时 worker 看到本轮所有打回意见和来源；PM 在整轮结束时收到一条汇总。

## 业务规则（来源：PRD multi-review C-3～C-7、C-10）
- PM 派一次审查（带一个轮数上限），程序同时派出通用审查和本轮要审的全部专项审查，每个用这次给的轮数上限；PM 不能单独派某一个审查代理。
- 本轮名单里的专项审查：已关闭 → 不派，记「<名字> 已关闭，本轮未审」；目录里已不存在 → 不派，记「<名字> 已不存在，本轮未审」。通用 reviewer 或专项审查遇到其他解析错误（skill 缺失、模型不可用等）→ 整次派审查被拒，不建任何运行（和现在一样，不悄悄换）。
- 通用 reviewer 用现有 `role-rules/reviewer.md`；专项审查（职责 reviewer、名字不是通用定义）用 `role-rules/reviewer-specialist.md`。两者的任务说明都用现有 `reviewContext`，并按定义拼上预设 skills。
- 返修时 worker 收到的意见合并本轮所有打回的审查代理的阻塞和未验证意见，每条注明来自哪个代理。
- 交给 PM 的每轮审查结果按代理分开：名字、结论（通过 / 打回 / 未验证 / 没交出结论的结局）、summary、分级问题数；被跳过的写跳过原因；连同任务新状态和下一步建议，一轮只发一条，在整轮判定后发出。

## 涉及文件
- 修改 `src/app/daemon/run-manager.ts`
- 修改 `src/app/daemon/pm-tools.ts`（agent_manage 工具描述 :144 改成"带 review 派一次审查，程序同时派出通用和专项审查"）
- 修改 `tests/task-dispatch.test.ts`、`tests/agent-selection.test.ts`、`tests/role-rules.test.ts`（:167-200 审查上下文用例）

## 函数清单
### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `dispatchTask`（改，:433 起的审查分支） | 用 `reviewRoundMembers` 取本轮名单；逐个调用私有 `resolveAgent`，`agent_disabled` 记跳过 `disabled`，目录里找不到记跳过 `missing`，其他错误整次拒绝；调用 `beginTaskReview` 一次登记整轮；为每个要派的代理建运行记录（`agent` 指纹、`task`）和会话；某个会话创建失败只把这一个代理记为 failed，不影响同轮其他代理 |
| `reviewRulesFor` | 按定义名返回 `loadRoleRules("reviewer")` 或 `loadRoleRules("reviewer-specialist")`（用 `isGenericDefinition`） |
| `rejectedFindings`（改，:533） | 取最近一轮所有打回的代理的结论，合并其中阻塞和未验证的意见，每条带代理名 |
| `taskContext`（改，:118） | 返修说明每条写成「- [kind] <代理名> · targetRef：trigger → impact」 |
| `finishSubagent`（改，:553-600 的审查部分） | 每个审查会话结束时调 `finishTaskReview`；本轮还没判定时不给 PM 发消息；判定后发一条汇总（`reviewRoundReport`） |
| `reviewRoundReport` | 组装整轮汇总文字：任务、轮次、任务新状态、按代理分段的结论或跳过原因、下一步建议、各运行日志路径 |

## 协作关系
依赖"整轮审查的状态流转"计划的 `reviewRoundMembers`、`beginTaskReview`、`finishTaskReview`、`latestRound`；"职责规矩文字"计划的 `reviewer-specialist` 规矩；"可用定义清单与派工拦截"计划的 `agent_disabled`；"内置专项定义"计划的 `isGenericDefinition`。会话由 `createAgentRoleSession` 创建，skills 由 `withSkills` 拼接，都不改。

## 验证方式
- 测试入口：`createPmRunWorld`（`tests/helpers/run-manager-fixture.ts`）+ `w.manager.dispatchTask({ pmRunId, taskId, retry: null, review: { maxTurns } })`；`tests/agent-selection.test.ts` 的 `define(...)` 在用户层写 go-reviewer、vue-reviewer 定义（skills 为空列表，避免依赖 skill 文件）
- 注意：多个审查并行时用 `w.provider.awaitReply(request)` 按 `request.systemPrompt` 开头的定义正文区分请求；不要往 `queue` 里按顺序塞回复
- 预期结果：
  - 任务 reviewers 为 go-reviewer、vue-reviewer，派审查（maxTurns 12）→ 同时出现三个运行，`agent.name` 分别为 reviewer、go-reviewer、vue-reviewer，任务记录三条审查的 maxTurns 都是 12
  - go-reviewer 会话的系统提示词含 reviewer-specialist 规矩的「只按本任务加载的 skills」，reviewer 会话含通用规矩的「核对先红后绿」
  - 派之前关掉 go-reviewer → 只启动两个运行，任务记录里 go-reviewer 为 skipped（disabled）；PM 收到的汇总含「go-reviewer 已关闭，本轮未审」
  - 删掉 vue-reviewer 定义文件后派 → 记 skipped（missing），汇总含「vue-reviewer 已不存在，本轮未审」
  - 通用 reviewer 的模型不可用 → 整次被拒，没有新运行记录
  - 三个中只有前两个结束时，PM 没收到审查消息；第三个结束后收到一条，按代理分三段
  - go-reviewer 打回、vue-reviewer 打回，PM 派返修 → worker 的任务说明里两条意见分别带「go-reviewer ·」「vue-reviewer ·」
  - skill 覆盖（PRD skills-and-acceptance C-6：用户在项目 `.pi/skills/<名字>/` 放同名 skill 时用项目那份，现有查找顺序）：`skillDirs` 依次为项目 `.pi/skills`、包内 `skills/`，项目里放一份内容带标记文字的 `go-pitfalls/SKILL.md`，go-reviewer 的 skills 含 go-pitfalls → 派出后它的系统提示词里拼进的是带标记的那份
- [ ] 全量 `pnpm test`、`pnpm run test:integration`、`pnpm run typecheck` 通过
