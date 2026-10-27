---
name: prototype-opinion-window
description: 确认原型窗口第 3 项改为其他（自己输入），写下的话登记为意见并交主代理回复，这一版仍等确认
---
# 确认原型窗口的「其他」

## 目标
确认原型窗口第 3 项显示"其他（自己输入）"；用户写的话登记为意见，绿字说明这一版仍在等确认，主代理收到原话并接着回复。

## 业务规则（来源：PRD prototype-accept-with-note / confirm-window C-1、C-8）
- 选项依次"通过（写进需求草稿）""通过并补充说明（自己输入）""其他（自己输入）"；不在输入行时提示"↑↓ 选择 · 回车确认 · Esc 放弃这一版"，在输入行时"直接输入 · 回车确认 · Shift+Enter 换行 · ↑↓ 选择 · Esc 放弃这一版"。窗口其他行保持现状。
- 在"其他"写字回车：守护进程登记 choice opinion（opinion 为原话，note 为 null）；绿字"已登记：你对原型「<名称>」第 v 版的意见已原话交给主代理，这一版仍在等你确认。"；给主代理发消息并触发回复，内容依次为："用户对原型「<名称>」第 v 版提了意见，这一版仍在等用户确认。"、"文件：<这一版文件位置>"、"用户原话："、<原话>、"如果是提问，先回答，再用 one_company_prototype confirm 重开这份原型的确认窗口；如果要修改，用 one_company_prototype dispatch 重派设计师，设计师会拿到这一版文件和这段原话，重派后这一版作废。"（每段一行）。
- 通过、通过并补充说明、Esc 放弃、中断、没有界面、文件被改过的处理保持现状。

## 涉及文件
- 修改 `src/modules/prototype/prototype-windows.ts`
- 修改 `src/modules/prototype/prototype-extension.ts`
- 修改 `tests/prototype-windows.test.ts`

## 函数清单
### src/modules/prototype/prototype-windows.ts
| 函数名 | 职责 |
|---|---|
| `REWORK_LABEL` | 删除；`confirmWindowContent` 不再传 `otherLabel`，用窗口默认的"其他（自己输入）" |
| `PrototypeRecord` / `decisionEntryText` | `rework` 记录改为 `opinion`，绿字改为上面那句 |
### src/modules/prototype/prototype-extension.ts
| 函数名 | 职责 |
|---|---|
| `confirmPrototypeFlow` | "其他"的文字映射为 choice opinion；登记后用 `tell`（触发回复）发上面的消息；返回 decided |

## 协作关系
依赖 plan 01（`chooseOrWriteWindow` 的 `otherLabel` 可不传、新提示文字）和 plan 02（`prototypes.decide` 接收 choice opinion）。

## 验证方式
- 测试入口：`tests/prototype-windows.test.ts` 现有 harness（`emit("prototype.submitted")`、`run({ action: "confirm" })`、`called("prototypes.decide")`、`appendEntry`、`sendMessage`）。注意窗口组件构造现在需要 `tui`，harness 里的 `custom` 已把 `tui` 传给工厂。
- 测试输入：待确认的"设置页"第 2 版。
- 预期结果：
- [ ] `CONFIRM_FRAME` 第 3 项是"   其他（自己输入）"；在输入行上的提示含"Shift+Enter 换行"
- [ ] 在"其他"空回车不调用 decide；输入"B 方案窄屏怎么排？"回车 → decide 参数 `choice: "opinion", opinion: "B 方案窄屏怎么排？", note: null`；绿字如上；`sendMessage` 1 次，content 按上面各段用换行连接（含文件位置），选项 `{ triggerTurn: true }`
- [ ] 通过、通过并补充说明、Esc、中断、文件被改过的现有用例照常通过
