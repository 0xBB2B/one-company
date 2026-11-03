---
name: 03-homepage
description: 新建单页项目主页：深色控制室风格，中英双语，能复制安装命令，手机上可用
date: 2026-11-03
---

# 项目主页

## 用户故事

### P0：作为第一次听说 OneCompany 的开发者，我想要打开主页就看懂它做什么，以便决定要不要装

**用例（主路径）**
- 场景：浏览器语言是中文的开发者点开主页链接。
- 操作：看首屏，然后往下滚动看流程、治理和团队。
- 预期：页面是中文。首屏能看到标题、一句话介绍、安装命令和状态面板；往下能看到七步流程，其中三步用琥珀色标出。

### P0：作为想试用的开发者，我想要一键复制安装命令，以便马上装上

**用例（主路径）**
- 场景：开发者决定试用。
- 操作：点安装命令旁边的"复制"。
- 预期：按钮文字变成"已复制"，约 2 秒后恢复；粘贴得到 `pi install git:github.com/0xBB2B/one-company`。

**用例（异常）**
- 场景：浏览器不允许写入剪贴板。
- 操作：点"复制"。
- 预期：命令文字被选中，访客可以手动复制；按钮文字不变成"已复制"。

### P0：作为不懂中文的开发者，我想要看英文版，并提前知道产品界面是中文，以便不被误导

**用例（主路径）**
- 场景：浏览器语言是英文的开发者打开主页。
- 操作：看首屏和"现在的状态"。
- 预期：页面是英文；状态面板的说明和"现在的状态"都写明产品界面目前是中文。

**用例（边界）**
- 场景：浏览器语言是中文的访客点了 EN，然后关掉页面，第二天再打开。
- 操作：打开主页。
- 预期：页面是英文。

### P1：作为用手机看链接的访客，我想要页面在手机上能正常读，以便不用横着滑

**用例（主路径）**
- 场景：访客在 390 像素宽的手机上打开主页。
- 操作：从上往下滚动。
- 预期：所有内容单列显示，七步流程变成竖排，整页没有横向滚动；状态面板和安装命令太长时在自己的框里横向滑动。

## 约束

### 文件和页面形式

- 主页只有一个页面，入口是 `site/index.html`，样式和脚本都写在这个文件里。
- 页面不用前端框架，不加新依赖，不加载任何外部字体、脚本或样式。
- 字体用系统字体：中文和英文正文用系统无衬线字体，命令和角色名用系统等宽字体。
- 页面标题（浏览器标签上的文字）中文是 `OneCompany：一个人，撑起一家有规矩的 AI 公司`，英文是 `OneCompany: One human. A governed autonomous company.`
- 页面的 `lang` 属性随当前语言变化：中文是 `zh-CN`，英文是 `en`。
- 页面没有加载中和空数据状态，内容全部写在页面里。

### 配色

- 背景 `#080b12`，隔行区块背景 `#0b0f19`，卡片背景 `#0e1320`，分隔线 `#1e2738`，正文 `#e9edf5`，次要文字 `#8f9bb0`，蓝色强调 `#7cb0ff`，琥珀色 `#ffbf66`。
- 琥珀色只用在两类地方：只有用户能做的步骤，以及状态面板里的 ⚑ 待处理行和"已复制"按钮。

### 页面结构

从上到下依次是：

1. **顶部栏**：左边是 OneCompany 字样；右边是四个导航项、GitHub 链接和语言按钮。四个导航项点击后平滑滚动到对应区块：工作方式→流程区块，治理→治理区块，团队→团队区块，开始→开始区块。
2. **首屏**：内容居中，依次是小字标签、大标题、介绍、安装命令框和"在 GitHub 上查看"按钮（并排）、pi 说明、状态面板窗口、面板说明。背后有一条和横幅图同样风格的发光圆弧。
3. **流程区块**：标题、说明、一条横线上排开的七步。每步写编号、角色、步骤名和说明。只有用户能做的步骤（第 2、6、7 步）的圆点、编号和步骤名是琥珀色，其余圆点是蓝色。
4. **治理区块**：隔行背景。标题、说明、两行两列的四张卡片，卡片之间用细线分开。
5. **团队区块**：左边是标题、说明和七个角色的列表；右边是技术栈标签和"也能换成你们的规矩"。
6. **现状区块**：隔行背景。左边是标题、说明和"完整的已知限制"链接；右边是四条限制。
7. **开始区块**：标题、三列步骤、安装命令框。
8. **底部**：左边是 `OneCompany · MIT 许可证`，右边是 GitHub 和 README 两个链接。

### 状态面板

- 面板窗口标题写 `pi · status panel`，内容中英文版都是下面这段中文：

  ```
  ● 2 个需求运行中
  ├─ ⠹ 角色跳跃、跳跃动画 · 任务 1/5 · ↻5 · 33.8k token · 12.3s
  │    ├ ⚑ login 待裁决：2 次未完成
  │    ├ jump 第 1 轮审查
  │    │ ├ ⠹ reviewer · ↻5/12 · 1m2s
  │    │ ├ ⠹ go-reviewer · ↻3/12 · 58.0s
  │    │ └ ✓ vue-reviewer 通过 · ↻6/12 · 1m40s
  │    └ ⠹ anim 执行 · vue-worker（第 1 次尝试）· ↻8/20 · 3m2s
  └─ ⠹ 角色快跑 · 任务 0/3 · ↻42 · 91.0k token · 2m17s
       └ 规划中（计划 v2 · 3 个任务）
  ```

- 行首 ● 和 ✓ 那段是绿色，⚑ 那一整段是琥珀色，转圈字符是蓝色。
- 转圈字符按 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` 循环播放，约 90 毫秒换一个字符。系统开了"减少动态效果"时不播放。

### 语言

- 第一次打开时，浏览器首选语言以 `zh` 开头就显示中文，否则显示英文。
- 中文版的语言按钮写 `EN`，英文版的语言按钮写 `中文`；点击后立即切换全部文字、页面标题和 `lang` 属性，页面不刷新、滚动位置不变。
- 手动切换后记住选择，下次打开按记住的语言显示。浏览器读写不了本地存储时，切换照常生效，只是下次不记住，页面不报错。

### 复制命令

- 页面有两处安装命令框，点任一处的"复制"都写入 `pi install git:github.com/0xBB2B/one-company`。
- 写入成功后，被点的按钮文字变成"已复制"（英文 `Copied`）、背景变成琥珀色，约 2 秒后恢复。
- 写入失败时，选中这个命令框里的命令文字，按钮不变。

### 链接

- GitHub 链接和"在 GitHub 上查看"指向 `https://github.com/0xBB2B/one-company`。
- pi 的链接指向 `https://github.com/earendil-works/pi`。
- README 链接指向 `https://github.com/0xBB2B/one-company#readme`。
- "完整的已知限制"指向 `https://github.com/0xBB2B/one-company#已知限制`。
- 所有外部链接在当前标签页打开。

### 窄屏

- 页面宽度不超过 860 像素时：内容改成单列；顶部栏隐藏四个导航项，只留字样、GitHub 链接和语言按钮；七步流程变成竖排，圆点在左边；安装命令框和"在 GitHub 上查看"上下排列。
- 任何宽度下整页都没有横向滚动；状态面板和安装命令框放不下时在各自框内横向滚动。

### 文案

中文和英文一一对应，所有文字一字不差：

| 位置 | 中文 | 英文 |
|---|---|---|
| 导航 | 工作方式、治理、团队、开始 | How it works、Governance、Team、Start |
| 小字标签 | pi 扩展包 · MIT 开源 · v0.1.0 | pi extension · MIT · v0.1.0 |
| 大标题 | 一个人，（换行）撑起一家有规矩的 AI 公司。 | One human.（换行）A governed autonomous company. |
| 介绍 | 你在对话里说需求、点头确认。后台的 PM 拆任务、派代理写代码、审查、验收，最后把结果交回你手上。每一步能不能往下走，由你和程序决定，不由模型自己说了算。 | Describe what you want in chat and sign off. A background PM plans the work and sends agents to build, review and verify it, then hands the result back. You and the program decide what moves forward, not a model’s own claims. |
| 按钮 | 复制 / 已复制 / 在 GitHub 上查看 | Copy / Copied / View on GitHub |
| pi 说明 | OneCompany 是 pi 的扩展包。pi 是一个在终端里运行的编码代理。 | OneCompany is an extension for pi, a coding agent that runs in your terminal. |
| 面板说明 | 状态面板示例。产品界面目前是中文。 | Sample status panel. The product UI is Chinese-only today. |
| 流程标题 | 一个需求怎么走完 | How a requirement gets done |
| 流程说明 | 标出来的三步只有你能做。其余由代理完成，程序逐步核对。 | The three marked steps are yours alone. Agents do the rest, and the program checks each one. |
| 第 1 步 | 主代理 · 理清需求 · 和你理清目标、不做什么、约束；涉及界面时先出 HTML 原型。 | Main agent · Clarify · Pins down goals, non-goals and constraints. UI work gets an HTML prototype first. |
| 第 2 步 | 你 · 批准 · 在程序弹出的窗口里选"确认"才生效。 | You · Approve · Takes effect only when you confirm in the program’s window. |
| 第 3 步 | PM · 规划 · 读批准的需求，写计划、拆任务、派工。 | PM · Plan · Reads the approved requirement, writes the plan, assigns tasks. |
| 第 4 步 | worker · 实现 · 在需求自己的分支里，按技术栈写代码。 | worker · Build · Writes code by stack, on the requirement’s own branch. |
| 第 5 步 | reviewer · 审查 · 通用审查和专项审查同时跑，全部通过才算过。 | reviewer · Review · General and stack reviewers run together. All must pass. |
| 第 6 步 | QA · 你 · 验收 · QA 黑盒验收后交给你，你通过需求才关闭。 | QA · You · Verify · QA tests the behavior, then you accept it to close the requirement. |
| 第 7 步 | 你 · 交付 · 选合并方式，开 PR 或合进本地分支。 | You · Deliver · Pick a merge method, then open a PR or merge locally. |
| 治理标题 | 模型说的不算，程序核对的才算 | A model saying so isn’t enough. The program checks. |
| 治理说明 | 代理写代码很快，也很会说"做完了"。OneCompany 把关键判断交给程序和你。 | Agents write code fast, and they are quick to say “done”. OneCompany leaves the key calls to the program and to you. |
| 卡片 1 | 只有你能批准：批准和裁决只认你的原话和你在程序窗口里的选择。代理说"用户同意了"不算数，代理之间也不能互相批准。 | Only you can approve: Approvals count only from your own words or your choice in a program window. An agent saying “the user agreed” does not count, and agents can’t approve each other. |
| 卡片 2 | 自称完成不算完成：各角色的权限、版本和阶段门槛都由程序核对。代理说"通过了"不能代替实际检查。 | Claiming done isn’t done: The program checks every role’s permissions, versions and stage gates. An agent saying “passed” never replaces the actual check. |
| 卡片 3 | 改动不出范围：worker 改了本需求任务范围外的文件，结果被拒收。写入范围重叠的任务不会同时派出。 | Changes stay in scope: A worker that edits files outside the requirement’s task scopes gets its result rejected. Tasks with overlapping write scopes are never dispatched at the same time. |
| 卡片 4 | 每处改动查得回需求：提交带需求编号，需求完成时正文和原型归档进分支。以后能从代码查到当初为什么这样做。 | Every change traces back: Commits carry the requirement ID, and the requirement and prototypes are archived in the branch when it completes. You can always find why the code looks the way it does. |
| 团队标题 | 一支随包附带的团队 | A team that ships with the package |
| 团队说明 | 你只和主代理说话，其他角色都在后台运行。不用另装子代理系统。 | You talk only to the main agent. Every other role runs in the background, with no separate subagent system to install. |
| 角色：主代理 | 和你理清需求，弹窗问你拿主意 | Main agent：Clarifies the requirement and asks for your decisions |
| 角色：PM | 一个需求一个 PM，写计划、拆任务、派工 | One per requirement: plans, splits tasks, assigns work |
| 角色：worker | 写代码，按技术栈有专项 worker | Writes code, with specialists for each stack |
| 角色：reviewer | 代码审查，每个任务必审 | Reviews the code of every task |
| 角色：QA | 验收实际行为是否符合批准的目标 | Verifies behavior against the approved goal |
| 角色：explore | 只读查资料，不改代码 | Read-only research, never edits code |
| 角色：prototype | 需求涉及界面时出 HTML 原型 | Draws HTML prototypes for UI work |
| 技术栈标题 | 内置六个技术栈 | Six stacks built in |
| 技术栈 | Go、Node.js / TypeScript、Python、Java / Spring、Vue、React | 同左 |
| 规范标题 | 也能换成你们的规矩 | Bring your own rules |
| 规范说明 | 角色定义是普通 md 文件，复制后可以自己改。`/one:examples` 把 Go、Vue 设计规范样例复制到项目里，照着改成团队自己的规范。 | Role definitions are plain md files you can copy and edit. `/one:examples` copies Go and Vue design guides into your project to adapt. |
| 现状标题 | 现在的状态 | Where it stands today |
| 现状说明 | 项目还在早期，这几件事先说清楚。 | This is an early project. Better to say these up front. |
| 现状条目 | 版本 0.1.0，还没有正式发布；产品界面和规则目前是中文；只在 macOS 上测过；真实模型验收只用 gpt-6.1-sol 跑过 | Version 0.1.0, no stable release yet; Product UI and rules are in Chinese; Tested on macOS only; Live-model acceptance has only run on gpt-6.1-sol |
| 现状链接 | 完整的已知限制 → | Full list of known limits → |
| 开始标题 | 三步开始 | Start in three steps |
| 开始 1 | 准备：装好 pi（Node ≥ 22.19）和 Git ≥ 2.38，给主窗口的模型配好凭据。 | Prepare: Install pi (Node ≥ 22.19) and Git ≥ 2.38, and set up credentials for your model. |
| 开始 2 | 安装：在终端运行上面那条安装命令。角色代理随包提供。 | Install: Run the install command above. Role agents ship with the package. |
| 开始 3 | 开工：在 Git 仓库里打开 pi，直接说需求，比如"登录页加上验证码登录"。 | Build: Open pi inside a Git repo and say what you want, like “add code login to the sign-in page”. |
| 底部 | OneCompany · MIT 许可证 | OneCompany · MIT License |

"开始 2"里的"上面那条"指首屏的安装命令框。

## 验收

- [ ] `site/index.html` 存在，是唯一的页面文件，样式和脚本都写在文件里。
- [ ] 页面请求里没有外部字体、脚本或样式。
- [ ] 页面结构、配色、状态面板内容和颜色和约束一致。
- [ ] 转圈字符在转动；开了"减少动态效果"时不转。
- [ ] 浏览器语言是中文时第一次打开显示中文，是其他语言时显示英文。
- [ ] 点语言按钮后全部文字、页面标题和 `lang` 属性都切换，页面不刷新、滚动位置不变。
- [ ] 手动切换后刷新，语言保持；本地存储不可用时切换照常、页面不报错。
- [ ] 两处"复制"都写入完整安装命令，按钮变"已复制"约 2 秒后恢复。
- [ ] 写入剪贴板失败时选中命令文字，按钮不变。
- [ ] 所有链接指向约束写明的地址。
- [ ] 四个导航项能滚动到对应区块。
- [ ] 390 像素宽时单列显示，七步竖排，顶部栏只留字样、GitHub 和语言按钮。
- [ ] 390、860、1440 像素宽时整页都没有横向滚动。
- [ ] 全部文案和文案表一字不差，中英文都查过。
- [ ] 主页上的说法都能在 `README.md` 或代码里找到依据。

## 验证路径

1. 用本地静态服务打开 `site/index.html` → 控制台没有错误，网络请求只有这一个页面文件。
2. 把浏览器语言分别设为中文和英文后打开 → 分别显示中文和英文。
3. 点语言按钮，刷新页面 → 语言保持。
4. 点两处"复制"，粘贴 → 得到完整命令；按钮约 2 秒后恢复。
5. 把宽度调到 390、860、1440 像素 → 布局符合约束，没有整页横向滚动。
6. 逐项对照文案表 → 中英文一字不差。
