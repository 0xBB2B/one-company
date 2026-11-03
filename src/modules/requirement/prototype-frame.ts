export interface PrototypePage {
  name: string;
  group: string;
  views: { name: string; notes: string[] }[];
}

export interface PrototypeFrameInput {
  html: string;
  name: string;
  version: number;
  pages: PrototypePage[];
  options: string[];
  prototypeOnly: string[];
  openQuestions: string[];
}

const FRAME = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><<TITLE>></title>
<style>
:root{--rail:#0a2744;--rail-line:#2a4f78;--rail-text:#d3e8ff;--rail-muted:#86a9cd;--accent:#6fd6ff;--accent-ink:#06223c;--stage:#0e3257;--label:#a9cdf0}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{height:100%;margin:0}
body{display:grid;grid-template-columns:260px minmax(0,1fr);background:var(--stage);background-image:linear-gradient(#ffffff0b 1px,transparent 1px),linear-gradient(90deg,#ffffff0b 1px,transparent 1px);background-size:20px 20px;font:14px/1.6 Menlo,Consolas,"PingFang SC","Microsoft YaHei",monospace}
.rail{background:var(--rail);color:var(--rail-text);height:100vh;overflow:auto;border-right:1px dashed var(--accent)}
.rail-head{padding:16px 18px 14px;border-bottom:1px solid var(--rail-line)}
.rail-tag{display:inline-block;border:1px dashed var(--accent);color:var(--accent);font-size:12px;font-weight:700;padding:1px 8px}
.rail-head h1{font-size:16px;margin:10px 0 2px;line-height:1.4;overflow-wrap:anywhere}
.rail-head p{margin:0;color:var(--rail-muted);font-size:12px}
.rail-section{padding:14px 18px;border-bottom:1px solid var(--rail-line)}
.rail-section h2,.col h2{font-size:12px;color:var(--rail-muted);font-weight:600;margin:0 0 8px;letter-spacing:.5px}
.col h2{margin-bottom:2px}
.group{margin-bottom:12px}.group:last-child{margin-bottom:0}
.group-name{font-size:12px;color:var(--rail-muted);margin-bottom:5px}
.seg{display:flex;flex-direction:column;gap:4px}
.seg button{all:unset;box-sizing:border-box;cursor:pointer;padding:6px 10px;color:var(--rail-text);font-size:13px;border:1px solid var(--rail-line);overflow-wrap:anywhere}
.seg button:hover{border-color:var(--accent)}
.seg button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.seg button[aria-pressed=true]{background:var(--accent);color:var(--accent-ink);font-weight:600}
.option-box{margin:14px 14px 2px;padding:10px 12px;border:1px dashed var(--accent);background:#0d3056}
.option-title{font-size:14px;font-weight:700;color:var(--accent);margin-bottom:8px;line-height:1.45}
.option-foot{font-size:12px;color:var(--rail-muted);margin-top:8px;line-height:1.5}
.option-pill{border:1px dashed var(--accent);color:var(--accent);font-weight:700;font-size:12px;padding:0 8px;overflow-wrap:anywhere}
.stage{height:100vh;min-width:0;display:flex;flex-direction:column;padding:10px 14px 14px}
.stage-label{font-size:12px;color:var(--label);padding:0 2px 6px;display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px}
.stage-label b{font-weight:600}
.stage-now{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;min-width:0}
#where{overflow-wrap:anywhere}
iframe{flex:1;min-height:0;width:100%;margin:3px 0;border:0;background:#fff;outline:1px dashed var(--accent);outline-offset:3px}
.band{flex:0 1 auto;max-height:calc(100vh / 3);overflow:auto;margin-top:8px;background:var(--rail);color:var(--rail-text);border-top:1px dashed var(--accent);padding:6px 12px 8px}
.band-head{display:flex;align-items:center;gap:10px;margin-bottom:3px}
.band-head small{color:var(--rail-muted);font-size:12px}
.band-cols{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:20px}
.notes{font-size:13px;line-height:1.45;overflow-wrap:anywhere}
.notes ul,.notes ol{margin:0;padding-left:18px}
@media(max-width:760px){body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;height:auto}html{height:auto}.rail{height:auto;border-right:0;border-bottom:1px dashed var(--accent)}.stage{height:auto;padding:10px 16px 16px}iframe{flex:none;height:70vh}.band{max-height:none}.band-cols{grid-auto-flow:row}}
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
function withSelection(){var p=data.pages[cur.page],sel={page:p.name,view:p.views[cur.view].name};if(data.options.length)sel.option=LETTERS.charAt(cur.option);var js='(function(r,s){for(var k in s)r.dataset[k]=s[k]})(document.documentElement,'+JSON.stringify(sel).replace(/</g,'\\u003c')+')';var head=/^\s*<!doctype[^>]*>/i.exec(source),at=head?head[0].length:0;return source.slice(0,at)+'<base href="about:srcdoc"><script>'+js+'<\/script>'+source.slice(at)}
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
`;

const [beforeTitle, beforeData, beforePage, afterPage] = FRAME.split(/<<(?:TITLE|DATA|PAGE)>>/);

export function buildPrototypeFrame(input: PrototypeFrameInput): string {
  const title = `${input.name} 第 ${input.version} 版`.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const data = JSON.stringify({
    name: input.name,
    version: input.version,
    pages: input.pages,
    options: input.options,
    prototypeOnly: input.prototypeOnly,
    openQuestions: input.openQuestions,
  }).replace(/</g, "\\u003c");
  const page = input.html.replace(/&/g, "&amp;").replace(/<(\/textarea)/gi, "&lt;$1");
  return beforeTitle + title + beforeData + data + beforePage + page + afterPage;
}
