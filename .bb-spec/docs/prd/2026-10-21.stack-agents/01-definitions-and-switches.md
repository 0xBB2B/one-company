---
name: definitions-and-switches
description: 内置 12 个专项定义；除 5 个通用定义外每个角色定义能在设置页按空格单独开关，默认开启；关闭的定义 PM 选不到
date: 2026-10-21
---

# 专项定义与定义开关

几个词先说清：
- 角色定义：一份描述可派工子代理的文件，写明名称、描述、职责、模型、思考等级、预设的 skills、mcp 和正文；分内置、用户、项目三层，同名时上层替换下层。
- 通用定义：内置的 worker、reviewer、qa、explore、prototype 这 5 个，流程离不开它们。
- 专项定义：本需求新增的 12 个内置定义，按技术栈分，每栈一个专项 worker（名字 `<栈>-worker`）和一个专项审查（名字 `<栈>-reviewer`），同栈的两个预设同一组 skill。
- 定义开关：除通用定义外，每个角色定义都有的开启 / 关闭状态，默认开启；关闭的定义 PM 选不到。
- 设置文件：pi 的设置文件，用户层在 `~/.pi/agent/settings.json`，项目层在项目里的 `.pi/settings.json`；one-company 的设定都写在其中的 one-company 字段下。用户层对所有项目生效；项目层只对当前项目生效，项目在 pi 里受信任才生效。

## 用户故事
### P0：作为用 Go 写后端的用户，我想要 PM 派懂 Go 的 worker 和审查，以便写出来的代码按 Go 的规范、避开 Go 常见的坑
**用例（主路径）**
- 场景：用户第一次装好 OneCompany，没有任何设置文件，项目是 Go 后端。
- 操作：打开 /one:setting → 角色定义 › worker，选中 go-worker 按回车展开。
- 预期：列表里有 go-worker，状态绿色「开启」；详情里「开关」写「开启 · 默认值 · 切换后全局生效」，「审查」写「用了它的任务自动加 go-reviewer」，skills 列出 go-coding、go-pitfalls、web-api-security、auth-session、supply-chain、relational-db、redis、message-queue、service-runtime，正文写「已写」。

### P0：作为不写 Python 的用户，我想要关掉 python-worker，以便 PM 不会选到它
**用例（主路径）**
- 场景：用户只写 Go 和 Vue。
- 操作：在角色定义 › worker 里选中 python-worker，按空格。
- 预期：这一行名字灰显、状态变成灰色「关闭」；底部绿字「已关闭 python-worker · 全局生效」；用户设置文件的 one-company 字段下写入 `"disabled-agents": ["python-worker"]`，文件里其他内容不变；之后 PM 查可用定义时看不到 python-worker。

**用例（边界：在通用定义上按空格）**
- 场景：用户想关掉 reviewer。
- 操作：选中 reviewer 按空格。
- 预期：什么都不写，底部黄字「reviewer 是通用定义，流程离不开它，不能关闭」。

**用例（边界：项目自己写的定义）**
- 场景：项目里有自己写的 `.pi/agents/acme-worker.md`，项目受信任。
- 操作：选中 acme-worker 按空格。
- 预期：项目设置文件写入 `"disabled-agents": ["acme-worker"]`，底部「已关闭 acme-worker · 本项目生效」；用户设置文件不变。

**用例（异常：PM 用了一个已被关掉的 worker）**
- 场景：计划里 T3 指定了 python-worker，派出前用户把它关了。
- 操作：PM 派 T3。
- 预期：派工被拒，原因写「python-worker 已关闭」；PM 改计划换成开着的定义或不指定（用通用 worker）后再派；如果是用户点名要 python-worker，PM 先问用户。

## 约束
- C-1：包里的 `agents/` 新增 12 份定义，名字、职责和预设 skills 如下（skills 按这个顺序写）：

  | 名字 | 职责 | skills |
  |---|---|---|
  | go-worker、go-reviewer | worker、reviewer | go-coding、go-pitfalls、web-api-security、auth-session、supply-chain、relational-db、redis、message-queue、service-runtime |
  | node-worker、node-reviewer | worker、reviewer | typescript-coding、node-pitfalls、web-api-security、auth-session、supply-chain、relational-db、redis、message-queue、service-runtime |
  | python-worker、python-reviewer | worker、reviewer | python-coding、python-pitfalls、web-api-security、auth-session、supply-chain、relational-db、redis、message-queue、service-runtime |
  | java-worker、java-reviewer | worker、reviewer | java-coding、java-pitfalls、web-api-security、auth-session、supply-chain、relational-db、redis、message-queue、service-runtime |
  | vue-worker、vue-reviewer | worker、reviewer | typescript-coding、vue-coding、vue-pitfalls、web-api-security、auth-session、supply-chain |
  | react-worker、react-reviewer | worker、reviewer | typescript-coding、react-coding、react-pitfalls、web-api-security、auth-session、supply-chain |

  每份定义的描述写明它写或审哪种代码（如"写 Go 后端代码，按 Go 编码规范和排查清单写"），PM 靠描述挑选；正文不为空，写明这个代理的作用和专攻的技术栈；不写模型和思考等级（跟随主会话）。这 12 份定义在内置层加载时都有效，「问题」里没有它们。
- C-2：worker 职责和专项审查的职责规矩里都有一条：预设 skill 的写法和项目规范（项目根的 AGENTS.md）冲突时，按项目规范来；"违反 skill 但符合项目规范"不算问题。
- C-3：角色定义列表的右栏表头是「名称  来源  状态  模型  思考」。状态有三种值：通用定义写「必须」（灰字）；开启写「开启」（绿字）；关闭写「关闭」（灰字），并且名字也灰显。右栏放不下全部列时，先去掉「思考」列，状态列始终保留；任何宽度下一行都不超出终端。
- C-4：开关存在设置文件 one-company 字段下的 `"disabled-agents"`，值是被关闭的定义名列表，只记关闭的。一个定义只要出现在用户层列表里，或出现在受信任项目的项目层列表里，就是关闭；两层都没有就是开启。
- C-5：在非通用定义上按空格，直接切换开关，不弹确认：
  - 写到定义文件所在的那一层：内置定义和用户层定义写用户层设置文件，项目层定义写项目层设置文件。关闭 = 把名字加进这一层的列表；开启 = 从这一层的列表里删掉这个名字，列表空了就删掉 `"disabled-agents"` 这个键。文件里其他内容保持原样。
  - 切换后这一行立即按新状态显示，底部绿字写「已开启 <名字> · 全局生效」或「已关闭 <名字> · 全局生效」，写到项目层时把「全局生效」换成「本项目生效」。
  - 开启后另一层的列表里仍有这个名字（手改过设置文件）时，这一行仍显示「关闭」，底部黄字写「<名字> 仍是关闭：<用户层或项目层>设置文件里也写了关闭」。
  - 写文件失败时什么都不改，底部红字写「✗ 没有保存：<原因>」。
- C-6：在通用定义上按空格不写任何文件，底部黄字写「<名字> 是通用定义，流程离不开它，不能关闭」。
- C-7：角色定义列表的操作提示是「←/Esc 回左栏  ↑↓ 选择  回车 详情  空格 开关  C 复制」，展开时「详情」换成「收起」。
- C-8：展开详情时，非通用定义在「说明」下面多两行：
  - 「开关」：开启时写「开启 · 默认值 · 切换后<全局生效或本项目生效>」（绿字）；关闭时写「关闭 · 来自<用户层或项目层>」（灰字）。
  - 「审查」：只有名字是 `<前缀>-worker` 且存在名为 `<前缀>-reviewer` 的定义时才有这一行，写「用了它的任务自动加 <前缀>-reviewer」。
- C-9：`"disabled-agents"` 写错时这一层的这一项整体不生效，并在「问题」里列一条：不是字符串列表时短原因写「disabled-agents 只能写定义名列表」；列表里有通用定义名时写「<名字> 是通用定义，不能关闭」，忽略这个名字；列表里有不存在的定义名时写「没有叫 <名字> 的角色定义」，忽略这个名字。one-company 字段的允许键清单里加上 disabled-agents，「不认识的设定」那条提示列出的允许键也跟着加上。
- C-10：项目未受信任时，项目层的定义不加载（现有规则），项目层的 `"disabled-agents"` 也不生效。
- C-11：关闭的定义不出现在 PM 查到的可用定义清单里。计划里任务的执行定义或专项审查用了已关闭的定义时，计划提交被拒，原因写「<名字> 已关闭」。派 worker 时它指定的定义已被关闭，派工被拒，原因写「<名字> 已关闭」，建议写「改用开着的定义，或不指定（用通用 <职责>）后重新派；用户点名要这个定义时先问用户」，<职责> 是被拒定义的职责（派 worker 时写 worker，派原型设计师时写 prototype）。
- C-12：PM 的规矩写明：查可用定义时，返回结果还有下一页就继续翻，读完所有页再规划。

## 验收
- [ ] AC-1 ← C-1：包内定义目录里有 C-1 表格里的 12 份文件，每份的职责、skills 和表格一致，描述和正文都不为空、都写了技术栈；没有任何设置文件时设置页的「问题」分类不出现。
- [ ] AC-2 ← C-2：go-worker 和 go-reviewer 派出时，提示词的职责规矩部分都包含"skill 与项目规范冲突时按项目规范"这条。
- [ ] AC-3 ← C-3：80 列下 worker 分类表头是「名称  来源  状态  模型  思考」，worker 行状态是「必须」，go-worker 是绿色「开启」；关掉 python-worker 后它的名字和状态都是灰的。36 列下进入右栏，表头没有「思考」、有「状态」，所有行都不超过 36 列。
- [ ] AC-4 ← C-4、C-10：用户层写 `["go-worker"]` 时 go-worker 关闭；只在受信任项目的项目层写 `["go-worker"]` 时也关闭；项目改为未受信任后它变回开启。
- [ ] AC-5 ← C-5：在 go-worker 上按空格 → 用户设置文件 one-company 下 `"disabled-agents"` 是 `["go-worker"]`，原有其他内容不变，底部是「已关闭 go-worker · 全局生效」；再按一次 → 这个键被删掉，底部是「已开启 go-worker · 全局生效」。在项目层定义 acme-worker 上按空格 → 只写项目层设置文件，底部是「已关闭 acme-worker · 本项目生效」。
- [ ] AC-6 ← C-5：项目层手写 `["go-worker"]`、用户层没写时，在 go-worker 上按空格开启 → 用户设置文件不新增内容，这一行仍是「关闭」，底部黄字是「go-worker 仍是关闭：项目层设置文件里也写了关闭」。用户设置文件只读时按空格 → 底部红字以「✗ 没有保存：」开头，显示不变。
- [ ] AC-7 ← C-6、C-7：在 reviewer 上按空格，两层设置文件都不变，底部是「reviewer 是通用定义，流程离不开它，不能关闭」；角色定义列表的操作提示是 C-7 的原文。
- [ ] AC-8 ← C-8：展开 go-worker，「开关」是「开启 · 默认值 · 切换后全局生效」，「审查」是「用了它的任务自动加 go-reviewer」；展开 acme-worker（没有 acme-reviewer）时没有「审查」这一行；关掉 go-worker 后展开，「开关」是「关闭 · 来自用户层」。
- [ ] AC-9 ← C-9：用户层写 `"disabled-agents": "go-worker"` 时「问题」里有「disabled-agents 只能写定义名列表」；写 `["reviewer", "nope"]` 时「问题」里有「reviewer 是通用定义，不能关闭」和「没有叫 nope 的角色定义」，reviewer 状态仍是「必须」；「不认识的设定」的提示里列出 disabled-agents。
- [ ] AC-10 ← C-11：关掉 python-worker 后，PM 查到的可用定义里没有它；提交指定 python-worker 的计划被拒，原因含「python-worker 已关闭」；计划确认后再关掉它，派这个任务被拒，原因和建议是 C-11 的原文。
- [ ] AC-11 ← C-12：PM 的职责规矩里有"可用定义有下一页就继续翻、读完所有页"这一条。

## 验证路径
1. 没有设置文件时打开 /one:setting，看 worker、reviewer 两个分类的列表、表头和「问题」（AC-1、AC-3）。
2. 展开 go-worker、acme-worker 看详情（AC-8）。
3. 在 go-worker、acme-worker、reviewer 上按空格，读两层设置文件、看底部提示（AC-5、AC-7）；手改项目层后再按（AC-6）。
4. 两层分别手写列表、切换项目受信任（AC-4）；写错格式和名字后重开看「问题」（AC-9）。
5. 把终端拉到 36 列看表格（AC-3）。
6. 关掉 python-worker 后让 PM 规划和派工（AC-10）；读 PM 和专项代理的提示词（AC-2、AC-11）。
