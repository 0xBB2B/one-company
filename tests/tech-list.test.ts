import { describe, expect, test } from "vitest";
import { QuestionWindowView } from "../src/core/host/question-window.ts";
import { TECH_KINDS, TECH_SOURCES, techAgreeText, techListIssues, techQuestionText, techRecordText, techWindowQuestion } from "../src/modules/interaction/tech-list.ts";

const theme = { fg: (kind: string, text: string) => `<${kind}>${text}</>`, bold: (text: string) => `<b>${text}</b>` };
const bare = (value: string) => value.replace(/<\/?[a-zA-Z]*>/gu, "").replace(/\x1b\[[0-9;]*[A-Za-z~]|\x1b_[^\x07]*\x07/gu, "");
const codePoints = (value: string) => [...value].length;
const RULE = "─".repeat(80);

const [SOURCE_USER, SOURCE_RULE, SOURCE_AI] = ["用户点名", "项目规范", "AI 提议"];
type Item = { name: string; kind: string; source: string; purpose: string; necessity: string; alternatives: string };
const item = (override: Partial<Item> = {}): Item => ({ name: "Vue 3", kind: "框架", source: SOURCE_RULE, purpose: "做借书、还书、查书的网页界面", necessity: "项目里还没有前端代码，必须选一个前端框架", alternatives: "React：同样能做；选 Vue 是因为开着 vue 专项代理", ...override });
const LIBRARY: Item[] = [
  item(),
  item({ name: "Go", kind: "语言", purpose: "写借阅、库存、读者管理的后端接口", necessity: "项目里还没有后端代码，必须选一门后端语言", alternatives: "Java：同样能做；选 Go 是因为开着 go 专项代理" }),
  item({ name: "PostgreSQL", kind: "数据库", source: SOURCE_AI, purpose: "保存图书、读者和借阅记录", necessity: "借阅记录要长期保存、按读者和日期查，文件存不了", alternatives: "MySQL：同样可用；SQLite：多人同时借还会锁住整个库" }),
  item({ name: "Redis", kind: "中间件或外部服务", source: SOURCE_USER, purpose: "缓存热门图书的查询结果", necessity: "用户在需求里点名要用", alternatives: "进程内缓存：后端开多个实例时各自内容对不上" }),
];
const filler = (length: number) => "字".repeat(length);

describe("技术清单校验", () => {
  test("TB-01：类别和来源的可选值正好是规定的 6 种和 3 种", () => {
    expect([...TECH_KINDS]).toEqual(["语言", "框架", "数据库", "第三方库", "中间件或外部服务", "工具"]);
    expect([...TECH_SOURCES]).toEqual([SOURCE_USER, SOURCE_RULE, SOURCE_AI]);
  });

  test("TB-02：合格的 4 项图书馆清单没有任何原因", () => {
    expect(techListIssues(LIBRARY)).toEqual([]);
  });

  test("TB-03：0 项清单说明项数要 1 到 12 项", () => {
    const issues = techListIssues([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/1.*12/u);
  });

  test("TB-04：13 项清单说明项数超过 12 项", () => {
    const issues = techListIssues(Array.from({ length: 13 }, (_, n) => item({ name: `库${n}` })));
    expect(issues.some((issue) => /12/u.test(issue) && /13/u.test(issue))).toBe(true);
  });

  test("TB-05：不是数组时给出原因而不是抛错", () => {
    expect(techListIssues(undefined).length).toBeGreaterThan(0);
    expect(techListIssues("Vue 3").length).toBeGreaterThan(0);
  });

  test("TB-06：某项缺备选为什么不选时，原因写明第几项和这一栏", () => {
    const { alternatives: _omitted, ...missing } = item();
    const issues = techListIssues([item(), missing]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("第 2 项");
    expect(issues[0]).toContain("备选为什么不选");
  });

  test("TB-07：栏位是空字符串时按没填处理，写明第几项和这一栏", () => {
    const issues = techListIssues([item({ purpose: "" })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("第 1 项");
    expect(issues[0]).toContain("用途");
  });

  test("TB-08：名称 81 字超长，原因写明第几项、名称和上限 80", () => {
    const issues = techListIssues([item(), item({ name: filler(81) })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("第 2 项");
    expect(issues[0]).toContain("名称");
    expect(issues[0]).toContain("80");
  });

  test("TB-09：用途 201 字超长，原因写明第几项、用途和上限 200", () => {
    const issues = techListIssues([item({ purpose: filler(201) })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("第 1 项");
    expect(issues[0]).toContain("用途");
    expect(issues[0]).toContain("200");
  });

  test("TB-10：为什么非它不可、备选为什么不选 201 字也各有超长原因", () => {
    const issues = techListIssues([item({ necessity: filler(201), alternatives: filler(201) })]);
    expect(issues.some((issue) => issue.includes("为什么非它不可") && issue.includes("200"))).toBe(true);
    expect(issues.some((issue) => issue.includes("备选为什么不选") && issue.includes("200"))).toBe(true);
  });

  test("TB-11：类别不在可选值里，原因写明第几项、类别并列出可选值", () => {
    const issues = techListIssues([item(), item({ kind: "操作系统" })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("第 2 项");
    expect(issues[0]).toContain("类别");
    expect(issues[0]).toContain("操作系统");
    expect(issues[0]).toContain("中间件或外部服务");
  });

  test("TB-12：来源不在可选值里，原因写明第几项、来源并列出可选值", () => {
    const issues = techListIssues([item({ source: "PM 决定" })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("第 1 项");
    expect(issues[0]).toContain("来源");
    expect(issues[0]).toContain("PM 决定");
    expect(issues[0]).toContain("用户点名");
  });

  test.each([
    ["用途", "purpose", "我要用它"],
    ["为什么非它不可", "necessity", "你的项目只能用它"],
    ["备选为什么不选", "alternatives", "您已经否决了其他方案"],
  ])("TB-13：%s 含第一人称或第二人称代词，原因写明第几项和这一栏并提示改用角色词", (column, key, text) => {
    const issues = techListIssues([item(), item({ [key]: text })]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("第 2 项");
    expect(issues[0]).toContain(column);
    expect(issues[0]).toContain("用户");
  });

  test("TB-14：名称和类别含“我”“你”“您”不受代词规则限制", () => {
    expect(techListIssues([item({ name: "我的世界SDK" })])).toEqual([]);
  });

  test("TB-15：多条问题全部列出，每条各自写明项号和栏名", () => {
    const issues = techListIssues([item({ kind: "操作系统" }), item({ purpose: "我用" }), item({ name: filler(81) })]);
    expect(issues).toHaveLength(3);
    expect(issues.some((issue) => issue.includes("第 1 项") && issue.includes("类别"))).toBe(true);
    expect(issues.some((issue) => issue.includes("第 2 项") && issue.includes("用途"))).toBe(true);
    expect(issues.some((issue) => issue.includes("第 3 项") && issue.includes("名称"))).toBe(true);
  });

  test("TB-16：问题记录文字合计 401 字时，说明超了 1 个字并建议精简名称或分两次提交", () => {
    const prefixLength = codePoints("上面 6 项新技术，同意引入吗？\n清单：");
    const itemLength = (n: number, name: string) => codePoints(`${n}. ${name}（工具）`);
    const nameLengths = [60, 60, 60, 60, 60, 60];
    const fixed = prefixLength + 5 + nameLengths.reduce((sum, length, n) => sum + itemLength(n + 1, "字".repeat(length)), 0);
    const items = nameLengths.map((length, n) => item({ name: `${"字".repeat(length - (n === 5 ? fixed - 401 : 0))}`, kind: "工具" }));
    const record = techRecordText(items);
    expect(codePoints(record)).toBe(401);
    const issues = techListIssues(items);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/超了 1 个字|超过 400/u);
    expect(issues[0]).toMatch(/精简|分两次/u);
  });

  test("TB-17：问题记录文字合计恰好 400 字时合格", () => {
    const prefixLength = codePoints("上面 6 项新技术，同意引入吗？\n清单：");
    const nameLengths = [60, 60, 60, 60, 60, 60];
    const fixed = prefixLength + 5 + nameLengths.reduce((sum, length, n) => sum + codePoints(`${n + 1}. ${"字".repeat(length)}（工具）`), 0);
    const items = nameLengths.map((length, n) => item({ name: "字".repeat(length - (n === 5 ? fixed - 400 : 0)), kind: "工具" }));
    expect(codePoints(techRecordText(items))).toBe(400);
    expect(techListIssues(items)).toEqual([]);
  });

  test("TB-18：1 项每栏正好到上限时合格", () => {
    expect(techListIssues([item({ name: filler(80), purpose: filler(200), necessity: filler(200), alternatives: filler(200) })])).toEqual([]);
  });

  test("TB-19：12 项、每个说明栏正好 200 字、名称很短时合格", () => {
    const items = Array.from({ length: 12 }, (_, n) => item({ name: `库${n}`, kind: "工具", purpose: filler(200), necessity: filler(200), alternatives: filler(200) }));
    expect(techListIssues(items)).toEqual([]);
  });

  test("TB-20：12 项名称各 80 字会让记录文字超过 400 字而被拒", () => {
    const items = Array.from({ length: 12 }, () => item({ name: filler(80) }));
    expect(techListIssues(items).some((issue) => /400/u.test(issue))).toBe(true);
  });
});

describe("技术清单文字", () => {
  test("TB-21：确认问题写明项数", () => {
    expect(techQuestionText(4)).toBe("上面 4 项新技术，同意引入吗？");
    expect(techQuestionText(1)).toBe("上面 1 项新技术，同意引入吗？");
  });

  test("TB-22：问题记录文字是确认问题换行接清单，各项用“；”连接", () => {
    expect(techRecordText(LIBRARY)).toBe("上面 4 项新技术，同意引入吗？\n清单：1. Vue 3（框架）；2. Go（语言）；3. PostgreSQL（数据库）；4. Redis（中间件或外部服务）");
  });

  test("TB-23：“全部同意”的用户原话是固定句子加每项一行", () => {
    expect(techAgreeText(LIBRARY)).toBe("全部同意引入以下新技术：\n1. Vue 3（框架）\n2. Go（语言）\n3. PostgreSQL（数据库）\n4. Redis（中间件或外部服务）");
  });
});

describe("技术清单窗口", () => {
  function render(question: ReturnType<typeof techWindowQuestion>) {
    const window = new QuestionWindowView({ tone: "standard", questions: [question], theme, onDone: () => {}, tui: { requestRender() {}, terminal: { rows: 60, columns: 80 } } } as never);
    const raw = window.render(80);
    return { raw: raw.join("\n"), plain: raw.map((line) => bare(line).trimEnd()) };
  }
  const itemLines = (tech: Item, n: number) => [
    ` ${n}. ${tech.name}  ${tech.kind} · ${tech.source}`,
    `    用途：${tech.purpose}`,
    `    为什么非它不可：${tech.necessity}`,
    `    备选为什么不选：${tech.alternatives}`,
  ];

  test("TB-24：4 项清单渲染后去掉颜色标记，逐行和原型一致", () => {
    const { plain } = render(techWindowQuestion(LIBRARY, { caption: "提问 · 图书馆借还系统（第 2 版）" }));
    expect(plain).toEqual([
      RULE, " 提问 · 图书馆借还系统（第 2 版）", "", " 要引入的新技术（共 4 项）", "",
      ...LIBRARY.flatMap((tech, n) => [...(n > 0 ? [""] : []), ...itemLines(tech, n + 1)]),
      "", " 上面 4 项新技术，同意引入吗？", "",
      " → 1. 全部同意", "      按这份清单写进需求的「实现」板块；清单外的新技术仍要另外问",
      "   2. 写修改意见", "      写哪项要改、改成什么；AI 改好后再给你看整份清单",
      "", " ↑↓ 选择 · 回车确认", " Esc 暂不回答（清单保留，之后在对话里回答也行）", RULE,
    ]);
  });

  test("TB-25：4 项清单的来源用 warning 色，项名加粗，三行说明灰色", () => {
    const { raw } = render(techWindowQuestion(LIBRARY, { caption: "提问 · 图书馆借还系统（第 2 版）" }));
    expect(raw).toContain("<b>1. Vue 3</b>");
    expect(raw).toContain(`<warning>${SOURCE_RULE}</>`);
    expect(raw).toContain("<warning>AI 提议</>");
    expect(raw).toMatch(/<muted> *用途：做借书、还书、查书的网页界面<\/>/u);
  });

  test("TB-26：PM 上报场景渲染后逐行和确认过的原型一致，且说明行是普通颜色", () => {
    const excelize = item({ name: "excelize", kind: "第三方库", source: SOURCE_AI, purpose: "把借阅报表导出成 Excel 文件", necessity: "项目里没有能写 Excel 的库，Go 标准库也不支持", alternatives: "导出 CSV：Excel 能打开，但不能分页签、设列宽" });
    const { raw, plain } = render(techWindowQuestion([excelize], { caption: "提问 · 图书馆借还系统（第 3 版）", pmTask: { key: "T4", title: "导出借阅报表" } }));
    expect(plain).toEqual([
      RULE, " 提问 · 图书馆借还系统（第 3 版）", "", " 要引入的新技术（共 1 项）",
      " PM 拆计划时发现需要 · 卡住的任务：T4 导出借阅报表", "",
      " 1. excelize  第三方库 · AI 提议",
      "    用途：把借阅报表导出成 Excel 文件",
      "    为什么非它不可：项目里没有能写 Excel 的库，Go 标准库也不支持",
      "    备选为什么不选：导出 CSV：Excel 能打开，但不能分页签、设列宽",
      "", " 上面 1 项新技术，同意引入吗？", "",
      " → 1. 全部同意", "      写进需求的「实现」板块，你批准新版本后 PM 接着做 T4",
      "   2. 写修改意见", "      写哪项要改、改成什么；AI 改好后再给你看整份清单",
      "", " ↑↓ 选择 · 回车确认", " Esc 暂不回答（清单保留，之后在对话里回答也行）", RULE,
    ]);
    expect(raw).not.toMatch(/<muted>[^<]*PM 拆计划时发现需要/u);
    expect(raw).not.toMatch(/<b>[^<]*PM 拆计划时发现需要/u);
    expect(raw).toContain("PM 拆计划时发现需要 · 卡住的任务：T4 导出借阅报表");
  });

  test("TB-27：两个选项都不带推荐", () => {
    const question = techWindowQuestion(LIBRARY, { caption: "提问 · 图书馆借还系统（第 2 版）" });
    expect(JSON.stringify(question)).not.toContain("recommended");
    expect(render(question).raw).not.toContain("推荐</b>");
  });
});

test("TB-33：任意一栏缺失时，原因写明第几项和缺的是哪一栏", () => {
  const columns: Array<[keyof Item, string]> = [["name", "名称"], ["kind", "类别"], ["source", "来源"], ["purpose", "用途"], ["necessity", "为什么非它不可"], ["alternatives", "备选为什么不选"]];
  for (const [key, label] of columns) {
    const { [key]: _dropped, ...rest } = item();
    const issues = techListIssues([item({ name: "Go", kind: "语言" }), rest]);
    expect(issues.some((issue) => issue.includes("第 2 项") && issue.includes(label)), `${key}：${issues.join("；")}`).toBe(true);
  }
});

test("TB-34：6 种类别、3 种来源各填一次都能通过检查", () => {
  const items = TECH_KINDS.map((kind, n) => item({ name: `T${n}`, kind, source: TECH_SOURCES[n % TECH_SOURCES.length]! }));
  expect(techListIssues(items)).toEqual([]);
});

test("TB-35：清单里有 null、字符串、数字这种不是对象的项时，逐项写明缺什么，不抛错", () => {
  const issues = techListIssues([item(), null, "Vue", 3]);
  for (const n of [2, 3, 4]) expect(issues.some((issue) => issue.includes(`第 ${n} 项`) && issue.includes("名称"))).toBe(true);
});

test("TB-36：超过 12 项时建议分两次提交；不足 1 项时不这样建议", () => {
  const thirteen = Array.from({ length: 13 }, (_, n) => item({ name: `T${n}` }));
  expect(techListIssues(thirteen).join("")).toContain("分两次提交");
  expect(techListIssues([]).join("")).not.toContain("分两次提交");
});

test("TB-37：人称原因只列出实际出现的字", () => {
  const issues = techListIssues([item({ purpose: "给你做借书页面" })]);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toContain("“你”");
  expect(issues[0]).not.toContain("“我”");
});
