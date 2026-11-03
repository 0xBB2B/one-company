import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const siteDir = join(root, "site");
const html = (): string => readFileSync(join(siteDir, "index.html"), "utf8");

describe("项目主页", () => {
  test("site 目录下只有 index.html，没有 CNAME", () => {
    expect(readdirSync(siteDir)).toEqual(["index.html"]);
  });

  test("不加载外部字体、脚本、样式，也不用 @import", () => {
    const text = html();
    expect(text).not.toContain("<script src");
    expect(text).not.toContain('<link rel="stylesheet"');
    expect(text).not.toContain("@import");
    expect(text).not.toContain("fonts.googleapis");
  });

  test("出现的 http(s) 地址只限允许的几个", () => {
    const urls = html().match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    const bad = urls.filter(
      (u) =>
        !u.startsWith("https://github.com/0xBB2B/one-company") &&
        u !== "https://github.com/earendil-works/pi" &&
        u !== "http://www.w3.org/2000/svg",
    );
    expect(bad).toEqual([]);
  });

  test("中英文元素成对出现且数量大于 0", () => {
    const text = html();
    const zh = text.split('data-l="zh"').length - 1;
    const en = text.split('data-l="en"').length - 1;
    expect(zh).toBeGreaterThan(0);
    expect(zh).toBe(en);
  });

  test("页面标题中英文都在", () => {
    const text = html();
    expect(text).toContain("OneCompany：一个人，撑起一家有规矩的 AI 公司");
    expect(text).toContain("OneCompany: One human. A governed autonomous company.");
  });

  test("大标题中英文都在", () => {
    const text = html();
    expect(text).toContain("一个人，<br>撑起一家有规矩的 AI 公司。");
    expect(text).toContain("One human.<br>A governed autonomous company.");
  });

  test("安装命令出现在两处命令框，各带一个复制按钮", () => {
    const text = html();
    const cmd = "pi install git:github.com/0xBB2B/one-company";
    expect(text.split(cmd).length - 1).toBeGreaterThanOrEqual(3);
    const buttons = text.match(/<button\b[^>]*class="[^"]*copy[^"]*"/g) ?? [];
    expect(buttons.length).toBe(2);
  });

  test("面板说明中英文都在", () => {
    const text = html();
    expect(text).toContain("状态面板示例。产品界面目前是中文。");
    expect(text).toContain("Sample status panel. The product UI is Chinese-only today.");
  });

  test("七步流程中只有第 2、6、7 个 li 带 class=\"you\"", () => {
    const rail = html().match(/<ol class="rail">([\s\S]*?)<\/ol>/);
    expect(rail).not.toBeNull();
    const items = rail![1].match(/<li\b[^>]*>/g) ?? [];
    expect(items.length).toBe(7);
    const flags = items.map((tag) => tag.includes('class="you"'));
    expect(flags).toEqual([false, true, false, false, false, true, true]);
  });

  test("四个区块编号都在", () => {
    const text = html();
    for (const id of ["flow", "governance", "team", "start"]) {
      expect(text).toContain(`id="${id}"`);
    }
  });

  test("GitHub、pi、README、已知限制链接都在", () => {
    const text = html();
    expect(text).toContain("https://github.com/0xBB2B/one-company");
    expect(text).toContain("https://github.com/earendil-works/pi");
    expect(text).toContain("https://github.com/0xBB2B/one-company#readme");
    expect(text).toContain("https://github.com/0xBB2B/one-company#已知限制");
  });

  test("状态面板示例带工具调用次数", () => {
    const text = html();
    expect(text).toContain("↻5 · 5 tool uses · 33.8k token · 12.3s");
    expect(text).toContain("↻42 · 38 tool uses · 91.0k token · 2m17s");
  });

  test("治理卡片文字正确", () => {
    const text = html();
    expect(text).toContain("worker 改了本需求任务范围外的文件，结果被拒收。写入范围重叠的任务不会同时派出。");
    expect(text).toContain("提交带需求编号，需求完成时正文和原型归档进分支。以后能从代码查到当初为什么这样做。");
  });

  test("现状条目中英文都在", () => {
    const text = html();
    expect(text).toContain("只在 macOS 上测过");
    expect(text).toContain("真实模型验收只用 gpt-6.1-sol 跑过");
    expect(text).toContain("Tested on macOS only");
    expect(text).toContain("Live-model acceptance has only run on gpt-6.1-sol");
  });

  test("现状条目与 README 已知限制一致", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const section = readme.split(/^## 已知限制\s*$/m)[1]?.split(/^## /m)[0] ?? "";
    expect(section).toContain("只在 macOS 上测过");
    expect(section).toContain("gpt-6.1-sol");
  });
});
