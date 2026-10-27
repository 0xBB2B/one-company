---
name: prototype-opinion-board
description: 原型看板记下用户对等确认版本的意见，这一版仍等确认；写过意见才能重派并顶替；设计师说明改为意见
---
# 原型的意见：看板与重派

## 目标
守护进程能登记用户对等确认原型的意见（不结束这一版），并且只有用户写过意见时，主代理重派同名设计师才会顶替这一版。

## 业务规则（来源：PRD prototype-accept-with-note / confirm-window C-8、C-10、C-11、C-12）
- 登记意见：去掉首尾空白后不能为空、最长 4000 字；记为用户对这一版的意见（同一版再写一次以最后一次为准）；这一版仍在等确认，不进草稿、不作废。
- 通过或放弃这一版后，这一版的意见清掉。
- 派同名设计师时：同名有一版在等确认且用户对它写过意见 → 这一版作废（不再在途、不进草稿，文件留在本机，记下结束原因"用户提了意见后重派，这一版作废"），派出下一版，设计师拿到这一版文件位置和意见原话；在等确认但没写过意见 → 拒绝，原因"原型「<名称>」第 v 版还在等用户确认，用户没有对它提意见，不能重派"，建议"先请用户在确认窗口里处理"；设计师还在做 → 照现状拒绝。
- 新一版交稿后的确认内容里，"上一版你的意见"是重派前那一版的意见；同一版被重开时不显示它自己的意见。
- 有在途原型时拒绝批准，处理办法改为"先把它处理完（通过，或在确认窗口按 Esc 放弃），再说批准"（多份时"这 N 份"）。
- 设计师任务说明里用户原话那一行写"用户对上一版的意见原话：<原话>"；原型设计师的职责规矩写"任务说明里给出上一版文件和用户的意见时，先用 read 读上一版，按用户原话改，没提到的地方保持不变"。
- 决定只能由用户在程序窗口里登记；模型工具里没有登记入口（现状保持）。

## 涉及文件
- 修改 `src/modules/requirement/requirement-prototypes.ts`
- 修改 `src/app/daemon/method-params.ts`
- 修改 `src/modules/prototype/prototype-dispatch.ts`
- 修改 `role-rules/prototype.md`
- 修改 `tests/requirement-prototypes.test.ts`、`tests/prototype-dispatch.test.ts`、`tests/daemon-protocol.test.ts`、`tests/main-requirement-interaction.test.ts`、`tests/role-rules.test.ts`（按需）

## 函数清单
### src/modules/requirement/requirement-prototypes.ts
| 函数名 | 职责 |
|---|---|
| `PrototypeEntry`（schema） | `lastRework` 改名为 `lastOpinion`（同样是 `{ version, opinion }` 或 null） |
| `decidePrototype` | choice 的 `"rework"` 改为 `"opinion"`：校验意见，记 `lastOpinion = { version, opinion }`，`inFlight` 保持不变；accept、abandon 时清掉 `lastOpinion` 并结束这一版（现状） |
| `beginDesign` | 同名在等确认且 `lastOpinion.version` 等于它时：记 `lastEnded`、清 `inFlight`，按 `lastOpinion` 给出 `previous`；没写过意见时按上面原因拒绝；设计中照现状拒绝 |
| `pendingConfirmation` | `previousOpinion` 只在 `lastOpinion.version` 小于当前版本时给出 |
| `inFlightBlock` | 处理办法改为新措辞 |
### src/app/daemon/method-params.ts
| 位置 | 职责 |
|---|---|
| `"prototypes.decide"` 的 `choice` | 可选值改为 accept / opinion / abandon |
### src/modules/prototype/prototype-dispatch.ts
| 函数名 | 职责 |
|---|---|
| `prototypeContext` | 原话那一行改为"用户对上一版的意见原话：…" |
### role-rules/prototype.md
| 位置 | 职责 |
|---|---|
| 第 5 行 | 改为上面那句职责规矩 |

## 协作关系
扩展（plan 03 改）调 `prototypes.decide`（choice opinion）→ `decidePrototype`；主代理调 `one_company_prototype dispatch` → 守护进程 `beginDesign` → `prototypeContext` 把 `previous` 写进设计师说明。数据库版本号本分支已升到 8，尚未发布，这次字段改名不再升。

## 验证方式
- 测试入口：`decidePrototype(ref, input)`、`beginDesign(ref, input)`、`pendingConfirmation(ref, input)`、`readPrototypeBoard`、`inFlightBlock(items)`、`prototypeContext(input)`、`validateParams("prototypes.decide", …)`、读 `role-rules/prototype.md`；沿用 `tests/requirement-prototypes.test.ts` 现有的交稿准备方式。
- 测试输入：一份在等确认的"登录页"第 1 版。
- 预期结果：
- [ ] opinion "  B 方案窄屏怎么排？ " → 看板 `lastOpinion` 为 `{ version: 1, opinion: "B 方案窄屏怎么排？" }`，第 1 版仍在等确认、不进草稿；再写 "改成横向滚动" → 以它为准；空白或 4001 字被拒
- [ ] 写过意见后 beginDesign → 返回 version 2、`previous` 为第 1 版文件位置和"改成横向滚动"；第 1 版不在途、不在草稿、`lastEnded` 原因如上、文件仍在；第 2 版交稿后 `pendingConfirmation` 的 `previousOpinion` 是"改成横向滚动"
- [ ] 写意见后不重派、直接重开：`pendingConfirmation` 的 `previousOpinion` 不是第 1 版自己的意见
- [ ] 没写过意见时 beginDesign 被拒，原因"原型「登录页」第 1 版还在等用户确认，用户没有对它提意见，不能重派"；设计中照现状被拒
- [ ] 写过意见后 accept 或 abandon → `lastOpinion` 为 null
- [ ] `inFlightBlock` 一份/两份的处理办法为新措辞；`main-requirement-interaction` 里拦截批准的断言同步
- [ ] `prototypeContext` 带 previous 时含"用户对上一版的意见原话：…"；`role-rules/prototype.md` 含新的那句话
- [ ] `validateParams("prototypes.decide")` 接受 choice opinion，拒绝 rework
