---
name: design-confirm-write
description: "确认原型"窗口显示 DESIGN.md 会怎么变，交稿后被改过时不能通过；通过时把 DESIGN.md 写进仓库根目录
---
# 确认窗口的 DESIGN.md 提示和通过时写入

## 目标
"确认原型"窗口告诉用户通过后 DESIGN.md 会新建、改哪几章或不变；设计师读过之后仓库里的 DESIGN.md 被改了就拦住通过；用户通过时程序把对应那份写到仓库根目录，不提交。

## 业务规则（来源：PRD design-spec-file C-11、C-12、C-13）
- 守护进程算"DESIGN.md 状态"（给窗口用）：读仓库根目录 `DESIGN.md` 当前内容（没有为 `null`），算指纹；
  - 当前指纹和 `inFlight.designBase` 不同（含一边是 `null`）→ `conflict`；
  - 否则根目录没有文件 → `created`；
  - 否则逐份读候选文件（指纹不符按"文件在交稿后被改过"作废这一版，和原型文件同样处理），用 `changedChapters` 比较（它已把十章、新加或删掉的章、"开头的说明"都算上，只调换章的顺序算不变）：所有份都返回空 → `same`；否则 `changed`，附每份的方案字母（一份时 `null`）和变化的章名。
- 窗口在"设计师的说明"那一行之后、按状态加一行普通颜色（不设灰色 tone）的文字：
  - `created`："通过后在仓库根目录新建 DESIGN.md，之后的原型、实现和审查都照它做。"
  - `changed` 且一份："通过后同时更新仓库根目录的 DESIGN.md：改了<章名用顿号连接><中文数字>章。"，例"改了颜色、组件两章。"
  - `changed` 且每方案一份："通过后同时更新仓库根目录的 DESIGN.md："，下一行开头缩进两格"方案 A 改了颜色、组件两章；方案 B 改了颜色一章；方案 C 不变。"
  - `same`：不加行。
  - `conflict`：加"设计师交稿后，仓库根目录的 DESIGN.md 被改过。要通过，请在「其他」里写意见，让主代理按最新的 DESIGN.md 重派一版。"；"通过（写进需求草稿）"和每个"方案 X：名称"选项都设 `disabled`，原因"设计师交稿后 DESIGN.md 被改过，这一版不能通过"；"其他"和 Esc 不变。
  - 中文数字：1–10 写"一、两、三、四、五、六、七、八、九、十"。
- 通过（`choice: "accept"`）时，守护进程在登记前：再读一次根目录 DESIGN.md，指纹和 `designBase` 不同就退回，码 `design_changed`，原因"DESIGN.md 在你确认时被改过，这一版没有通过"，下一步"在窗口里选「其他」写意见，让主代理按最新的 DESIGN.md 重派一版"，原型仍在等确认、不写文件；相同就取对应的那份（一份时取它，每方案一份时按选的方案字母取），校验候选文件指纹，根目录没有文件、或 `changedChapters` 和根目录比较不为空时才用 `writeFileAtomic(..., { followSymlink: true })` 写到 `<repositoryRoot>/DESIGN.md`，然后照原逻辑登记通过。不提交 git。选"其他"或 Esc 放弃时不读写 DESIGN.md。
- 主窗口收到 `design_changed` 时，用 `ctx.ui.notify(..., "warning")` 显示"DESIGN.md 在你确认时被改过，这一版没有通过"，并发一条对话消息（`one-company.prototype-design-changed`）："原型「<名称>」第 <N> 版没有通过：DESIGN.md 在你确认时被改过。在窗口里选「其他」写意见，让主代理按最新的 DESIGN.md 重派一版；可以用 one_company_prototype confirm 重开确认窗口。"
- `prototypes.pending` 的返回新增 `design` 字段，窗口和守护进程的通信变了：`PROTOCOL_VERSION` 从 7 升到 8。`prototypes.decide` 的参数不变。

## 涉及文件
- 修改 `src/modules/requirement/requirement-prototypes.ts`（`pendingConfirmation`、`decidePrototype`）
- 修改 `src/modules/prototype/prototype-windows.ts`
- 修改 `src/modules/prototype/prototype-extension.ts`
- 修改 `src/app/daemon/run-manager.ts`（`prototypePending`、`prototypeDecide` 传 `repositoryRoot`）
- 修改 `src/core/host/protocol.ts`
- 修改 `tests/prototype-windows.test.ts`、`tests/requirement-prototypes.test.ts`、`tests/daemon-protocol.test.ts` 等相关测试

## 成品定义
`pendingConfirmation` 返回里新增的字段形状（`PendingPrototype` 同步加）：

```ts
design:
  | { state: "created" | "same" | "conflict" }
  | { state: "changed"; changes: Array<{ letter: "A" | "B" | "C" | "D" | "E" | "F" | null; chapters: string[] }> };
```

```ts
export const PROTOCOL_VERSION = 8;
```

## 函数清单
### src/modules/requirement/requirement-prototypes.ts
| 函数名 | 职责 |
|---|---|
| `designState` | 新增：按规则算 `created / changed / same / conflict` |
| `pendingConfirmation` | 改：入参多 `repositoryRoot`，返回带 `design` |
| `decidePrototype` | 改：入参多 `repositoryRoot`；通过时按规则复核指纹、写 DESIGN.md，再登记 |
### src/modules/prototype/prototype-windows.ts
| 函数名 | 职责 |
|---|---|
| `designLines` | 新增：按 `design` 生成窗口里要加的行 |
| `chapterCountText` | 新增：1–10 转"一…十" |
| `confirmWindowContent` | 改：插入 `designLines`；`conflict` 时通过类选项设 `disabled` |
### src/modules/prototype/prototype-extension.ts
| 函数名 | 职责 |
|---|---|
| `confirmPrototypeFlow` | 改：`design_changed` 时提示并发对话消息 |
### src/app/daemon/run-manager.ts
| 函数名 | 职责 |
|---|---|
| `prototypePending`、`prototypeDecide` | 传 `this.options.repositoryRoot` |

## 协作关系
窗口经 `prototypes.pending` 拿 `design`，经 `prototypes.decide` 提交；守护进程用 `changedChapters`（design-spec.ts）比较、`writeFileAtomic`（`core/storage/store.ts`）写入。依赖 plan design-submit-dispatch 存下的 `designBase`、`designs` 和候选文件。

## 验证方式
- 测试入口：`pendingConfirmation`、`decidePrototype`、`confirmWindowContent`、`chapterCountText`、`confirmPrototypeFlow`（用现有测试里的假客户端和假窗口）。
- 测试输入：临时仓库根目录分别为没有 DESIGN.md、有且相同、有且组件章不同；两个方案每方案一份；交稿后改动根目录 DESIGN.md。
- 预期结果：
- [ ] 四种状态各自算对；`changed` 的章名顺序与 `changedChapters` 一致；只加了 `## 图表` 时窗口写"改了图表一章"；只改开头时写"改了开头的说明一章"；根目录是 `\r\n`、交的是同内容 `\n` 时为 `same`
- [ ] 窗口文字逐字与规则一致，新加的行没有 `tone: "muted"`；`same` 时行数和改动前相同
- [ ] `conflict` 时通过类选项都带那句 `disabled`，"其他"可用
- [ ] 通过后根目录 DESIGN.md 等于交的那份；两方案选 B 时等于 B 那份；`same` 时文件修改时间不变；选"其他"、放弃后文件不变；仓库 `git status` 显示未提交改动
- [ ] 打开窗口后、通过前改了根目录 DESIGN.md：`decidePrototype` 抛 `design_changed`，看板仍 `awaiting`，DESIGN.md 保持被改后的内容；主窗口显示提示并发出那条对话消息
- [ ] `PROTOCOL_VERSION === 8`
