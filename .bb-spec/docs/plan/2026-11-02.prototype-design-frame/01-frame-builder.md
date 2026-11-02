---
name: frame-builder
description: 新增纯函数，把设计师交的页面和清单拼成左边切换栏、右边隔离框、下方说明区的单个 HTML
---
# 拼原型外框

## 目标
给定页面源码、原型名称、版本和各张清单，返回一份可直接用浏览器按本地文件打开的完整 HTML。

## 业务规则（来源：PRD frame-submission）
- 原型外框分三块：左边切换栏（宽 260 像素，深色，右边缘黄色分隔线，只有自己滚动），右边上方隔离框（iframe），隔离框下方说明区。
- 切换栏从上到下：标签"设计说明 · 不属于页面"、原型名称、"第 N 版 · 这一栏上线后不存在"、方案提示框（有方案清单时才有）、"切换要看的内容"。
- 方案提示框：黄色边框，标题"这份原型有 N 个方案，点这里切换对比"，方案按钮写"方案 <字母>：<名称>"，底部"最后选哪个，在“确认原型”窗口里定"。切换页面、画面时它不变。
- "切换要看的内容"依次是"页面"组、当前页面的切换组（组名没写时显示"状态"）。只有一项可选的组不显示；两组都不显示时连小标题一起不显示。选中按钮高亮成黄色。
- 隔离框上方左侧固定写"▼ 被设计的页面：只有这个框里的内容要实现"；右侧有方案清单时最前面是黄色标签"方案 <字母>：<名称>"，后面是页面名称、画面名称，用" · "隔开，只有一项可选的组不写。
- 说明区和隔离框等宽，顶部标签"设计说明 · 不属于页面"和"这一块上线后不存在"，从左到右并排"这个画面的说明"、"只在原型里成立"、"还没确认的问题"。空的一块连小标题一起不显示；三块都空时没有说明区，隔离框占满右边。"还没确认的问题"按序号列出，其余按项目符号列出。说明区最高占窗口三分之一，超出时只有它自己滚动。
- 打开时选中第一个页面、它的第一个画面、方案 A。切换页面时画面回到新页面的第一个，方案不变；切换画面或方案时其余选择不变。每次切换隔离框重新载入，页面里输入的内容清空，"这个画面的说明"换成当前画面的。
- 页面开始运行前能读到当前选择：`<html>` 根元素上 `data-page` 是页面名称，`data-view` 是画面名称，`data-option` 是方案字母（没有方案清单时不存在）。
- 模型写的所有文字按纯文字显示，其中的 HTML 标签不生效。
- 窗口宽度不超过 760 像素时，从上到下是切换栏、隔离框、说明区，说明区三块上下排列，整个原型没有横向滚动。
- 文件不引用外部文件，不需要服务器。浏览器标题是"<原型名称> 第 N 版"。
- 读文件工具读到的文本里能直接看到页面的标签、文字和样式，不能编码成 base64 之类看不懂的形式。

## 涉及文件
- `src/modules/requirement/prototype-frame.ts`（新建）
- `tests/prototype-frame.test.ts`（新建）

## 成品定义
文件结构固定为下面这样。`<<TITLE>>`、`<<DATA>>`、`<<PAGE>>` 是三个填充位，用字符串拼接填入，不能用带 `$` 替换语义的 `String.replace`，否则页面里的 `$&` 会被改掉。

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><<TITLE>></title>
<style>
:root{--rail:#17202a;--rail-2:#222e3a;--rail-line:#35434f;--rail-text:#e8edf1;--rail-muted:#9fadb8;--accent:#f5b84b;--stage:#c9ced4}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%;margin:0}
body{display:grid;grid-template-columns:260px minmax(0,1fr);background:var(--stage);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.rail{background:var(--rail);color:var(--rail-text);height:100vh;overflow:auto;border-right:4px solid var(--accent)}
.rail-head{padding:16px 18px 14px;border-bottom:1px solid var(--rail-line)}
.rail-tag{display:inline-block;background:var(--accent);color:#2b2108;font-size:12px;font-weight:700;padding:2px 8px;border-radius:4px}
.rail-head h1{font-size:16px;margin:10px 0 2px;line-height:1.4;overflow-wrap:anywhere}
.rail-head p{margin:0;color:var(--rail-muted);font-size:12px}
.rail-section{padding:14px 18px;border-bottom:1px solid var(--rail-line)}
.rail-section h2,.col h2{font-size:12px;color:var(--rail-muted);font-weight:600;margin:0 0 8px;letter-spacing:.5px}
.group{margin-bottom:12px}.group:last-child{margin-bottom:0}
.group-name{font-size:12px;color:var(--rail-muted);margin-bottom:5px}
.seg{display:flex;flex-direction:column;gap:4px}
.seg button{all:unset;box-sizing:border-box;cursor:pointer;padding:7px 10px;border-radius:6px;background:var(--rail-2);color:var(--rail-text);font-size:13px;border:1px solid transparent;overflow-wrap:anywhere}
.seg button:hover{border-color:var(--rail-line)}
.seg button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.seg button[aria-pressed=true]{background:var(--accent);color:#2b2108;font-weight:600}
.option-box{margin:14px 14px 2px;padding:10px 12px;border:2px solid var(--accent);border-radius:8px;background:#2b2a20}
.option-title{font-size:14px;font-weight:700;color:var(--accent);margin-bottom:8px;line-height:1.45}
.option-foot{font-size:12px;color:var(--rail-muted);margin-top:8px;line-height:1.5}
.option-pill{background:var(--accent);color:#2b2108;font-weight:700;font-size:13px;padding:1px 10px;border-radius:4px;white-space:nowrap}
.stage{height:100vh;min-width:0;display:flex;flex-direction:column;padding:10px 14px 14px}
.stage-label{font-size:12px;color:#39424c;padding:0 2px 6px;display:flex;justify-content:space-between;gap:12px}
.stage-label b{font-weight:600}
.stage-now{display:flex;align-items:center;gap:10px;min-width:0}
iframe{flex:1;min-height:0;width:100%;border:0;background:#fff;box-shadow:0 0 0 1px #8b949d,0 6px 24px #0002;border-radius:4px}
.band{flex:0 1 auto;max-height:33.4vh;overflow:auto;margin-top:10px;background:var(--rail);color:var(--rail-text);border-top:4px solid var(--accent);border-radius:4px;padding:10px 16px 12px}
.band-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.band-head small{color:var(--rail-muted);font-size:12px}
.band-cols{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:20px}
.notes{font-size:13px;line-height:1.75;overflow-wrap:anywhere}
.notes ul,.notes ol{margin:0;padding-left:18px}
.notes li{margin-bottom:6px}
@media(max-width:760px){body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;height:auto}html{height:auto}.rail{height:auto;border-right:0;border-bottom:4px solid var(--accent)}.stage{height:auto;padding:10px 16px 16px}iframe{flex:none;height:70vh}.band{max-height:none}.band-cols{grid-auto-flow:row}}
</style>
</head>
<body>
<aside class="rail" aria-label="设计说明，不属于被设计的页面">
  <div class="rail-head"><span class="rail-tag">设计说明 · 不属于页面</span><h1 id="name"></h1><p id="version"></p></div>
  <div class="option-box" id="option-box" hidden></div>
  <div class="rail-section" id="switch-box" hidden><h2>切换要看的内容</h2><div id="switches"></div></div>
</aside>
<main class="stage">
  <div class="stage-label"><b>▼ 被设计的页面：只有这个框里的内容要实现</b><span class="stage-now"><span class="option-pill" id="where-option" hidden></span><span id="where"></span></span></div>
  <iframe id="page" title="被设计的页面"></iframe>
  <section class="band" id="band" aria-label="设计说明，不属于被设计的页面" hidden>
    <div class="band-head"><span class="rail-tag">设计说明 · 不属于页面</span><small>这一块上线后不存在</small></div>
    <div class="band-cols">
      <div class="col" id="notes-col"><h2>这个画面的说明</h2><div class="notes" id="notes"></div></div>
      <div class="col" id="only-col"><h2>只在原型里成立</h2><div class="notes" id="only"></div></div>
      <div class="col" id="open-col"><h2>还没确认的问题</h2><div class="notes" id="open"></div></div>
    </div>
  </section>
</main>
<script type="application/json" id="prototype-data"><<DATA>></script>
<textarea id="prototype-page" hidden readonly>
<<PAGE>></textarea>
<script>
(function(){
var data=JSON.parse(document.getElementById('prototype-data').textContent);
var source=document.getElementById('prototype-page').value;
var LETTERS='ABCDEF',cur={page:0,view:0,option:0};
function $(id){return document.getElementById(id)}
function optionLabel(i){return '方案 '+LETTERS.charAt(i)+'：'+data.options[i]}
function list(col,host,items,tag){$(col).hidden=!items.length;var box=$(host);box.textContent='';if(!items.length)return;var l=document.createElement(tag);items.forEach(function(t){var li=document.createElement('li');li.textContent=t;l.appendChild(li)});box.appendChild(l)}
function seg(labels,index,pick){var s=document.createElement('div');s.className='seg';labels.forEach(function(label,i){var b=document.createElement('button');b.type='button';b.textContent=label;b.setAttribute('aria-pressed',String(i===index));b.onclick=function(){pick(i)};s.appendChild(b)});return s}
function group(name,labels,index,pick){var g=document.createElement('div');g.className='group';var n=document.createElement('div');n.className='group-name';n.textContent=name;g.appendChild(n);g.appendChild(seg(labels,index,pick));return g}
function withSelection(){var p=data.pages[cur.page],sel={page:p.name,view:p.views[cur.view].name};if(data.options.length)sel.option=LETTERS.charAt(cur.option);var js='(function(r,s){for(var k in s)r.dataset[k]=s[k]})(document.documentElement,'+JSON.stringify(sel).replace(/</g,'\\u003c')+')';var head=/^\s*<!doctype[^>]*>/i.exec(source),at=head?head[0].length:0;return source.slice(0,at)+'<script>'+js+'<\/script>'+source.slice(at)}
function render(){
  var p=data.pages[cur.page],box=$('switches'),ob=$('option-box');box.textContent='';ob.textContent='';
  if(data.pages.length>1)box.appendChild(group('页面',data.pages.map(function(x){return x.name}),cur.page,function(i){cur.page=i;cur.view=0;render()}));
  if(p.views.length>1)box.appendChild(group(p.group,p.views.map(function(x){return x.name}),cur.view,function(i){cur.view=i;render()}));
  $('switch-box').hidden=!box.childNodes.length;
  ob.hidden=!data.options.length;
  if(data.options.length){var t=document.createElement('div');t.className='option-title';t.textContent='这份原型有 '+data.options.length+' 个方案，点这里切换对比';ob.appendChild(t);ob.appendChild(seg(data.options.map(function(x,i){return optionLabel(i)}),cur.option,function(i){cur.option=i;render()}));var f=document.createElement('div');f.className='option-foot';f.textContent='最后选哪个，在“确认原型”窗口里定';ob.appendChild(f)}
  var pill=$('where-option');pill.hidden=!data.options.length;pill.textContent=data.options.length?optionLabel(cur.option):'';
  var where=[];if(data.pages.length>1)where.push(p.name);if(p.views.length>1)where.push(p.views[cur.view].name);$('where').textContent=where.join(' · ');
  var notes=p.views[cur.view].notes;list('notes-col','notes',notes,'ul');list('only-col','only',data.prototypeOnly,'ul');list('open-col','open',data.openQuestions,'ol');
  $('band').hidden=!(notes.length||data.prototypeOnly.length||data.openQuestions.length);
  $('page').srcdoc=withSelection();
}
$('name').textContent=data.name;$('version').textContent='第 '+data.version+' 版 · 这一栏上线后不存在';
render();
})();
</script>
</body>
</html>
```

三个填充位的转义规则：
- `<<TITLE>>`：`<原型名称> 第 N 版`，`&` 转成 `&amp;`，`<` 转成 `&lt;`。
- `<<DATA>>`：`JSON.stringify` 后把 `<` 换成 `<`。对象字段是 `name`、`version`、`pages`、`options`、`prototypeOnly`、`openQuestions`；`pages` 每项的 `group` 已填好默认值"状态"，每个画面的 `notes` 是数组。
- `<<PAGE>>`：`&` 转成 `&amp;`，`</textarea`（不分大小写）里的 `<` 转成 `&lt;`，其余字符原样保留，这样读文件时能直接看到页面源码。`textarea` 的 `.value` 会还原这两种转义。

## 函数清单
### src/modules/requirement/prototype-frame.ts
| 函数名 | 职责 |
|---|---|
| `PrototypePage`、`PrototypeFrameInput`（类型） | 拼外框的输入：页面源码、名称、版本、页面清单、方案清单、两张说明清单 |
| `buildPrototypeFrame` | 按成品定义拼出完整 HTML，返回字符串；纯函数，不读写文件 |

## 协作关系
`buildPrototypeFrame` 不依赖其他模块，由 `submitDesign` 调用。模块依赖顺序不变：文件属于 `src/modules/requirement`。

## 验证方式
- 测试入口：`buildPrototypeFrame`（从 `src/modules/requirement/prototype-frame.ts` 导入）。
- 测试输入：页面源码 `<!doctype html><html><body><h1 class="t">每日提醒</h1><script>if(a&&b){}</script></body></html>`，名称"设置页"，版本 2，两个页面，方案清单两项，两张说明清单。
- 预期结果：返回的字符串以 `<!doctype html>` 开头，含固定文字，页面标签能直接搜到，转义可还原。
- [ ] 输出含"设计说明 · 不属于页面""▼ 被设计的页面：只有这个框里的内容要实现""这一块上线后不存在""这份原型有 "（脚本里）"最后选哪个，在“确认原型”窗口里定"。
- [ ] 输出含 `<title>设置页 第 2 版</title>`；名称含 `<` 和 `&` 时 `<title>` 里已转义。
- [ ] 输出里能直接搜到 `<h1 class="t">每日提醒</h1>`（C-13）。
- [ ] 页面含 `</textarea>`、`&amp;`、`$&`、`</script>` 时，取出 `textarea` 内容并还原 `&lt;/textarea` 和 `&amp;` 后与原页面完全相同。
- [ ] 取出 `prototype-data` 的 JSON 能解析；说明里写 `</script><script>x</script>` 时，这段 JSON 文本里没有字面的 `</script`。
- [ ] 输出里除页面自身内容外没有 `http://`、`https://`、`src=`、`<link`。
- [ ] 真实浏览器核对（由 exec 主代理用浏览器工具按本地文件打开一份样例，不写自动化测试）：默认选中项、三组切换后的隔离框 `data-page`/`data-view`/`data-option`、切换后输入清空、只有 1 个页面 1 个画面无方案时切换区和黄色标签不出现、三块说明全空时说明区不出现且隔离框占满、说明里的 `<b>` 显示成文字、长说明时说明区不超过窗口三分之一且只有它滚动、窗口变窄时三块上下排列且没有横向滚动、页面把 `body` 背景改成红色时切换栏和说明区不变。
