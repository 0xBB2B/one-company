import { describe, expect, test } from "vitest";
import {
  DESIGN_CHAPTERS,
  DESIGN_SPEC_MAX_BYTES,
  DesignSpecError,
  changedChapters,
  checkDesignSpec,
  contrastRatio,
  normalizeDesignSpec,
} from "../src/modules/requirement/design-spec.ts";

const VALID = `# 界面设计规范
## 风格
- 主题：明亮、暗黑
- 参考设计体系：无
## 颜色
### 明亮
- 主色：#0f766e
- 主色悬停：#115e59
- 文字：#1f2933
- 次要文字：#52606d
- 禁用文字：#9aa5b1
- 边框：#d9e2ec
- 背景：#ffffff
- 卡片背景：#f8fafc
- 成功：#15803d
- 警告：#b45309
- 出错：#b91c1c
- 提示：#1d4ed8
### 暗黑
- 主色：#2dd4bf
- 主色悬停：#5eead4
- 文字：#e5e7eb
- 次要文字：#a1a1aa
- 禁用文字：#6b7280
- 边框：#3f3f46
- 背景：#18181b
- 卡片背景：#27272a
- 成功：#4ade80
- 警告：#fbbf24
- 出错：#f87171
- 提示：#60a5fa
## 字体
- 字体：Inter, PingFang SC, sans-serif
- 标题 1 字号：24px
- 标题 2 字号：20px
- 标题 3 字号：16px
- 正文字号：14px
- 辅助文字字号：12px
- 正文行高：1.5
- 常规字重：400
- 加粗字重：600
## 间距
- 基本单位：4px
- 档位：4px、8px、12px、16px、24px、32px
## 圆角与阴影
- 小圆角：4px
- 大圆角：8px
- 卡片阴影：0 1px 2px rgba(0,0,0,.08)
- 弹窗阴影：0 8px 24px rgba(0,0,0,.16)
## 布局
- 内容区最大宽度：1200px
- 页面边距：24px
- 侧栏宽度：240px
- 顶栏高度：56px
- 手机平板分界：768px
- 平板桌面分界：1200px
## 组件
- 按钮高度：32px
- 按钮左右内边距：16px
- 输入框高度：32px
- 表格行高：40px
- 弹窗宽度：480px
- 图标尺寸：16px
## 状态
- 加载中出现时间：300ms
- 动画时长：200ms
- 提示条消失时间：3000ms
## 无障碍
- 正文最低对比度：4.5:1
- 图标和边框最低对比度：3:1
- 焦点框宽度：2px
- 最小点击区域：44×44px
## 终端界面
无
`;

const FULL_TERMINAL = `- 每行列数：80
- 成功颜色：绿
- 警告颜色：黄
- 出错颜色：红
- 提示颜色：蓝`;

const WITH_TERMINAL = VALID.replace("## 终端界面\n无\n", `## 终端界面\n${FULL_TERMINAL}\n`);

function failure(text: string): string | undefined {
  try {
    checkDesignSpec(text);
  } catch (error) {
    expect(error).toBeInstanceOf(DesignSpecError);
    return (error as Error).message;
  }
  return undefined;
}

function replaceLine(text: string, from: string, to: string): string {
  expect(text).toContain(from);
  return text.replace(from, to);
}

function removeLine(text: string, line: string): string {
  expect(text).toContain(`${line}\n`);
  return text.replace(`${line}\n`, "");
}

function swapChapters(text: string, a: string, b: string): string {
  const parts = text.split(/(?=^## )/m);
  const i = parts.findIndex((part) => part.startsWith(`## ${a}\n`));
  const j = parts.findIndex((part) => part.startsWith(`## ${b}\n`));
  expect(i).toBeGreaterThan(-1);
  expect(j).toBeGreaterThan(-1);
  [parts[i], parts[j]] = [parts[j], parts[i]];
  return parts.join("");
}

function removeSection(text: string, name: string): string {
  const pattern = new RegExp(`### ${name}\\n(?:- .*\\n)+`);
  expect(text).toMatch(pattern);
  return text.replace(pattern, "");
}

interface Item {
  label: string;
  name: string;
  line: string;
}

function requiredItems(text: string): Item[] {
  const items: Item[] = [];
  let chapter = "";
  let section = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      chapter = line.slice(3);
      section = "";
    } else if (line.startsWith("### ")) {
      section = line.slice(4);
    } else if (line.startsWith("- ")) {
      items.push({
        label: section ? `${chapter} · ${section}` : chapter,
        name: line.slice(2, line.indexOf("：")),
        line,
      });
    }
  }
  return items;
}

describe("合格全文", () => {
  test("合格全文不抛错", () => {
    expect(failure(VALID)).toBeUndefined();
  });

  test("冒号写成英文冒号仍不抛错", () => {
    expect(failure(VALID.replaceAll("：", ":"))).toBeUndefined();
  });

  test("值前后有空白仍不抛错", () => {
    expect(failure(replaceLine(VALID, "- 主色：#0f766e", "- 主色：   #0f766e  "))).toBeUndefined();
  });

  test("章里的其他行不影响判定", () => {
    expect(failure(replaceLine(VALID, "## 间距\n", "## 间距\n这是一段说明文字\n- 备注：随便写\n"))).toBeUndefined();
  });

  test("主题只写明亮并删掉暗黑一节仍不抛错", () => {
    const text = removeSection(replaceLine(VALID, "- 主题：明亮、暗黑", "- 主题：明亮"), "暗黑");
    expect(failure(text)).toBeUndefined();
  });

  test("主题只写暗黑并删掉明亮一节仍不抛错", () => {
    const text = removeSection(replaceLine(VALID, "- 主题：明亮、暗黑", "- 主题：暗黑"), "明亮");
    expect(failure(text)).toBeUndefined();
  });

  test("终端界面章写成完整必填项仍不抛错", () => {
    expect(failure(WITH_TERMINAL)).toBeUndefined();
  });

  test("终端界面章只有「无」前后带空行仍不抛错", () => {
    expect(failure(VALID.replace("## 终端界面\n无\n", "## 终端界面\n\n无\n\n"))).toBeUndefined();
  });

  test.each([
    ["字重 100", "- 常规字重：400", "- 常规字重：100"],
    ["字重 900", "- 加粗字重：600", "- 加粗字重：900"],
    ["行高整数", "- 正文行高：1.5", "- 正文行高：2"],
    ["像素带小数", "- 小圆角：4px", "- 小圆角：2.5px"],
    ["侧栏宽度写无", "- 侧栏宽度：240px", "- 侧栏宽度：无"],
    ["阴影写无", "- 卡片阴影：0 1px 2px rgba(0,0,0,.08)", "- 卡片阴影：无"],
    ["提示条不自动消失", "- 提示条消失时间：3000ms", "- 提示条消失时间：不自动消失"],
    ["点击区域用英文 x", "- 最小点击区域：44×44px", "- 最小点击区域：44x44px"],
    ["对比度比值带小数", "- 正文最低对比度：4.5:1", "- 正文最低对比度：5.5:1"],
    ["大写十六进制", "- 主色：#0f766e", "- 主色：#0F766E"],
    ["档位用英文逗号", "- 档位：4px、8px、12px、16px、24px、32px", "- 档位：4px, 8px, 12px, 16px"],
    ["参考设计体系写名称", "- 参考设计体系：无", "- 参考设计体系：Ant Design 5"],
    ["次要文字对比度恰好足够", "- 次要文字：#52606d", "- 次要文字：#6b7280"],
  ])("合法值不抛错：%s", (_name, from, to) => {
    expect(failure(replaceLine(VALID, from, to))).toBeUndefined();
  });
});

describe("字节上限", () => {
  test("常量是 16384", () => {
    expect(DESIGN_SPEC_MAX_BYTES).toBe(16384);
  });

  test("恰好 16384 字节不抛错", () => {
    const text = VALID + "\n".repeat(16384 - Buffer.byteLength(VALID));
    expect(Buffer.byteLength(text)).toBe(16384);
    expect(failure(text)).toBeUndefined();
  });

  test("16385 字节抛错", () => {
    const text = VALID + "\n".repeat(16385 - Buffer.byteLength(VALID));
    expect(failure(text)).toBe("DESIGN.md 有 16385 字节，超过 16384 字节上限");
  });

  test("按 UTF-8 字节数而不是字符数计算", () => {
    const filler = "中".repeat(Math.floor((16385 - Buffer.byteLength(VALID)) / 3) + 1);
    const text = VALID + filler;
    const bytes = Buffer.byteLength(text);
    expect(text.length).toBeLessThan(16384);
    expect(bytes).toBeGreaterThan(16384);
    expect(failure(text)).toBe(`DESIGN.md 有 ${bytes} 字节，超过 16384 字节上限`);
  });

  test("字节数先于缺章检查", () => {
    const text = "x".repeat(16385);
    expect(failure(text)).toBe("DESIGN.md 有 16385 字节，超过 16384 字节上限");
  });
});

describe("统一换行和 BOM", () => {
  test("带 BOM 且用回车换行的合格全文不抛错", () => {
    expect(failure("\uFEFF" + VALID.replaceAll("\n", "\r\n"))).toBeUndefined();
  });

  test("只带 BOM 不抛错", () => {
    expect(failure("\uFEFF" + VALID)).toBeUndefined();
  });

  test("只用回车换行不抛错", () => {
    expect(failure(VALID.replaceAll("\n", "\r\n"))).toBeUndefined();
  });

  test("字节数按交来的原文算，BOM 的 3 字节也计入", () => {
    const text = "\uFEFF" + VALID + "\n".repeat(16385 - 3 - Buffer.byteLength(VALID));
    expect(Buffer.byteLength(text)).toBe(16385);
    expect(failure(text)).toBe("DESIGN.md 有 16385 字节，超过 16384 字节上限");
  });

  test("normalizeDesignSpec 去掉开头 BOM 并把回车换行统一成换行", () => {
    expect(normalizeDesignSpec("\uFEFFa\r\nb\r\n")).toBe("a\nb\n");
  });

  test("normalizeDesignSpec 只去开头的 BOM", () => {
    expect(normalizeDesignSpec("a\uFEFFb")).toBe("a\uFEFFb");
  });

  test("normalizeDesignSpec 对已统一的文字原样返回", () => {
    expect(normalizeDesignSpec(VALID)).toBe(VALID);
  });
});

describe("另加的章", () => {
  test("末尾另加图表章不抛错", () => {
    expect(failure(VALID + "## 图表\n随便写\n- 主色：不查\n")).toBeUndefined();
  });

  test("十章中间另加一章不抛错", () => {
    expect(failure(replaceLine(VALID, "## 颜色\n", "## 图表\n随便写\n## 颜色\n"))).toBeUndefined();
  });
});

describe("重复的章", () => {
  test("颜色章出现两次抛错", () => {
    expect(failure(VALID + "## 颜色\n")).toBe("DESIGN.md 的「颜色」章出现了两次，合成一章");
  });

  test("图表章出现两次抛错", () => {
    expect(failure(VALID + "## 图表\na\n## 图表\nb\n")).toBe("DESIGN.md 的「图表」章出现了两次，合成一章");
  });

  test("多个章重复时按出现顺序报第一个重复的", () => {
    const text = VALID + "## 组件\n## 颜色\n";
    expect(failure(text)).toBe("DESIGN.md 的「组件」章出现了两次，合成一章");
  });

  test("重复章先于缺章检查", () => {
    const text = removeLine(VALID, "## 字体") + "## 颜色\n";
    expect(failure(text)).toBe("DESIGN.md 的「颜色」章出现了两次，合成一章");
  });

  test("字节数先于重复章检查", () => {
    const text = VALID + "## 颜色\n" + "\n".repeat(16385);
    expect(failure(text)).toBe(`DESIGN.md 有 ${Buffer.byteLength(text)} 字节，超过 16384 字节上限`);
  });
});

describe("重复的必填项", () => {
  test("明亮一节主色写两行抛错", () => {
    const text = replaceLine(VALID, "- 主色：#0f766e", "- 主色：#0f766e\n- 主色：#115e59");
    expect(failure(text)).toBe("DESIGN.md「颜色 · 明亮」的「主色」写了两次，只留一行");
  });

  test("暗黑一节背景写两行抛错", () => {
    const text = replaceLine(VALID, "- 背景：#18181b", "- 背景：#18181b\n- 背景：#18181b");
    expect(failure(text)).toBe("DESIGN.md「颜色 · 暗黑」的「背景」写了两次，只留一行");
  });

  test("字体章字体写两行抛错", () => {
    const text = replaceLine(VALID, "- 字体：Inter, PingFang SC, sans-serif", "- 字体：Inter\n- 字体：Arial");
    expect(failure(text)).toBe("DESIGN.md「字体」的「字体」写了两次，只留一行");
  });

  test("终端界面章必填项写两行抛错", () => {
    const text = replaceLine(WITH_TERMINAL, "- 每行列数：80", "- 每行列数：80\n- 每行列数：100");
    expect(failure(text)).toBe("DESIGN.md「终端界面」的「每行列数」写了两次，只留一行");
  });

  test("两行用不同冒号写也算重复", () => {
    const text = replaceLine(VALID, "- 基本单位：4px", "- 基本单位：4px\n- 基本单位:4px");
    expect(failure(text)).toBe("DESIGN.md「间距」的「基本单位」写了两次，只留一行");
  });

  test("重复的项先于格式检查", () => {
    const text = replaceLine(VALID, "- 主色：#0f766e", "- 主色：teal\n- 主色：#0f766e");
    expect(failure(text)).toBe("DESIGN.md「颜色 · 明亮」的「主色」写了两次，只留一行");
  });

  test("重复的项先于缺项检查", () => {
    const text = removeLine(replaceLine(VALID, "- 主色：#0f766e", "- 主色：#0f766e\n- 主色：#0f766e"), "- 主色悬停：#115e59");
    expect(failure(text)).toBe("DESIGN.md「颜色 · 明亮」的「主色」写了两次，只留一行");
  });

  test("不同章里同名的项不算重复", () => {
    expect(failure(replaceLine(VALID, "## 状态\n", "## 状态\n- 主色：备注\n"))).toBeUndefined();
  });
});

describe("重复的颜色节", () => {
  test("明亮一节出现两次抛错", () => {
    const text = replaceLine(VALID, "### 暗黑\n", "### 明亮\n- 主色：#0f766e\n### 暗黑\n");
    expect(failure(text)).toBe("DESIGN.md「颜色」的「明亮」一节出现了两次，合成一节");
  });

  test("重复的节先于缺节检查", () => {
    const text = replaceLine(VALID, "### 暗黑\n", "### 明亮\n");
    expect(failure(text)).toBe("DESIGN.md「颜色」的「明亮」一节出现了两次，合成一节");
  });

  test("暗黑一节出现两次抛错", () => {
    const text = VALID.replace("## 字体\n", "### 暗黑\n## 字体\n");
    expect(failure(text)).toBe("DESIGN.md「颜色」的「暗黑」一节出现了两次，合成一节");
  });
});

describe("十章", () => {
  test("章名按规定顺序列出", () => {
    expect([...DESIGN_CHAPTERS]).toEqual([
      "风格",
      "颜色",
      "字体",
      "间距",
      "圆角与阴影",
      "布局",
      "组件",
      "状态",
      "无障碍",
      "终端界面",
    ]);
  });

  test.each(["风格", "颜色", "字体", "间距", "圆角与阴影", "布局", "组件", "状态", "无障碍", "终端界面"])(
    "删掉「%s」章标题抛缺章",
    (chapter) => {
      const text = removeLine(VALID, `## ${chapter}`);
      expect(failure(text)).toBe(`DESIGN.md 缺少「${chapter}」章`);
    },
  );

  test("章名多一个字算缺章", () => {
    expect(failure(replaceLine(VALID, "## 颜色\n", "## 颜色们\n"))).toBe("DESIGN.md 缺少「颜色」章");
  });

  test("章名少一个字算缺章", () => {
    expect(failure(replaceLine(VALID, "## 圆角与阴影\n", "## 圆角与阴\n"))).toBe("DESIGN.md 缺少「圆角与阴影」章");
  });

  test("缺多章时按十章顺序报第一个缺的", () => {
    const text = removeLine(removeLine(VALID, "## 组件"), "## 字体");
    expect(failure(text)).toBe("DESIGN.md 缺少「字体」章");
  });

  test("空文本报缺第一章", () => {
    expect(failure("")).toBe("DESIGN.md 缺少「风格」章");
  });
});

describe("必填项缺失", () => {
  const items = [...requiredItems(VALID), ...requiredItems(WITH_TERMINAL).filter((item) => item.label === "终端界面")];
  const source = (label: string) => (label === "终端界面" ? WITH_TERMINAL : VALID);

  test.each(items.map((item) => [`${item.label}/${item.name}`, item] as const))("删掉 %s 抛缺项", (_name, item) => {
    const text = removeLine(source(item.label), item.line);
    expect(failure(text)).toBe(`DESIGN.md「${item.label}」缺少「${item.name}」`);
  });

  test("明亮一节整节缺失", () => {
    expect(failure(removeSection(VALID, "明亮"))).toBe("DESIGN.md「颜色」缺少「明亮」一节");
  });

  test("暗黑一节整节缺失", () => {
    expect(failure(removeSection(VALID, "暗黑"))).toBe("DESIGN.md「颜色」缺少「暗黑」一节");
  });

  test("按章顺序报第一个缺项", () => {
    const text = removeLine(removeLine(VALID, "- 按钮高度：32px"), "- 基本单位：4px");
    expect(failure(text)).toBe("DESIGN.md「间距」缺少「基本单位」");
  });

  test("同一章内按项顺序报第一个缺项", () => {
    const text = removeLine(removeLine(VALID, "- 弹窗宽度：480px"), "- 表格行高：40px");
    expect(failure(text)).toBe("DESIGN.md「组件」缺少「表格行高」");
  });

  test("项名写在别的章里不算数", () => {
    const text = removeLine(VALID, "- 按钮高度：32px").replace("## 状态\n", "## 状态\n- 按钮高度：32px\n");
    expect(failure(text)).toBe("DESIGN.md「组件」缺少「按钮高度」");
  });

  test("终端界面章写了内容但不是完整必填项时抛缺项", () => {
    const text = VALID.replace("## 终端界面\n无\n", "## 终端界面\n- 每行列数：80\n");
    expect(failure(text)).toBe("DESIGN.md「终端界面」缺少「成功颜色」");
  });
});

describe("值的格式", () => {
  const FORMAT = {
    hex: ["# 加 6 位十六进制", "#0f766e"],
    px: ["像素", ""],
    ms: ["毫秒", "300ms"],
  } as const;

  test.each([
    ["颜色 · 明亮", "主色", "- 主色：#0f766e", "0f766e", FORMAT.hex],
    ["颜色 · 明亮", "背景", "- 背景：#ffffff", "#fff", FORMAT.hex],
    ["颜色 · 明亮", "提示", "- 提示：#1d4ed8", "#1d4ed80", FORMAT.hex],
    ["颜色 · 明亮", "出错", "- 出错：#b91c1c", "#gggggg", FORMAT.hex],
    ["颜色 · 暗黑", "主色", "- 主色：#2dd4bf", "teal", FORMAT.hex],
  ] as const)("%s 的「%s」写错格式抛错", (label, name, from, bad, [desc, example]) => {
    const text = replaceLine(VALID, from, `- ${name}：${bad}`);
    expect(failure(text)).toBe(`DESIGN.md「${label}」的「${name}」要写成${desc}，如${example}`);
  });

  test.each([
    ["字体", "标题 1 字号", "- 标题 1 字号：24px", "24", "像素", "14px"],
    ["字体", "辅助文字字号", "- 辅助文字字号：12px", "12 px", "像素", "14px"],
    ["字体", "正文行高", "- 正文行高：1.5", "1.5倍", "倍数", "1.5"],
    ["字体", "常规字重", "- 常规字重：400", "450", "100 到 900 之间的整百数", "400"],
    ["字体", "加粗字重", "- 加粗字重：600", "1000", "100 到 900 之间的整百数", "400"],
    ["字体", "常规字重", "- 常规字重：400", "0", "100 到 900 之间的整百数", "400"],
    ["间距", "基本单位", "- 基本单位：4px", "4", "像素", "4px"],
    ["间距", "档位", "- 档位：4px、8px、12px、16px、24px、32px", "4px、八px", "一组像素值，用英文逗号或顿号隔开", "4px、8px、16px"],
    ["圆角与阴影", "小圆角", "- 小圆角：4px", "4", "像素", "4px"],
    ["圆角与阴影", "大圆角", "- 大圆角：8px", "大", "像素", "4px"],
    ["布局", "内容区最大宽度", "- 内容区最大宽度：1200px", "1200", "像素", "1200px"],
    ["布局", "页面边距", "- 页面边距：24px", "-24px", "像素", "1200px"],
    ["布局", "手机平板分界", "- 手机平板分界：768px", "768ms", "像素", "1200px"],
    ["布局", "平板桌面分界", "- 平板桌面分界：1200px", "1200 px", "像素", "1200px"],
    ["组件", "按钮高度", "- 按钮高度：32px", "32", "像素", "32px"],
    ["组件", "图标尺寸", "- 图标尺寸：16px", "16em", "像素", "32px"],
    ["状态", "加载中出现时间", "- 加载中出现时间：300ms", "300", "毫秒", "300ms"],
    ["状态", "动画时长", "- 动画时长：200ms", "0.2s", "毫秒", "300ms"],
    ["无障碍", "正文最低对比度", "- 正文最低对比度：4.5:1", "4.5", "比值", "4.5:1"],
    ["无障碍", "图标和边框最低对比度", "- 图标和边框最低对比度：3:1", "3比1", "比值", "4.5:1"],
    ["无障碍", "焦点框宽度", "- 焦点框宽度：2px", "2", "像素", "2px"],
    ["无障碍", "最小点击区域", "- 最小点击区域：44×44px", "44px", "宽×高像素", "44×44px"],
    ["无障碍", "最小点击区域", "- 最小点击区域：44×44px", "44*44px", "宽×高像素", "44×44px"],
  ] as const)("%s 的「%s」写成「%s」抛错", (label, name, from, bad, desc, example) => {
    const text = replaceLine(VALID, from, `- ${name}：${bad}`);
    expect(failure(text)).toBe(`DESIGN.md「${label}」的「${name}」要写成${desc}，如${example}`);
  });

  test.each([
    ["每行列数", "- 每行列数：80", "80.5", "正整数", "80"],
    ["每行列数", "- 每行列数：80", "0列", "正整数", "80"],
    ["成功颜色", "- 成功颜色：绿", "紫", "红、绿、黄、蓝、品红、青、白、灰之一", "绿"],
    ["提示颜色", "- 提示颜色：蓝", "blue", "红、绿、黄、蓝、品红、青、白、灰之一", "绿"],
  ] as const)("终端界面的「%s」写成「%s」抛错", (name, from, bad, desc, example) => {
    const text = replaceLine(WITH_TERMINAL, from, `- ${name}：${bad}`);
    expect(failure(text)).toBe(`DESIGN.md「终端界面」的「${name}」要写成${desc}，如${example}`);
  });

  test.each([
    ["风格", "主题", "- 主题：明亮、暗黑", "彩色"],
    ["布局", "侧栏宽度", "- 侧栏宽度：240px", "宽"],
    ["布局", "顶栏高度", "- 顶栏高度：56px", "56"],
    ["状态", "提示条消失时间", "- 提示条消失时间：3000ms", "3秒"],
  ] as const)("%s 的「%s」写成「%s」抛格式错误", (label, name, from, bad) => {
    const text = replaceLine(VALID, from, `- ${name}：${bad}`);
    const reason = failure(text);
    expect(reason).toBeDefined();
    expect(reason!.startsWith(`DESIGN.md「${label}」的「${name}」要写成`)).toBe(true);
  });

  test("按章顺序报第一个格式问题", () => {
    let text = replaceLine(VALID, "- 按钮高度：32px", "- 按钮高度：32");
    text = replaceLine(text, "- 小圆角：4px", "- 小圆角：4");
    expect(failure(text)).toBe("DESIGN.md「圆角与阴影」的「小圆角」要写成像素，如4px");
  });

  test("缺项先于后面章的格式错误", () => {
    let text = removeLine(VALID, "- 弹窗宽度：480px");
    text = replaceLine(text, "- 动画时长：200ms", "- 动画时长：200");
    expect(failure(text)).toBe("DESIGN.md「组件」缺少「弹窗宽度」");
  });
});

describe("间距倍数", () => {
  test("档位含 10px 而基本单位是 4px 抛错", () => {
    const text = replaceLine(VALID, "4px、8px、12px", "4px、8px、10px");
    expect(failure(text)).toBe("DESIGN.md「间距」的档位 10px 不是基本单位 4px 的整数倍");
  });

  test("多个档位不合格时报第一个", () => {
    const text = replaceLine(VALID, "- 档位：4px、8px、12px、16px、24px、32px", "- 档位：4px、10px、14px");
    expect(failure(text)).toBe("DESIGN.md「间距」的档位 10px 不是基本单位 4px 的整数倍");
  });

  test("基本单位改成 5px 时 12px 不是倍数", () => {
    const text = replaceLine(VALID, "- 基本单位：4px", "- 基本单位：5px");
    expect(failure(text)).toBe("DESIGN.md「间距」的档位 4px 不是基本单位 5px 的整数倍");
  });

  test("档位用英文逗号隔开时同样检查", () => {
    const text = replaceLine(VALID, "- 档位：4px、8px、12px、16px、24px、32px", "- 档位：4px, 8px, 10px");
    expect(failure(text)).toBe("DESIGN.md「间距」的档位 10px 不是基本单位 4px 的整数倍");
  });
});

describe("无障碍下限", () => {
  test("正文最低对比度写 4:1 抛错", () => {
    const text = replaceLine(VALID, "- 正文最低对比度：4.5:1", "- 正文最低对比度：4:1");
    expect(failure(text)).toBe("DESIGN.md「无障碍」的「正文最低对比度」写的是 4:1，不能低于 4.5:1");
  });

  test("图标和边框最低对比度写 2.5:1 抛错", () => {
    const text = replaceLine(VALID, "- 图标和边框最低对比度：3:1", "- 图标和边框最低对比度：2.5:1");
    expect(failure(text)).toBe("DESIGN.md「无障碍」的「图标和边框最低对比度」写的是 2.5:1，不能低于 3:1");
  });

  test("两项都低于下限时先报正文最低对比度", () => {
    let text = replaceLine(VALID, "- 正文最低对比度：4.5:1", "- 正文最低对比度：4:1");
    text = replaceLine(text, "- 图标和边框最低对比度：3:1", "- 图标和边框最低对比度：2.5:1");
    expect(failure(text)).toBe("DESIGN.md「无障碍」的「正文最低对比度」写的是 4:1，不能低于 4.5:1");
  });

  test("恰好等于下限不抛错", () => {
    expect(failure(VALID)).toBeUndefined();
  });

  test("无障碍下限先于实算对比度", () => {
    let text = replaceLine(VALID, "- 次要文字：#52606d", "- 次要文字：#999999");
    text = replaceLine(text, "- 正文最低对比度：4.5:1", "- 正文最低对比度：4:1");
    expect(failure(text)).toBe("DESIGN.md「无障碍」的「正文最低对比度」写的是 4:1，不能低于 4.5:1");
  });

  test("间距倍数先于无障碍下限", () => {
    let text = replaceLine(VALID, "4px、8px、12px", "4px、8px、10px");
    text = replaceLine(text, "- 正文最低对比度：4.5:1", "- 正文最低对比度：4:1");
    expect(failure(text)).toBe("DESIGN.md「间距」的档位 10px 不是基本单位 4px 的整数倍");
  });
});

describe("实算对比度", () => {
  test("明亮一节次要文字 #999999 抛错", () => {
    const text = replaceLine(VALID, "- 次要文字：#52606d", "- 次要文字：#999999");
    expect(failure(text)).toBe(
      "DESIGN.md「颜色 · 明亮」里次要文字 #999999 和背景 #ffffff 的对比度是 2.85:1，低于「无障碍」写的正文最低对比度 4.5:1",
    );
  });

  test("明亮一节文字对背景不足抛错", () => {
    const text = replaceLine(VALID, "- 文字：#1f2933", "- 文字：#999999");
    expect(failure(text)).toBe(
      "DESIGN.md「颜色 · 明亮」里文字 #999999 和背景 #ffffff 的对比度是 2.85:1，低于「无障碍」写的正文最低对比度 4.5:1",
    );
  });

  test("明亮一节主色 #a7f3d0 抛错并写图标和边框最低对比度", () => {
    const text = replaceLine(VALID, "- 主色：#0f766e", "- 主色：#a7f3d0");
    expect(failure(text)).toBe(
      "DESIGN.md「颜色 · 明亮」里主色 #a7f3d0 和背景 #ffffff 的对比度是 1.28:1，低于「无障碍」写的图标和边框最低对比度 3:1",
    );
  });

  test("暗黑一节文字 #3f3f46 抛错", () => {
    const text = replaceLine(VALID, "- 文字：#e5e7eb", "- 文字：#3f3f46");
    expect(failure(text)).toBe(
      "DESIGN.md「颜色 · 暗黑」里文字 #3f3f46 和背景 #18181b 的对比度是 1.70:1，低于「无障碍」写的正文最低对比度 4.5:1",
    );
  });

  test("同一节文字和次要文字都不足时先报文字", () => {
    let text = replaceLine(VALID, "- 文字：#1f2933", "- 文字：#999999");
    text = replaceLine(text, "- 次要文字：#52606d", "- 次要文字：#999999");
    expect(failure(text)).toContain("里文字 #999999");
  });

  test("同一节次要文字和主色都不足时先报次要文字", () => {
    let text = replaceLine(VALID, "- 次要文字：#52606d", "- 次要文字：#999999");
    text = replaceLine(text, "- 主色：#0f766e", "- 主色：#a7f3d0");
    expect(failure(text)).toContain("里次要文字 #999999");
  });

  test("明亮暗黑两节都不足时先报明亮", () => {
    let text = replaceLine(VALID, "- 次要文字：#52606d", "- 次要文字：#999999");
    text = replaceLine(text, "- 文字：#e5e7eb", "- 文字：#3f3f46");
    expect(failure(text)).toContain("DESIGN.md「颜色 · 明亮」里次要文字");
  });

  test("阈值取「无障碍」章写的值", () => {
    const text = replaceLine(VALID, "- 正文最低对比度：4.5:1", "- 正文最低对比度：16:1");
    expect(failure(text)).toBe(
      "DESIGN.md「颜色 · 明亮」里文字 #1f2933 和背景 #ffffff 的对比度是 14.76:1，低于「无障碍」写的正文最低对比度 16:1",
    );
  });
});

describe("contrastRatio", () => {
  test.each([
    ["#999999", "#ffffff", 2.85],
    ["#6b7280", "#ffffff", 4.83],
    ["#0f766e", "#ffffff", 5.47],
    ["#000000", "#ffffff", 21],
  ])("%s 对 %s 保留两位为 %s", (a, b, expected) => {
    expect(Number(contrastRatio(a, b).toFixed(2))).toBe(expected);
  });

  test("两个色值交换位置结果相同", () => {
    expect(contrastRatio("#ffffff", "#999999")).toBeCloseTo(contrastRatio("#999999", "#ffffff"), 10);
  });

  test("同色对比度是 1", () => {
    expect(contrastRatio("#18181b", "#18181b")).toBeCloseTo(1, 10);
  });
});

describe("changedChapters", () => {
  test("只改组件章时返回组件", () => {
    const after = replaceLine(VALID, "- 按钮高度：32px", "- 按钮高度：40px");
    expect(changedChapters(VALID, after)).toEqual(["组件"]);
  });

  test("改颜色和组件时按十章顺序返回", () => {
    let after = replaceLine(VALID, "- 按钮高度：32px", "- 按钮高度：40px");
    after = replaceLine(after, "- 主色：#0f766e", "- 主色：#0f766f");
    expect(changedChapters(VALID, after)).toEqual(["颜色", "组件"]);
  });

  test("完全相同返回空数组", () => {
    expect(changedChapters(VALID, VALID)).toEqual([]);
  });

  test("章正文里多出空行和空格算这章变了", () => {
    const after = replaceLine(VALID, "## 状态\n", "## 状态\n\n\n").replace("## 无障碍", "   \n## 无障碍");
    expect(changedChapters(VALID, after)).toEqual(["状态"]);
  });

  test("章正文末尾多一个空格算这章变了", () => {
    const after = replaceLine(VALID, "- 图标尺寸：16px\n", "- 图标尺寸：16px \n");
    expect(changedChapters(VALID, after)).toEqual(["组件"]);
  });

  test("整份全文末尾多出空行算最后一章变了", () => {
    expect(changedChapters(VALID, VALID + "\n\n")).toEqual(["终端界面"]);
  });

  test("新加图表章返回图表", () => {
    expect(changedChapters(VALID, VALID + "## 图表\n内容\n")).toEqual(["图表"]);
  });

  test("删掉图表章返回图表", () => {
    expect(changedChapters(VALID + "## 图表\n内容\n", VALID)).toEqual(["图表"]);
  });

  test("只改第一行标题返回开头的说明", () => {
    const after = replaceLine(VALID, "# 界面设计规范", "# 设计规范");
    expect(changedChapters(VALID, after)).toEqual(["开头的说明"]);
  });

  test("同样内容一份用回车换行一份用换行返回空数组", () => {
    expect(changedChapters(VALID.replaceAll("\n", "\r\n"), VALID)).toEqual([]);
  });

  test("一份带 BOM 一份不带返回空数组", () => {
    expect(changedChapters("\uFEFF" + VALID, VALID)).toEqual([]);
  });

  test("只调换两章顺序返回空数组", () => {
    expect(changedChapters(VALID, swapChapters(VALID, "组件", "状态"))).toEqual([]);
  });

  test("调换顺序的同时改了一章只返回改了的章", () => {
    const after = replaceLine(swapChapters(VALID, "组件", "状态"), "- 动画时长：200ms", "- 动画时长：250ms");
    expect(changedChapters(VALID, after)).toEqual(["状态"]);
  });

  test("先列十章里不同的，再列新全文里的其他章，再列被删掉的其他章，最后列开头的说明", () => {
    const before = VALID + "## 甲\n1\n## 乙\n2\n## 丙\n3\n";
    let after = VALID + "## 丁\n4\n## 乙\n2x\n## 戊\n5\n";
    after = replaceLine(after, "- 主色：#0f766e", "- 主色：#0f766f");
    after = replaceLine(after, "- 按钮高度：32px", "- 按钮高度：40px");
    after = replaceLine(after, "# 界面设计规范", "# 设计规范");
    expect(changedChapters(before, after)).toEqual(["颜色", "组件", "丁", "乙", "戊", "甲", "丙", "开头的说明"]);
  });

  test("终端界面章从无改成完整必填项时返回终端界面", () => {
    expect(changedChapters(VALID, WITH_TERMINAL)).toEqual(["终端界面"]);
  });

  test("改第一章和最后一章时返回风格和终端界面", () => {
    const after = replaceLine(WITH_TERMINAL, "- 参考设计体系：无", "- 参考设计体系：Ant Design 5");
    expect(changedChapters(VALID, after)).toEqual(["风格", "终端界面"]);
  });
});
