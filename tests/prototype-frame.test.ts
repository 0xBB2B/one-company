import { expect, test } from "vitest";
import { buildPrototypeFrame } from "../src/modules/requirement/prototype-frame.ts";

const PAGE = '<!doctype html><html><body><h1 class="t">每日提醒</h1><script>if(a&&b){}</script></body></html>';

const baseInput = {
  html: PAGE,
  name: "设置页",
  version: 2,
  pages: [
    { name: "设置", group: "主流程", views: [{ name: "默认", notes: ["开关在右上角"] }, { name: "空状态", notes: [] }] },
    { name: "关于", group: "其他", views: [{ name: "默认", notes: ["显示版本号"] }] },
  ],
  options: ["顶部分栏", "左侧导航"],
  prototypeOnly: ["假数据：三条提醒"],
  openQuestions: ["提醒要不要支持重复？"],
};

const TEXTAREA_OPEN = '<textarea id="prototype-page" hidden readonly>\n';
const DATA_OPEN = '<script type="application/json" id="prototype-data">';

function extractPage(out: string): string {
  const start = out.indexOf(TEXTAREA_OPEN);
  expect(start).toBeGreaterThanOrEqual(0);
  const contentStart = start + TEXTAREA_OPEN.length;
  const end = out.indexOf("</textarea>", contentStart);
  expect(end).toBeGreaterThan(contentStart - 1);
  return out.slice(contentStart, end);
}

function extractData(out: string): string {
  const start = out.indexOf(DATA_OPEN);
  expect(start).toBeGreaterThanOrEqual(0);
  const contentStart = start + DATA_OPEN.length;
  const end = out.indexOf("</script>", contentStart);
  expect(end).toBeGreaterThan(contentStart - 1);
  return out.slice(contentStart, end);
}

function withoutPage(out: string): string {
  const start = out.indexOf(TEXTAREA_OPEN) + TEXTAREA_OPEN.length;
  const end = out.indexOf("</textarea>", start);
  return out.slice(0, start) + out.slice(end);
}

function restorePage(text: string): string {
  return text.replace(/&lt;(\/textarea)/gi, "<$1").replace(/&amp;/g, "&");
}

test("返回值以 doctype 开头并含全部固定文字", () => {
  const out = buildPrototypeFrame(baseInput);
  expect(out.startsWith("<!doctype html>")).toBe(true);
  for (const text of [
    "设计说明 · 不属于页面",
    "▼ 被设计的页面：只有这个框里的内容要实现",
    "这一块上线后不存在",
    "切换要看的内容",
    "这个画面的说明",
    "只在原型里成立",
    "还没确认的问题",
    "个方案，点这里切换对比",
    "最后选哪个，在“确认原型”窗口里定",
    "这一栏上线后不存在",
  ]) {
    expect(out).toContain(text);
  }
});

test("浏览器标题是名称加版本号", () => {
  expect(buildPrototypeFrame(baseInput)).toContain("<title>设置页 第 2 版</title>");
});

test("名称里的 & 和 < 在标题中被转义", () => {
  const out = buildPrototypeFrame({ ...baseInput, name: "A<B&C" });
  expect(out).toContain("<title>A&lt;B&amp;C 第 2 版</title>");
});

test("页面的标签和文字在输出里能直接搜到", () => {
  expect(buildPrototypeFrame(baseInput)).toContain('<h1 class="t">每日提醒</h1>');
});

test("页面含 textarea 结束标签和特殊字符时能原样还原", () => {
  const html = 'a</textarea>b</TEXTAREA>c &amp; d $& e $1 f </script> g <p>&</p>';
  const out = buildPrototypeFrame({ ...baseInput, html });
  expect(restorePage(extractPage(out))).toBe(html);
});

test("页面内容不会提前结束 textarea", () => {
  const html = "x</textarea>y</TEXTAREA>z";
  const out = buildPrototypeFrame({ ...baseInput, html });
  expect(out.match(/<\/textarea/gi)?.length).toBe(1);
});

test("页面里的 & 转成 &amp; 其余字符原样保留", () => {
  const out = buildPrototypeFrame({ ...baseInput, html: '<a href="x?a=1&b=2">$&</a>' });
  expect(extractPage(out)).toBe('<a href="x?a=1&amp;b=2">$&amp;</a>');
});

test("清单数据是 JSON 且与输入字段一致", () => {
  const out = buildPrototypeFrame(baseInput);
  expect(JSON.parse(extractData(out))).toEqual({
    name: baseInput.name,
    version: baseInput.version,
    pages: baseInput.pages,
    options: baseInput.options,
    prototypeOnly: baseInput.prototypeOnly,
    openQuestions: baseInput.openQuestions,
  });
});

test("说明里的 script 结束标签不会打断外框脚本且解析后还原", () => {
  const evil = "</script><script>x</script>";
  const input = {
    ...baseInput,
    pages: [{ name: "设置", group: "主流程", views: [{ name: "默认", notes: [evil] }] }],
    prototypeOnly: [evil],
    openQuestions: [evil],
  };
  const out = buildPrototypeFrame(input);
  const text = extractData(out);
  expect(text).not.toContain("</script");
  const parsed = JSON.parse(text);
  expect(parsed.pages[0].views[0].notes[0]).toBe(evil);
  expect(parsed.prototypeOnly[0]).toBe(evil);
  expect(parsed.openQuestions[0]).toBe(evil);
});

test("清单数据里的 < 全部被转成转义写法", () => {
  const out = buildPrototypeFrame({ ...baseInput, openQuestions: ["a<b"] });
  expect(extractData(out)).not.toContain("<");
});

test("除页面内容外没有外部引用", () => {
  const out = buildPrototypeFrame({ ...baseInput, html: '<img src="http://x/y.png"><link href="https://z">' });
  const rest = withoutPage(out);
  for (const banned of ["http://", "https://", "src=", "<link"]) {
    expect(rest).not.toContain(banned);
  }
});

test("相同输入两次调用结果相同", () => {
  expect(buildPrototypeFrame(baseInput)).toBe(buildPrototypeFrame(baseInput));
});

test("隔离框是沙箱，外框是蓝图风格，说明区条目收紧", () => {
  const output = buildPrototypeFrame({ html: "<!doctype html><html><body></body></html>", name: "设置页", version: 1, pages: [{ name: "页", group: "状态", views: [{ name: "正常", notes: [] }] }], options: [], prototypeOnly: [], openQuestions: [] });
  expect(output).toContain('<iframe id="page" title="被设计的页面" sandbox="allow-scripts">');
  expect(output).toContain("--rail:#0a2744");
  expect(output).toContain("--accent:#6fd6ff");
  expect(output).toContain("background-size:20px 20px");
  expect(output).toContain("border-right:1px dashed var(--accent)");
  expect(output).toContain("outline:1px dashed var(--accent)");
  expect(output).toContain(".notes{font-size:13px;line-height:1.45;");
  expect(output).not.toContain("#f5b84b");
  expect(output).not.toContain(".notes li");
});

test("页面里的链接留在隔离框里，说明区上限是窗口的三分之一，长名称不撑破窗口", () => {
  const output = buildPrototypeFrame({ html: "<!doctype html><html><body></body></html>", name: "设置页", version: 1, pages: [{ name: "页", group: "状态", views: [{ name: "正常", notes: [] }] }], options: [], prototypeOnly: [], openQuestions: [] });
  expect(output).toContain('<base href="about:srcdoc">');
  expect(output).toContain("max-height:calc(100vh / 3)");
  expect(output).not.toContain("white-space:nowrap");
  expect(output).toContain("flex-wrap:wrap");
});
