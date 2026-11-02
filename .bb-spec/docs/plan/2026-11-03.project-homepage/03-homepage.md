---
name: 03-homepage
description: 新建单文件主页 site/index.html，中英双语，能复制安装命令，手机上可用
---
# 项目主页

## 目标
`site/index.html` 是一个不依赖任何外部资源的单页主页。

## 业务规则（来源：PRD 03-homepage）
- 只有一个页面文件，样式和脚本都写在里面，不用框架，不加载外部字体、脚本或样式。
- 第一次打开时，浏览器语言以 `zh` 开头显示中文，否则英文。手动切换后记住选择；本地存储不可用时切换照常、页面不报错。
- 切换语言时全部文字、页面标题和 `lang` 属性一起变，页面不刷新。
- 两处"复制"写入 `pi install git:github.com/0xBB2B/one-company`，成功后约 2 秒内显示"已复制"；写入失败时选中命令文字，按钮不变。
- 状态面板内容中英文版都是中文，并写明产品界面目前是中文。转圈字符在系统开了"减少动态效果"时不播放。
- 宽度不超过 860 像素时单列，顶部栏只留字样、GitHub 链接和语言按钮；任何宽度下整页都没有横向滚动。
- 琥珀色只用在只有用户能做的步骤、⚑ 待处理行和"已复制"按钮。

## 涉及文件
- 新建：`site/index.html`
- 新建：`tests/project-homepage.test.ts`

## 成品定义

`site/index.html` 的完整内容，原样落盘，不得改写：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OneCompany：一个人，撑起一家有规矩的 AI 公司</title>
  <meta name="description" content="One human. A governed autonomous company. A pi extension that plans, builds, reviews and verifies your requirements.">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='9' fill='%23ffbf66'/%3E%3C/svg%3E">
  <style>
    :root { --bg: #080b12; --alt: #0b0f19; --sf: #0e1320; --line: #1e2738; --edge: #2a3650; --tx: #e9edf5; --mut: #8f9bb0; --blue: #7cb0ff; --you: #ffbf66; color-scheme: dark; }
    :root[lang="zh-CN"] [data-l="en"], :root[lang="en"] [data-l="zh"] { display: none; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--tx); background: var(--bg); -webkit-font-smoothing: antialiased; }
    a { color: inherit; }
    h1, h2, h3, p, figure { margin: 0; }
    dl, dd, ul, ol { margin: 0; padding: 0; list-style: none; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 0 40px; }
    .bar { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    .top { position: relative; z-index: 2; padding: 18px 0; border-bottom: 1px solid var(--line); }
    .logo { font-weight: 650; letter-spacing: -.01em; text-decoration: none; }
    nav { display: flex; align-items: center; gap: 22px; font-size: 14px; }
    nav a { text-decoration: none; opacity: .72; }
    nav a:hover { opacity: 1; }
    .lang { padding: 3px 10px; font-size: 12px; color: inherit; background: none; border: 1px solid currentColor; border-radius: 4px; cursor: pointer; opacity: .8; }
    .hero { position: relative; overflow: hidden; padding: 88px 0 72px; text-align: center; }
    .hero .wrap { position: relative; }
    .arc { position: absolute; left: 50%; top: 430px; width: 1900px; height: 1900px; margin-left: -950px; border-radius: 50%; border-top: 1px solid rgba(124,176,255,.55); box-shadow: 0 -60px 160px rgba(124,176,255,.16), inset 0 80px 160px rgba(124,176,255,.07); }
    .eyebrow { color: var(--blue); font-size: 13px; letter-spacing: .02em; }
    h1 { margin-top: 18px; font-size: clamp(38px, 6.4vw, 72px); line-height: 1.12; letter-spacing: -.025em; font-weight: 680; }
    .sub { max-width: 700px; margin: 24px auto 0; color: var(--mut); font-size: 18px; text-wrap: pretty; }
    .acts { display: flex; justify-content: center; align-items: center; gap: 14px; margin-top: 34px; }
    .cmd { display: flex; align-items: center; gap: 10px; min-width: 0; max-width: 100%; padding: 10px 10px 10px 16px; font-size: 14px; text-align: left; background: var(--sf); border: 1px solid var(--line); border-radius: 8px; }
    .cmd .pr { color: var(--blue); }
    .cmd .tx { flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; scrollbar-width: none; }
    .copy { flex: none; padding: 4px 12px; font: inherit; font-size: 12px; color: var(--bg); background: var(--tx); border: 0; border-radius: 5px; cursor: pointer; }
    .copy .ok { display: none; }
    .copy.done { background: var(--you); }
    .copy.done .idle { display: none; }
    .copy.done .ok { display: inline; }
    .ghost { flex: none; padding: 10px 16px; font-size: 14px; text-decoration: none; background: var(--sf); border: 1px solid var(--line); border-radius: 8px; }
    .pinote { margin-top: 16px; color: var(--mut); font-size: 13px; }
    .win { max-width: 860px; margin: 52px auto 0; text-align: left; background: rgba(14,19,32,.92); border: 1px solid var(--edge); border-radius: 12px; box-shadow: 0 30px 90px rgba(0,0,0,.6); }
    .win figcaption { padding: 10px 18px; color: var(--mut); font-size: 12px; border-bottom: 1px solid var(--line); }
    .panel { margin: 0; padding: 18px; color: #c9d3e4; font-size: 13px; line-height: 1.7; white-space: pre; overflow-x: auto; }
    .panel .ok { color: #79dfb6; }
    .panel .flag { color: var(--you); }
    .panel .sp { color: var(--blue); font-style: normal; }
    .cap { margin-top: 12px; color: var(--mut); font-size: 13px; }
    .sec { padding: 92px 0; border-top: 1px solid var(--line); }
    .sec.alt { background: var(--alt); }
    h2 { font-size: clamp(28px, 3.6vw, 40px); line-height: 1.2; letter-spacing: -.02em; font-weight: 650; }
    h3 { font-size: 18px; font-weight: 620; }
    .lead { max-width: 660px; margin-top: 12px; color: var(--mut); font-size: 17px; }
    .rail { display: grid; grid-template-columns: repeat(7, 1fr); margin-top: 52px; border-top: 1px solid var(--edge); }
    .rail li { position: relative; padding: 22px 16px 0 0; }
    .rail .dot { position: absolute; top: -5px; left: 0; width: 9px; height: 9px; border-radius: 50%; background: var(--blue); box-shadow: 0 0 10px rgba(124,176,255,.7); }
    .rail .n { display: block; color: var(--mut); font-size: 11px; }
    .rail strong { display: block; margin-top: 4px; font-size: 18px; }
    .rail .d { display: block; margin-top: 6px; color: var(--mut); font-size: 13px; line-height: 1.6; }
    .rail .you .dot { background: var(--you); box-shadow: 0 0 12px rgba(255,191,102,.8); }
    .rail .you .n, .rail .you strong { color: var(--you); }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin-top: 44px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
    .grid2 article { padding: 30px; background: var(--alt); }
    .grid2 p { margin-top: 8px; color: var(--mut); font-size: 15px; }
    .split { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 64px; }
    .roles { margin-top: 30px; border-top: 1px solid var(--line); }
    .roles div { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--line); font-size: 15px; }
    .roles dt { color: var(--blue); font-size: 14px; }
    .roles dd { color: var(--mut); }
    .side-col h3 + * { margin-top: 12px; }
    .side-col * + h3 { margin-top: 36px; }
    .side-col p { color: var(--mut); font-size: 15px; }
    .side-col code { color: var(--tx); }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .chips li { padding: 3px 10px; font-size: 13px; border: 1px solid var(--line); border-radius: 5px; }
    .more { display: inline-block; margin-top: 18px; color: var(--blue); font-size: 15px; text-decoration: none; }
    .now li { padding: 13px 0; font-size: 15px; border-bottom: 1px solid var(--line); }
    .three { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; margin: 40px 0 32px; }
    .three .n { color: var(--blue); font-size: 13px; }
    .three strong { display: block; font-size: 18px; }
    .three p { margin-top: 6px; color: var(--mut); font-size: 15px; }
    .foot { padding: 26px 0; color: var(--mut); font-size: 13px; border-top: 1px solid var(--line); }
    .foot a { margin-left: 18px; text-decoration: none; }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
    }
    @media (max-width: 860px) {
      .wrap { padding: 0 20px; }
      nav a:not(:last-of-type) { display: none; }
      .hero { padding: 56px 0 48px; }
      .arc { top: 620px; }
      .sub { font-size: 16px; }
      .acts { flex-direction: column; align-items: stretch; }
      .ghost { text-align: center; }
      .panel { font-size: 11px; }
      .sec { padding: 60px 0; }
      .rail { grid-template-columns: 1fr; border-top: 0; border-left: 1px solid var(--edge); }
      .rail li { padding: 0 0 22px 20px; }
      .rail .dot { top: 7px; left: -5px; }
      .grid2 { grid-template-columns: 1fr; }
      .split { grid-template-columns: minmax(0, 1fr); gap: 32px; }
      .three { grid-template-columns: 1fr; }
      .roles div { grid-template-columns: 96px 1fr; }
    }
  </style>
  <script>
    (() => {
      const KEY = 'one-company-lang';
      const COMMAND = 'pi install git:github.com/0xBB2B/one-company';
      const TITLES = {
        zh: 'OneCompany：一个人，撑起一家有规矩的 AI 公司',
        en: 'OneCompany: One human. A governed autonomous company.',
      };
      const root = document.documentElement;

      const readSaved = () => {
        try {
          return localStorage.getItem(KEY);
        } catch {
          return null;
        }
      };
      const save = (lang) => {
        try {
          localStorage.setItem(KEY, lang);
        } catch {}
      };
      const firstLang = () => {
        const saved = readSaved();
        if (saved === 'zh' || saved === 'en') return saved;
        return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
      };
      const showLang = (lang) => {
        root.lang = lang === 'zh' ? 'zh-CN' : 'en';
        document.title = TITLES[lang];
      };

      let lang = firstLang();
      showLang(lang);

      document.addEventListener('DOMContentLoaded', () => {
        document.querySelector('.lang').addEventListener('click', () => {
          lang = lang === 'zh' ? 'en' : 'zh';
          showLang(lang);
          save(lang);
        });

        for (const button of document.querySelectorAll('.copy')) {
          let timer;
          button.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(COMMAND);
            } catch {
              getSelection().selectAllChildren(button.closest('.cmd').querySelector('.tx'));
              return;
            }
            button.classList.add('done');
            clearTimeout(timer);
            timer = setTimeout(() => button.classList.remove('done'), 2000);
          });
        }

        if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
        const spinners = document.querySelectorAll('.sp');
        let frame = 0;
        setInterval(() => {
          frame = (frame + 1) % frames.length;
          for (const spinner of spinners) spinner.textContent = frames[frame];
        }, 90);
      });
    })();
  </script>
</head>
<body>
<header class="top"><div class="wrap bar">
  <a class="logo" href="#top">OneCompany</a>
  <nav><a href="#flow"><span data-l="zh">工作方式</span><span data-l="en">How it works</span></a><a href="#governance"><span data-l="zh">治理</span><span data-l="en">Governance</span></a><a href="#team"><span data-l="zh">团队</span><span data-l="en">Team</span></a><a href="#start"><span data-l="zh">开始</span><span data-l="en">Start</span></a><a href="https://github.com/0xBB2B/one-company">GitHub</a><button class="lang mono" type="button"><span data-l="zh">EN</span><span data-l="en">中文</span></button></nav>
</div></header>
<main>
<section class="hero" id="top"><div class="arc"></div><div class="wrap">
  <p class="eyebrow mono"><span data-l="zh">pi 扩展包 · MIT 开源 · v0.1.0</span><span data-l="en">pi extension · MIT · v0.1.0</span></p>
  <h1><span data-l="zh">一个人，<br>撑起一家有规矩的 AI 公司。</span><span data-l="en">One human.<br>A governed autonomous company.</span></h1>
  <p class="sub"><span data-l="zh">你在对话里说需求、点头确认。后台的 PM 拆任务、派代理写代码、审查、验收，最后把结果交回你手上。每一步能不能往下走，由你和程序决定，不由模型自己说了算。</span><span data-l="en">Describe what you want in chat and sign off. A background PM plans the work and sends agents to build, review and verify it, then hands the result back. You and the program decide what moves forward, not a model’s own claims.</span></p>
  <div class="acts"><div class="cmd mono"><span class="pr">$</span><span class="tx">pi install git:github.com/0xBB2B/one-company</span><button class="copy" type="button"><span class="idle"><span data-l="zh">复制</span><span data-l="en">Copy</span></span><span class="ok"><span data-l="zh">已复制</span><span data-l="en">Copied</span></span></button></div><a class="ghost" href="https://github.com/0xBB2B/one-company"><span data-l="zh">在 GitHub 上查看</span><span data-l="en">View on GitHub</span></a></div>
  <p class="pinote"><span data-l="zh">OneCompany 是 <a href="https://github.com/earendil-works/pi">pi</a> 的扩展包。pi 是一个在终端里运行的编码代理。</span><span data-l="en">OneCompany is an extension for <a href="https://github.com/earendil-works/pi">pi</a>, a coding agent that runs in your terminal.</span></p>
  <figure class="win">
    <figcaption class="mono">pi · status panel</figcaption>
    <pre class="panel mono"><span class="ok">●</span> 2 个需求运行中
├─ <i class="sp">⠹</i> 角色跳跃、跳跃动画 · 任务 1/5 · ↻5 · 33.8k token · 12.3s
│    ├ <span class="flag">⚑ login 待裁决：2 次未完成</span>
│    ├ jump 第 1 轮审查
│    │ ├ <i class="sp">⠹</i> reviewer · ↻5/12 · 1m2s
│    │ ├ <i class="sp">⠹</i> go-reviewer · ↻3/12 · 58.0s
│    │ └ <span class="ok">✓ vue-reviewer 通过</span> · ↻6/12 · 1m40s
│    └ <i class="sp">⠹</i> anim 执行 · vue-worker（第 1 次尝试）· ↻8/20 · 3m2s
└─ <i class="sp">⠹</i> 角色快跑 · 任务 0/3 · ↻42 · 91.0k token · 2m17s
     └ 规划中（计划 v2 · 3 个任务）</pre>
  </figure>
  <p class="cap"><span data-l="zh">状态面板示例。产品界面目前是中文。</span><span data-l="en">Sample status panel. The product UI is Chinese-only today.</span></p>
</div></section>
<section class="sec" id="flow"><div class="wrap">
  <h2><span data-l="zh">一个需求怎么走完</span><span data-l="en">How a requirement gets done</span></h2>
  <p class="lead"><span data-l="zh">标出来的三步只有你能做。其余由代理完成，程序逐步核对。</span><span data-l="en">The three marked steps are yours alone. Agents do the rest, and the program checks each one.</span></p>
  <ol class="rail">
    <li><span class="dot"></span><span class="n mono">01 · <span data-l="zh">主代理</span><span data-l="en">Main agent</span></span><strong><span data-l="zh">理清需求</span><span data-l="en">Clarify</span></strong><span class="d"><span data-l="zh">和你理清目标、不做什么、约束；涉及界面时先出 HTML 原型。</span><span data-l="en">Pins down goals, non-goals and constraints. UI work gets an HTML prototype first.</span></span></li>
    <li class="you"><span class="dot"></span><span class="n mono">02 · <span data-l="zh">你</span><span data-l="en">You</span></span><strong><span data-l="zh">批准</span><span data-l="en">Approve</span></strong><span class="d"><span data-l="zh">在程序弹出的窗口里选"确认"才生效。</span><span data-l="en">Takes effect only when you confirm in the program’s window.</span></span></li>
    <li><span class="dot"></span><span class="n mono">03 · PM</span><strong><span data-l="zh">规划</span><span data-l="en">Plan</span></strong><span class="d"><span data-l="zh">读批准的需求，写计划、拆任务、派工。</span><span data-l="en">Reads the approved requirement, writes the plan, assigns tasks.</span></span></li>
    <li><span class="dot"></span><span class="n mono">04 · worker</span><strong><span data-l="zh">实现</span><span data-l="en">Build</span></strong><span class="d"><span data-l="zh">在需求自己的分支里，按技术栈写代码。</span><span data-l="en">Writes code by stack, on the requirement’s own branch.</span></span></li>
    <li><span class="dot"></span><span class="n mono">05 · reviewer</span><strong><span data-l="zh">审查</span><span data-l="en">Review</span></strong><span class="d"><span data-l="zh">通用审查和专项审查同时跑，全部通过才算过。</span><span data-l="en">General and stack reviewers run together. All must pass.</span></span></li>
    <li class="you"><span class="dot"></span><span class="n mono">06 · <span data-l="zh">QA · 你</span><span data-l="en">QA · You</span></span><strong><span data-l="zh">验收</span><span data-l="en">Verify</span></strong><span class="d"><span data-l="zh">QA 黑盒验收后交给你，你通过需求才关闭。</span><span data-l="en">QA tests the behavior, then you accept it to close the requirement.</span></span></li>
    <li class="you"><span class="dot"></span><span class="n mono">07 · <span data-l="zh">你</span><span data-l="en">You</span></span><strong><span data-l="zh">交付</span><span data-l="en">Deliver</span></strong><span class="d"><span data-l="zh">选合并方式，开 PR 或合进本地分支。</span><span data-l="en">Pick a merge method, then open a PR or merge locally.</span></span></li>
  </ol>
</div></section>
<section class="sec alt" id="governance"><div class="wrap">
  <h2><span data-l="zh">模型说的不算，程序核对的才算</span><span data-l="en">A model saying so isn’t enough. The program checks.</span></h2>
  <p class="lead"><span data-l="zh">代理写代码很快，也很会说"做完了"。OneCompany 把关键判断交给程序和你。</span><span data-l="en">Agents write code fast, and they are quick to say “done”. OneCompany leaves the key calls to the program and to you.</span></p>
  <div class="grid2">
    <article><h3><span data-l="zh">只有你能批准</span><span data-l="en">Only you can approve</span></h3><p><span data-l="zh">批准和裁决只认你的原话和你在程序窗口里的选择。代理说"用户同意了"不算数，代理之间也不能互相批准。</span><span data-l="en">Approvals count only from your own words or your choice in a program window. An agent saying “the user agreed” does not count, and agents can’t approve each other.</span></p></article>
    <article><h3><span data-l="zh">自称完成不算完成</span><span data-l="en">Claiming done isn’t done</span></h3><p><span data-l="zh">各角色的权限、版本和阶段门槛都由程序核对。代理说"通过了"不能代替实际检查。</span><span data-l="en">The program checks every role’s permissions, versions and stage gates. An agent saying “passed” never replaces the actual check.</span></p></article>
    <article><h3><span data-l="zh">改动不出范围</span><span data-l="en">Changes stay in scope</span></h3><p><span data-l="zh">worker 改了任务范围外的文件，结果被拒收。新增第三方依赖要你裁决。同一文件同一时间只有一个任务能写。</span><span data-l="en">A worker that edits files outside its task gets its result rejected. New third-party dependencies need your ruling. Only one task can write a file at a time.</span></p></article>
    <article><h3><span data-l="zh">每处改动查得回需求</span><span data-l="en">Every change traces back</span></h3><p><span data-l="zh">提交带需求编号，需求关闭时正文和原型归档进分支。以后能从代码查到当初为什么这样做。</span><span data-l="en">Commits carry the requirement ID, and the requirement and prototypes are archived in the branch on close. You can always find why the code looks the way it does.</span></p></article>
  </div>
</div></section>
<section class="sec" id="team"><div class="wrap split">
  <div>
    <h2><span data-l="zh">一支随包附带的团队</span><span data-l="en">A team that ships with the package</span></h2>
    <p class="lead"><span data-l="zh">你只和主代理说话，其他角色都在后台运行。不用另装子代理系统。</span><span data-l="en">You talk only to the main agent. Every other role runs in the background, with no separate subagent system to install.</span></p>
    <dl class="roles">
      <div><dt class="mono"><span data-l="zh">主代理</span><span data-l="en">Main agent</span></dt><dd><span data-l="zh">和你理清需求，弹窗问你拿主意</span><span data-l="en">Clarifies the requirement and asks for your decisions</span></dd></div>
      <div><dt class="mono">PM</dt><dd><span data-l="zh">一个需求一个 PM，写计划、拆任务、派工</span><span data-l="en">One per requirement: plans, splits tasks, assigns work</span></dd></div>
      <div><dt class="mono">worker</dt><dd><span data-l="zh">写代码，按技术栈有专项 worker</span><span data-l="en">Writes code, with specialists for each stack</span></dd></div>
      <div><dt class="mono">reviewer</dt><dd><span data-l="zh">代码审查，每个任务必审</span><span data-l="en">Reviews the code of every task</span></dd></div>
      <div><dt class="mono">QA</dt><dd><span data-l="zh">验收实际行为是否符合批准的目标</span><span data-l="en">Verifies behavior against the approved goal</span></dd></div>
      <div><dt class="mono">explore</dt><dd><span data-l="zh">只读查资料，不改代码</span><span data-l="en">Read-only research, never edits code</span></dd></div>
      <div><dt class="mono">prototype</dt><dd><span data-l="zh">需求涉及界面时出 HTML 原型</span><span data-l="en">Draws HTML prototypes for UI work</span></dd></div>
    </dl>
  </div>
  <div class="side-col">
    <h3><span data-l="zh">内置六个技术栈</span><span data-l="en">Six stacks built in</span></h3>
    <ul class="chips"><li class="mono">Go</li><li class="mono">Node.js / TypeScript</li><li class="mono">Python</li><li class="mono">Java / Spring</li><li class="mono">Vue</li><li class="mono">React</li></ul>
    <h3><span data-l="zh">也能换成你们的规矩</span><span data-l="en">Bring your own rules</span></h3>
    <p><span data-l="zh">角色定义是普通 md 文件，复制后可以自己改。<code>/one:examples</code> 把 Go、Vue 设计规范样例复制到项目里，照着改成团队自己的规范。</span><span data-l="en">Role definitions are plain md files you can copy and edit. <code>/one:examples</code> copies Go and Vue design guides into your project to adapt.</span></p>
  </div>
</div></section>
<section class="sec alt"><div class="wrap split">
  <div>
    <h2><span data-l="zh">现在的状态</span><span data-l="en">Where it stands today</span></h2>
    <p class="lead"><span data-l="zh">项目还在早期，这几件事先说清楚。</span><span data-l="en">This is an early project. Better to say these up front.</span></p>
    <a class="more" href="https://github.com/0xBB2B/one-company#已知限制"><span data-l="zh">完整的已知限制 →</span><span data-l="en">Full list of known limits →</span></a>
  </div>
  <ul class="now">
    <li><span data-l="zh">版本 0.1.0，还没有正式发布</span><span data-l="en">Version 0.1.0, no stable release yet</span></li>
    <li><span data-l="zh">产品界面和规则目前是中文</span><span data-l="en">Product UI and rules are in Chinese</span></li>
    <li><span data-l="zh">只在 macOS 上测过</span><span data-l="en">Tested on macOS only</span></li>
    <li><span data-l="zh">真实模型验收只用 gpt-6.1-sol 跑过</span><span data-l="en">Live-model acceptance has only run on gpt-6.1-sol</span></li>
  </ul>
</div></section>
<section class="sec" id="start"><div class="wrap">
  <h2><span data-l="zh">三步开始</span><span data-l="en">Start in three steps</span></h2>
  <ol class="three">
    <li><span class="n mono">1</span><strong><span data-l="zh">准备</span><span data-l="en">Prepare</span></strong><p><span data-l="zh">装好 pi（Node ≥ 22.19）和 Git ≥ 2.38，给主窗口的模型配好凭据。</span><span data-l="en">Install pi (Node ≥ 22.19) and Git ≥ 2.38, and set up credentials for your model.</span></p></li>
    <li><span class="n mono">2</span><strong><span data-l="zh">安装</span><span data-l="en">Install</span></strong><p><span data-l="zh">在终端运行上面那条安装命令。角色代理随包提供。</span><span data-l="en">Run the install command above. Role agents ship with the package.</span></p></li>
    <li><span class="n mono">3</span><strong><span data-l="zh">开工</span><span data-l="en">Build</span></strong><p><span data-l="zh">在 Git 仓库里打开 pi，直接说需求，比如"登录页加上验证码登录"。</span><span data-l="en">Open pi inside a Git repo and say what you want, like “add code login to the sign-in page”.</span></p></li>
  </ol>
  <div class="cmd mono"><span class="pr">$</span><span class="tx">pi install git:github.com/0xBB2B/one-company</span><button class="copy" type="button"><span class="idle"><span data-l="zh">复制</span><span data-l="en">Copy</span></span><span class="ok"><span data-l="zh">已复制</span><span data-l="en">Copied</span></span></button></div>
</div></section>
</main>
<footer class="foot"><div class="wrap bar"><span>OneCompany · <span data-l="zh">MIT 许可证</span><span data-l="en">MIT License</span></span><span><a href="https://github.com/0xBB2B/one-company">GitHub</a><a href="https://github.com/0xBB2B/one-company#readme">README</a></span></div></footer>
</body>
</html>
```

## 函数清单
页面脚本已在成品定义里，不用另写。

## 协作关系
页面不依赖仓库其他文件。`package.json` 的 `files` 不加 `site`。

## 验证方式
- 测试入口：`pnpm exec vitest run tests/project-homepage.test.ts`
- 测试输入：仓库里的 `site/index.html`，按文本读取。
- 预期结果：
  - `site/` 下只有 `index.html`。
  - 文件里没有 `<script src`、`<link rel="stylesheet"`、`@import`、`fonts.googleapis`；除 `https://github.com/0xBB2B/one-company`、`https://github.com/earendil-works/pi`、SVG 命名空间地址外没有别的 `http` 地址。
  - 含完整安装命令，两种语言的大标题、面板说明，七步里第 2、6、7 步带 `you` 样式。
  - 含 `#已知限制` 和 `#readme` 两个链接，以及 `flow`、`governance`、`team`、`start` 四个区块编号。
  - 成对的 `data-l="zh"` 和 `data-l="en"` 数量相等。
  - 现状区块的 `gpt-6.1-sol`、`macOS` 和 `README.md` 已知限制里写的一致。
- 浏览器验证（由 exec 收尾时用 `/prototype --compare` 和实际打开页面完成）：语言判断、切换和记忆，复制成功和失败，四个导航项，390、860、1440 像素宽没有整页横向滚动。
- [ ] 文件内全部测试通过。
- [ ] 浏览器验证全部符合。
