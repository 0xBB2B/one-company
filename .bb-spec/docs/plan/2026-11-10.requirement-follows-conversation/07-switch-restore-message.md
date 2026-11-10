---
name: 07-switch-restore-message
description: 换对话线后核对每个需求，变了、已批准停在批准前、恢复失败时在对话里插一条程序消息；换到有等确认原型的线时弹确认窗口
---
# 换线后说一声

## 目标
用户回退、分叉、切换、接着旧对话之后，对话最后出现一条用户和主代理都看得到的消息，说明哪些需求恢复到了哪一版；什么都没变时不插。

## 业务规则（来源：PRD 02-switch-message 全部约束；01-line-bound-draft 约束 1、8、14）
- 触发时机：pi 的 `session_tree`（两次 Esc、`/tree` 回到某一步）、`session_start` 且 reason 为 `fork`、`resume`、`startup`（`pi -c`、`pi --session` 打开旧对话时 reason 是 startup；新开空对话时线上没有锚点，自然什么都不插）、`reload` 不处理。
- 判断"变了"：对每个需求，比较换线前本窗口用的线尖锚点和换线后的线尖锚点，不同就算变了。启动时（startup、resume、fork）比较这条线上的正文落在哪次保存：线视图的 saved（线尖往上最近的保存）就是这个需求最近一次保存时不算变（线尖是接在它后面的短决定等锚点也一样），不是才算变。
- 要考虑的需求：换线后这条线上出现过锚点的需求；新线上没有它的锚点（后来的线上才新建）的需求保持不动，不写进消息。
- 已批准、正在关闭、已关闭的需求，新线尖不是批准锚点的后代（停在批准之前）时，写"已批准"一块；新线尖在批准锚点之后或线上没有它的锚点时不写。
- 恢复失败：线上最后一个锚点在库里找不到，或它的提交读不出。失败时这个需求在本窗口用最近保存的那份（03 的 `lineDraftState` 已退回），消息里写失败块。
- 消息：`pi.sendMessage({ customType: "one-company.requirement-restore", content, display: true }, { triggerTurn: false })`，插入后主代理不自动回复。
- 内容：每个需求一块，块与块之间空一行。顺序：已恢复的在前，已批准的其次，没能恢复的最后；同一种里按需求在这条线上最后一次保存的先后排（线上没保存过的排最后，再按需求标题排）。
  - 已恢复：`「<标题>」已恢复至版本 <N>`，N 是新线尖的版本号。
  - 已批准：`「<标题>」已批准，以库里的版本 <M> 为准`，M 是 requirements 行当前的版本号。
  - 没能恢复：第一行 `「<标题>」没能恢复至版本 <N>，仍是版本 <M>`，M 是退回后那份的版本号；下面三行列表依次是 `- 原因：<哪一步、为什么失败>`、`- 下一步：主代理先读取库里的内容再操作；要用回版本 <N>，让主代理照对话里的内容重新保存一次`、`- 运行日志：<主窗口这次打开的守护进程日志路径>`。原因不写错误码。N 取对话里那个锚点对应的工具结果里的版本号，取不到时写"对话里的那一版"。
  - 标题用新线上的标题。
- 换到新线后（`session_tree` 和 fork、resume、startup 三种 `session_start`），按这条线读原型看板（`prototypes.board`），取交了稿、等确认的原型，有就照现在的方式依次弹"确认原型"窗口（05 不在内存里记等待清单）。
- 换线前 pi 发 `session_before_tree` / `session_before_switch` / `session_before_fork` 时撤销本窗口已捕获的用户输入（现有的 `authorization.revoke()`），保持不变。

## 涉及文件
- 新建 `src/modules/interaction/line-switch.ts`
- 修改 `src/modules/interaction/requirement-manage-extension.ts`
- 修改 `src/modules/prototype/prototype-extension.ts`
- 新建 `tests/line-switch.test.ts`；修改 `tests/requirement-manage-session.test.ts`

## 成品定义

消息正文示例（三种混在一起）：
```
「订单导出」已恢复至版本 5

「会员积分」已批准，以库里的版本 14 为准

「消息通知」没能恢复至版本 3，仍是版本 6
- 原因：需求自己的 Git 仓库里找不到版本 3 那次保存的提交
- 下一步：主代理先读取库里的内容再操作；要用回版本 3，让主代理照对话里的内容重新保存一次
- 运行日志：~/.pi/agent/one-company/repos/<仓库>/logs/<启动编号>.log
```

## 函数清单
### src/modules/interaction/line-switch.ts
| 函数名 | 职责 |
|---|---|
| `lineSwitchReport` | 输入换线前后的线尖、各需求的生命周期、标题、版本号、失败原因，按上面的规则排出已恢复、已批准、没能恢复三组 |
| `restoreMessageText` | 把报告排成消息正文；报告为空时返回 undefined |
| `windowLineMemory` | 记住本窗口每个需求当前用的线尖，供下一次换线比较 |

### src/modules/interaction/requirement-manage-extension.ts
| 函数名 | 职责 |
|---|---|
| `session_tree` 处理 | 新：算新线、比较、插消息、更新 `windowLineMemory` |
| `session_start` 处理 | 改：startup、resume、fork 时按"最近保存"作换线前比较并插消息 |

### src/modules/prototype/prototype-extension.ts
| 函数名 | 职责 |
|---|---|
| `session_tree` 处理 | 新：按新线读原型看板，取等确认的原型并弹窗 |

## 协作关系
- `session_tree` / `session_start` → `currentLine`（03）→ 对每个需求 `lineDraftState`（03）、`resolveLineTipIn`（01）→ `lineSwitchReport` → `restoreMessageText` → `pi.sendMessage`。
- 运行日志路径：取窗口连上守护进程时 `daemon-client` 记下的日志文件路径。
- 依赖 01、03、05。

## 验证方式
- 测试入口：`lineSwitchReport`、`restoreMessageText` 纯函数；扩展的 `session_tree`、`session_start` 处理（用现有 requirement-manage-session 测试的假 pi，记录 `sendMessage` 调用）。
- 测试输入：需求「订单导出」线 A 到版本 10、线 B 截到版本 5；「会员积分」在线 A 上批准过、线 B 停在批准前；「消息通知」线 B 的最后一个锚点在库里删掉。
- 预期结果与验证项：
  - [ ] 从线 A 换到线 B，`sendMessage` 被调一次，customType 为 `one-company.requirement-restore`，`triggerTurn` 为 false，正文和成品定义的示例格式一致。
  - [ ] 只有「订单导出」变了时，正文只有一行 `「订单导出」已恢复至版本 5`。
  - [ ] 换到线尖不变的位置，不调 `sendMessage`。
  - [ ] 两个已恢复的需求按在这条线上最后保存的先后排。
  - [ ] startup 打开停在版本 5 的旧对话、库里最近保存是版本 7，插"已恢复至版本 5"；旧对话停在版本 7 时不插。
  - [ ] reason 为 reload 时不插。
  - [ ] 失败块的原因里没有错误码，日志路径指向真实存在的文件。
  - [ ] 换到有等确认原型的线后弹出"确认原型"窗口；换到没有的线不弹。
