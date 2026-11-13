---
name: 01-conflict-hint-text
description: 原型确认窗口、对话提示、design_changed 下一步建议三处 DESIGN.md 冲突文字换成新说法
---
# DESIGN.md 冲突提示文字

## 目标
DESIGN.md 冲突时，用户和主代理看到的三处文字都写清：这一版不能通过、在「其他（自己输入）」写意见、主代理会重派、新的一版还要再确认。

## 业务规则（来源：PRD 01-conflict-hint）
- C-1：打开原型确认窗口时 DESIGN.md 冲突（设计状态为 conflict）→ 窗口的冲突提示行逐字是：
  `设计师交稿后 DESIGN.md 被改过，这一版不能通过。想继续，请在「其他（自己输入）」里写意见，主代理会按最新的 DESIGN.md 重派一版，新的一版还要再确认一次。`
- C-2：用户选通过后、写入前才发现 DESIGN.md 冲突（守护进程返回 design_changed）→ 对话里给主代理的提示逐字是：
  `原型「<名称>」第 <N> 版没有通过：DESIGN.md 在你确认时被改过。在窗口里选「其他（自己输入）」写意见，主代理会按最新的 DESIGN.md 重派一版，新的一版还要再确认一次；可以用 one_company_prototype confirm 重开确认窗口。`
- C-3：同 C-2 的情况 → design_changed 报错的下一步建议逐字是：
  `在窗口里选「其他（自己输入）」写意见，主代理会按最新的 DESIGN.md 重派一版，新的一版还要再确认一次`；原因不变，仍是 `DESIGN.md 在你确认时被改过，这一版没有通过`。
- 不变：冲突判断方法、"通过"和各方案选项在冲突时选不了、选项后面的灰字"设计师交稿后 DESIGN.md 被改过，这一版不能通过"、「其他（自己输入）」一行的名字。
- 决策：去掉旧文字里的"仓库根目录的"，因为比较的可能是对话线上的 DESIGN.md；"要通过"会让用户以为写意见这一版就能通过，改成先说不能通过。

## 涉及文件
- 修改 `src/modules/prototype/prototype-windows.ts`
- 修改 `src/modules/prototype/prototype-extension.ts`
- 修改 `src/modules/requirement/requirement-prototypes.ts`
- 修改 `tests/prototype-windows.test.ts`
- 修改 `tests/requirement-prototypes.test.ts`

## 函数清单
### src/modules/prototype/prototype-windows.ts
| 函数名 | 职责 |
|---|---|
| `designLines` | conflict 分支返回 C-1 的文字 |
### src/modules/prototype/prototype-extension.ts
| 函数名 | 职责 |
|---|---|
| `confirmPrototypeFlow` | 收到 design_changed 时，对话提示用 C-2 的文字 |
### src/modules/requirement/requirement-prototypes.ts
| 函数名 | 职责 |
|---|---|
| `decidePrototype` | 通过时发现冲突，design_changed 的下一步建议用 C-3 的文字 |

## 协作关系
`confirmWindowContent` 调 `designLines` 生成窗口内容；`confirmPrototypeFlow` 调守护进程的 `prototypes.decide`，后者由 `decidePrototype` 处理，冲突时抛 design_changed，`confirmPrototypeFlow` 收到后发对话提示。无外部依赖。

## 验证方式
- 测试入口：`pnpm vitest run tests/prototype-windows.test.ts tests/requirement-prototypes.test.ts`
- 测试输入 / 预期结果：
  - [ ] C-1：`confirmWindowContent` 传入设计状态为 conflict 的待确认原型 → `lines` 里冲突提示行逐字等于 C-1。
  - [ ] C-2：确认流程中守护进程返回 design_changed（advice.next 为 C-3 文字），原型「设置页」第 2 版 → 对话里 `one-company.prototype-design-changed` 消息逐字等于 C-2 的文字。
  - [ ] C-3：样例项目里原型等确认，打开窗口后、通过前改根目录 DESIGN.md，再调 `decidePrototype` 选 accept → 错误码 design_changed，advice.next 逐字等于 C-3，advice.why 不变。
- 全量：`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 通过。
