export const DESIGN_SPEC_FILE = "DESIGN.md";
export const DESIGN_SPEC_MAX_BYTES = 16384;
export const DESIGN_CHAPTERS = [
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
] as const;

export class DesignSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesignSpecError";
  }
}

interface Format {
  desc: string;
  example: string;
  valid: (value: string) => boolean;
}

type ItemSpec = readonly [string, Format];

const PX = /^\d+(\.\d+)?px$/;
const TERMINAL_COLORS = ["红", "绿", "黄", "蓝", "品红", "青", "白", "灰"];

const px = (example: string): Format => ({ desc: "像素", example, valid: (v) => PX.test(v) });
const pxOrNone = (example: string): Format => ({
  desc: '像素或"无"',
  example,
  valid: (v) => v === "无" || PX.test(v),
});
const ms = (example: string): Format => ({ desc: "毫秒", example, valid: (v) => /^\d+ms$/.test(v) });
const ratio = (): Format => ({ desc: "比值", example: "4.5:1", valid: (v) => /^\d+(\.\d+)?:1$/.test(v) });
const nonEmpty = (desc: string, example: string): Format => ({ desc, example, valid: (v) => v !== "" });
const hex: Format = { desc: "# 加 6 位十六进制", example: "#0f766e", valid: (v) => /^#[0-9a-fA-F]{6}$/.test(v) };
const terminalColor: Format = {
  desc: "红、绿、黄、蓝、品红、青、白、灰之一",
  example: "绿",
  valid: (v) => TERMINAL_COLORS.includes(v),
};
const shadow = nonEmpty('CSS 阴影值或"无"', "0 1px 2px rgba(0,0,0,.08)");
const weight: Format = {
  desc: "100 到 900 之间的整百数",
  example: "400",
  valid: (v) => /^[1-9]00$/.test(v),
};

const COLOR_ITEMS = [
  "主色",
  "主色悬停",
  "文字",
  "次要文字",
  "禁用文字",
  "边框",
  "背景",
  "卡片背景",
  "成功",
  "警告",
  "出错",
  "提示",
];
const COLOR_SPEC: ItemSpec[] = COLOR_ITEMS.map((name) => [name, hex]);

const THEME_VALUES = ["明亮", "暗黑", "明亮、暗黑"];

const SPECS: Record<string, ItemSpec[]> = {
  风格: [
    [
      "主题",
      {
        desc: '"明亮"、"暗黑"或"明亮、暗黑"',
        example: "明亮、暗黑",
        valid: (v) => THEME_VALUES.includes(v),
      },
    ],
    ["参考设计体系", nonEmpty('设计体系名称或"无"', "Ant Design 5")],
  ],
  字体: [
    ["字体", nonEmpty("字体名，多个用英文逗号隔开", "Inter, PingFang SC")],
    ["标题 1 字号", px("14px")],
    ["标题 2 字号", px("14px")],
    ["标题 3 字号", px("14px")],
    ["正文字号", px("14px")],
    ["辅助文字字号", px("14px")],
    ["正文行高", { desc: "倍数", example: "1.5", valid: (v) => /^\d+(\.\d+)?$/.test(v) }],
    ["常规字重", weight],
    ["加粗字重", weight],
  ],
  间距: [
    ["基本单位", px("4px")],
    [
      "档位",
      {
        desc: "一组像素值，用英文逗号或顿号隔开",
        example: "4px、8px、16px",
        valid: (v) => splitTiers(v).every((tier) => PX.test(tier)),
      },
    ],
  ],
  圆角与阴影: [
    ["小圆角", px("4px")],
    ["大圆角", px("4px")],
    ["卡片阴影", shadow],
    ["弹窗阴影", shadow],
  ],
  布局: [
    ["内容区最大宽度", px("1200px")],
    ["页面边距", px("1200px")],
    ["侧栏宽度", pxOrNone("240px")],
    ["顶栏高度", pxOrNone("240px")],
    ["手机平板分界", px("1200px")],
    ["平板桌面分界", px("1200px")],
  ],
  组件: [
    ["按钮高度", px("32px")],
    ["按钮左右内边距", px("32px")],
    ["输入框高度", px("32px")],
    ["表格行高", px("32px")],
    ["弹窗宽度", px("32px")],
    ["图标尺寸", px("32px")],
  ],
  状态: [
    ["加载中出现时间", ms("300ms")],
    ["动画时长", ms("300ms")],
    [
      "提示条消失时间",
      {
        desc: '毫秒或"不自动消失"',
        example: "3000ms",
        valid: (v) => v === "不自动消失" || /^\d+ms$/.test(v),
      },
    ],
  ],
  无障碍: [
    ["正文最低对比度", ratio()],
    ["图标和边框最低对比度", ratio()],
    ["焦点框宽度", px("2px")],
    [
      "最小点击区域",
      { desc: "宽×高像素", example: "44×44px", valid: (v) => /^\d+[×x]\d+px$/.test(v) },
    ],
  ],
  终端界面: [
    ["每行列数", { desc: "正整数", example: "80", valid: (v) => /^[1-9]\d*$/.test(v) }],
    ["成功颜色", terminalColor],
    ["警告颜色", terminalColor],
    ["出错颜色", terminalColor],
    ["提示颜色", terminalColor],
  ],
};

const CONTRAST_FLOORS: readonly (readonly [string, number])[] = [
  ["正文最低对比度", 4.5],
  ["图标和边框最低对比度", 3],
];

const CONTRAST_CHECKS: readonly (readonly [string, string])[] = [
  ["文字", "正文最低对比度"],
  ["次要文字", "正文最低对比度"],
  ["主色", "图标和边框最低对比度"],
];

function splitTiers(value: string): string[] {
  return value.split(/\s*[,、]\s*/);
}

function parseItems(lines: string[]): Map<string, string[]> {
  const items = new Map<string, string[]>();
  for (const line of lines) {
    const match = /^- ([^：:]+)[：:](.*)$/.exec(line.trimEnd());
    if (!match) continue;
    const name = match[1]!.trim();
    items.set(name, [...(items.get(name) ?? []), match[2]!.trim()]);
  }
  return items;
}

function checkItems(label: string, lines: string[], specs: ItemSpec[]): Map<string, string> {
  const items = parseItems(lines);
  const result = new Map<string, string>();
  for (const [name, format] of specs) {
    const values = items.get(name);
    if (values !== undefined && values.length > 1) {
      throw new DesignSpecError(`DESIGN.md「${label}」的「${name}」写了两次，只留一行`);
    }
    const value = values?.[0];
    if (value === undefined) throw new DesignSpecError(`DESIGN.md「${label}」缺少「${name}」`);
    if (!format.valid(value)) {
      throw new DesignSpecError(`DESIGN.md「${label}」的「${name}」要写成${format.desc}，如${format.example}`);
    }
    result.set(name, value);
  }
  return result;
}

function splitSections(lines: string[]): [string, string[]][] {
  const sections: [string, string[]][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (line.startsWith("### ")) {
      current = [];
      sections.push([line.slice(4).trim(), current]);
    } else {
      current?.push(line);
    }
  }
  return sections;
}

function isNone(lines: string[]): boolean {
  const nonBlank = lines.filter((line) => line.trim() !== "");
  return nonBlank.length === 1 && nonBlank[0]!.trim() === "无";
}

export function normalizeDesignSpec(text: string): string {
  return text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
}

function splitChapters(text: string): { head: string; chapters: [string, string][] } {
  const parts = normalizeDesignSpec(text).split(/^(?=## )/m);
  const head = parts[0]!.startsWith("## ") ? "" : parts.shift()!;
  return { head, chapters: parts.map((part) => [part.split("\n", 1)[0]!.slice(3).trim(), part]) };
}

export function designChapters(text: string): Map<string, string> {
  const chapters = new Map<string, string>();
  for (const [name, part] of splitChapters(text).chapters) {
    if (!chapters.has(name)) chapters.set(name, part.split("\n").slice(1).join("\n"));
  }
  return chapters;
}

export function changedChapters(before: string, after: string): string[] {
  const oldSplit = splitChapters(before);
  const newSplit = splitChapters(after);
  const oldChapters = new Map(oldSplit.chapters);
  const newChapters = new Map(newSplit.chapters);
  const known: readonly string[] = DESIGN_CHAPTERS;
  const changed = DESIGN_CHAPTERS.filter((name) => oldChapters.get(name) !== newChapters.get(name));
  const added = [...newChapters.keys()].filter((name) => !known.includes(name) && oldChapters.get(name) !== newChapters.get(name));
  const removed = [...oldChapters.keys()].filter((name) => !known.includes(name) && !newChapters.has(name));
  const result = [...changed, ...added, ...removed];
  if (oldSplit.head !== newSplit.head) result.push("开头的说明");
  return result;
}

function luminance(color: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(color.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function checkDesignSpec(text: string): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > DESIGN_SPEC_MAX_BYTES) {
    throw new DesignSpecError(`DESIGN.md 有 ${bytes} 字节，超过 ${DESIGN_SPEC_MAX_BYTES} 字节上限`);
  }

  const seen = new Set<string>();
  for (const [name] of splitChapters(text).chapters) {
    if (seen.has(name)) throw new DesignSpecError(`DESIGN.md 的「${name}」章出现了两次，合成一章`);
    seen.add(name);
  }
  const chapters = designChapters(text);
  for (const name of DESIGN_CHAPTERS) {
    if (!chapters.has(name)) throw new DesignSpecError(`DESIGN.md 缺少「${name}」章`);
  }

  const parsed = new Map<string, Map<string, string>>();
  const colors: [string, Map<string, string>][] = [];
  for (const chapter of DESIGN_CHAPTERS) {
    const lines = chapters.get(chapter)!.split("\n");
    if (chapter === "终端界面" && isNone(lines)) continue;
    if (chapter === "颜色") {
      const sections = splitSections(lines);
      const themes = parsed.get("风格")!.get("主题")!.split("、");
      for (const theme of themes) {
        if (sections.filter(([name]) => name === theme).length > 1) {
          throw new DesignSpecError(`DESIGN.md「颜色」的「${theme}」一节出现了两次，合成一节`);
        }
      }
      for (const theme of themes) {
        const sectionLines = sections.find(([name]) => name === theme)?.[1];
        if (sectionLines === undefined) throw new DesignSpecError(`DESIGN.md「颜色」缺少「${theme}」一节`);
        colors.push([theme, checkItems(`颜色 · ${theme}`, sectionLines, COLOR_SPEC)]);
      }
    } else {
      parsed.set(chapter, checkItems(chapter, lines, SPECS[chapter]!));
    }
  }

  const spacing = parsed.get("间距")!;
  const base = spacing.get("基本单位")!;
  for (const tier of splitTiers(spacing.get("档位")!)) {
    const times = parseFloat(tier) / parseFloat(base);
    if (!Number.isFinite(times) || Math.abs(times - Math.round(times)) > 1e-9) {
      throw new DesignSpecError(`DESIGN.md「间距」的档位 ${tier} 不是基本单位 ${base} 的整数倍`);
    }
  }

  const accessibility = parsed.get("无障碍")!;
  for (const [name, floor] of CONTRAST_FLOORS) {
    const value = accessibility.get(name)!;
    if (parseFloat(value) < floor) {
      throw new DesignSpecError(`DESIGN.md「无障碍」的「${name}」写的是 ${value}，不能低于 ${floor}:1`);
    }
  }

  for (const [theme, items] of colors) {
    const background = items.get("背景")!;
    for (const [name, thresholdName] of CONTRAST_CHECKS) {
      const color = items.get(name)!;
      const thresholdValue = accessibility.get(thresholdName)!;
      const actual = contrastRatio(color, background);
      if (actual < parseFloat(thresholdValue)) {
        throw new DesignSpecError(
          `DESIGN.md「颜色 · ${theme}」里${name} ${color} 和背景 ${background} 的对比度是 ${actual.toFixed(2)}:1，低于「无障碍」写的${thresholdName} ${thresholdValue}`,
        );
      }
    }
  }
}
