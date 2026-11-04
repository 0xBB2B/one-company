---
name: 02-tech-list-format
description: 技术清单的参数格式、逐条检查、问题记录文字、回答原话文字、窗口内容和对话问答块
---
# 技术清单的格式与文字

## 目标
新增 `src/modules/interaction/tech-list.ts`，集中定义技术清单的参数、检查规则和各处用到的文字；`one_company_user_interact` 的对话问答块能显示技术清单的回答。

## 业务规则（来源：PRD 01-tech-list-window）
- 清单 1 到 12 项，每项 6 栏都必填：名称（≤80 字）、类别、来源、用途、为什么非它不可、备选为什么不选（这三栏各 ≤200 字）。
- 类别只能是：语言、框架、数据库、第三方库、中间件或外部服务、工具。来源只能是：用户点名、按项目规范或已开启的专项代理和 skill 推荐、AI 提议。
- 用途、为什么非它不可、备选为什么不选三栏不能含“我”“你”“您”，提示改用“用户”或角色词、用“AI”指主代理（和现有 ask 的人称检查同一套说法）。
- 问题记录文字 = 确认问题“上面 N 项新技术，同意引入吗？”加上各项“<编号>. <名称>（<类别>）”，合计最多 400 字（`SHORT_DECISION_LIMITS.textCodePoints`），超了提示超了多少字、建议精简名称或分两次提交。
- 每条问题都写成给模型看的中文原因：第几项、哪一栏、哪条规则；多条问题全部列出。
- 回答原话：选“全部同意”时为“全部同意引入以下新技术：”后逐行“<编号>. <名称>（<类别>）”；选“写修改意见”时就是用户输入的原文。
- 对话问答块（原型“对话里的问答块”，已确认）：第一行加粗“提问”加灰色“<需求名>（第 N 版）”；空一行；确认问题；下一行回答：全部同意写“你的回答  1. 全部同意”，修改意见写“你的回答  2. 写修改意见：<原文>”，暂不回答写“你暂不回答，清单保留。”（“你的回答  ”灰色）。

## 涉及文件
- `src/modules/interaction/tech-list.ts` 新建
- `src/modules/interaction/user-interact-tool.ts` 修改（只改渲染，参数变体在本主题 03）
- `tests/tech-list.test.ts` 新建
- `tests/user-interact-tool.test.ts` 修改

## 函数清单
### src/modules/interaction/tech-list.ts
| 函数名 | 职责 |
|---|---|
| `TECH_KINDS`、`TECH_SOURCES` | 6 种类别、3 种来源的固定文字 |
| `TechItem`、`TECH_ITEMS`（TypeBox） | 一项技术的 6 个字段与长度、取值限制；清单 1 到 12 项 |
| `techListIssues` | 逐项逐栏检查缺栏、超长、取值不对、人称字、合计 400 字，返回给模型看的中文原因数组；全部合格返回空数组 |
| `techQuestionText` | 生成确认问题“上面 N 项新技术，同意引入吗？” |
| `techRecordText` | 生成问题记录文字（确认问题 + 各项编号、名称、类别） |
| `techAgreeText` | 生成“全部同意”时的原话 |
| `techWindowQuestion` | 把清单拼成 01 里的 WindowQuestion：caption、标题、可选的“PM 拆计划时发现需要”行、分段着色的清单行、固定问题、“全部同意”的说明（主代理用和 PM 上报用两种文字，后者带任务编号）、“写修改意见”及其说明、Esc 提示与单独一行开关 |

### src/modules/interaction/user-interact-tool.ts
| 函数名 | 职责 |
|---|---|
| `askRequest` / `renderAskCall` / `renderAskResult` | 除 ask 外也认 ask-tech 动作：标题行同 ask；结果块按上面“对话问答块”三种写法显示；出错时仍显示“没有登记：<原因>” |

## 协作关系
- `techWindowQuestion` 产出的对象交给 `src/core/host/question-window.ts` 的 `techListWindow`（本主题 01）。
- `techListIssues`、`techRecordText`、`techAgreeText` 由本主题 03 的工具入口和 `MainRequirementInteraction` 调用。
- 人称检查复用 `src/modules/interaction/ask-question.ts` 里已有的规则文字，不另写一套。

## 验证方式
- 测试入口：`tech-list.ts` 的导出函数；`createUserInteractTool(...).renderCall/renderResult`（`tests/user-interact-tool.test.ts` 已有渲染测试的写法）。
- 测试输入与预期：
  - [ ] `techListIssues`：0 项、13 项各返回一条项数原因；某项缺“备选为什么不选”返回“第 N 项缺少备选为什么不选……”；名称 81 字、用途 201 字各返回超长原因并写明第几项；类别“操作系统”、来源“PM 决定”返回取值原因并列出可选值；三栏分别含“我/你/您”各返回一条写明第几项哪一栏；合计 401 字返回超了 1 字并建议精简名称或分两次提交；1 项、12 项各栏正好到上限且合计 ≤400 字返回空数组。
  - [ ] `techRecordText`、`techAgreeText` 对原型 4 项清单的输出逐字符合本文件业务规则。
  - [ ] `techWindowQuestion` 交给 01 的窗口在 80 列渲染后，与原型“新项目：4 项”“PM 拆计划时发现需要”两个画面逐行一致（后者标题下多出“PM 拆计划时发现需要 · 卡住的任务：T4 导出借阅报表”，“全部同意”说明为“写进需求的「实现」板块，你批准新版本后 PM 接着做 T4”）。
  - [ ] 对话问答块：answer 为全部同意、修改意见“后端换成 Java，数据库换成 MongoDB”、null 三种时，渲染结果与原型“对话里的问答块”三个画面一致。
