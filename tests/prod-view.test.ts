import { expect, test } from "vitest";
import { inspectProdStructure, prodSectionsProblem, pageProdText, pageProdResponse, selectProdSection, PROD_RESPONSE_MAX_BYTES, partitionProdDocument } from "../src/modules/requirement/prod-view.ts";
import { createProdDocument } from "../src/modules/requirement/requirement-identity.ts";
import { resolveRequirementDoc } from "../src/modules/requirement/requirement-doc.ts";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageSections = async () => (await resolveRequirementDoc({ agentDir: join(tmpdir(), `no-agent-${process.pid}-${Date.now()}`), projectTrusted: false })).spec.sections;

/** 自包含的业务示例；结构检查并不证明业务完整或实现通过。 */
export const MOVEMENT_PROD = `# 角色动作 {#movement}
目标用户：使用键盘操作角色的玩家。目标：保留水平移动并增加单次跳跃。
## 目标与非目标 {#scope}
左右方向键控制水平移动，空格起跳并最终落地。本次不做快跑、二段跳或换装。
## 整体约束 {#constraints}
暂停时所有动作输入无效；恢复后必须重新按键才开始动作。动画不能改变实际位移或落地结果。
## 正常移动 {#scenario.move}
前置：角色在平地且游戏未暂停。操作：按住右键再松开。
可观察结果：按住时向右移动；松开后停止，不自行继续移动。
## 跳跃与失败 {#scenario.jump}
前置：角色在平地。操作：按空格，空中再按空格。
可观察结果：第一次起跳，第二次不产生新跳跃；随后落地，落地后可以再次跳跃。
## 边界与交互 {#scenario.pause}
前置：角色正在移动。操作：暂停并按空格，再恢复且不重新按键。
可观察结果：暂停期间不能新增起跳或水平位移；恢复后不会消费暂停期间的输入。
## 未决问题 {#unresolved}
跳跃高度与动画表现尚未确认；依赖这些参数的验收阻塞，不假定性能提升。
`;

test("整包预算包含元数据和JSON转义，结构及UTF8正文都前进且可完整重组", () => {
  const body = Array.from({ length: 256 }, (_, i) =>
    `# 章 {#s${String(i).padStart(3, "0")}${"x".repeat(92)}}\n中😀\"\\\u0001\n`).join("");
  const structure = inspectProdStructure(body);
  const sections: typeof structure.sections = [];
  let combined = "", offset = 0, sectionOffset = 0, count = 0;
  for (;;) {
    const result = pageProdResponse({ text: body, structure, startByte: offset, startSection: sectionOffset, maxBytes: 32_768,
      response: (page, structure, more) => ({ source: '"\\\u0001'.repeat(1_000),
        coverage: { more, warning: "global_constraints_and_unresolved_may_be_outside_page" }, text: page.text, structure }) });
    expect(++count).toBeLessThan(16);
    expect(Buffer.byteLength(JSON.stringify(result.response))).toBeLessThanOrEqual(PROD_RESPONSE_MAX_BYTES);
    expect(result.page.endByte > offset || result.endSection > sectionOffset).toBe(true);
    expect(result.page.text).not.toContain("�");
    combined += result.page.text; sections.push(...result.response.structure!.sections);
    offset = result.page.endByte; sectionOffset = result.endSection;
    if (!result.hasMore) break;
  }
  expect(combined).toBe(body); expect(sections).toEqual(structure.sections);
});

test("固定元数据超预算和非法结构偏移安全失败，不产生空转页", () => {
  const options = { text: "😀", startByte: 0, startSection: 0, maxBytes: 4,
    response: () => ({ source: "x".repeat(PROD_RESPONSE_MAX_BYTES) }) };
  expect(() => pageProdResponse(options)).toThrow(/^prod_response_budget_exceeded$/);
  expect(() => pageProdResponse({ ...options, startSection: 1 })).toThrow(/^invalid_page_range$/);
  expect(() => pageProdResponse({ ...options, startSection: -1 })).toThrow(/^invalid_page_range$/);
  const empty = pageProdResponse({ ...options, text: "", response: (page, structure, more) => ({ page, structure, more }) });
  expect(empty.hasMore).toBe(false); expect(empty.page.complete).toBe(true);
});

test("业务prod显式稳定ID，自包含目标、非目标、失败、边界、未决和黑盒结果", () => {
  const structure = inspectProdStructure(MOVEMENT_PROD);
  expect(structure.status).toBe("available");
  expect(structure.businessCompleteness).toBe("not_mechanically_proven");
  expect(structure.sections.map((s) => s.id)).toEqual(["movement", "scope", "constraints", "scenario.move", "scenario.jump", "scenario.pause", "unresolved"]);
  expect(selectProdSection(MOVEMENT_PROD, structure, "scenario.jump")).toContain("第二次不产生新跳跃");
  expect(selectProdSection(MOVEMENT_PROD, structure, "movement")).toBe(MOVEMENT_PROD);
  expect(MOVEMENT_PROD).not.toMatch(/见.*spec|源码/);
});

test("无ID正文原样可读，不猜标题；重复ID拒绝结构选择", () => {
  const original = "# 中文标题\n无ID正文😀\r\n";
  const structure = inspectProdStructure(original);
  expect(structure).toMatchObject({ status: "section_structure_unavailable", reason: "no_explicit_ids", sections: [] });
  expect(selectProdSection(original, structure)).toBe(original);
  expect(() => selectProdSection(original, structure, "中文标题")).toThrow("section_structure_unavailable");
  expect(inspectProdStructure("# A {#same}\n# B {#same}").reason).toBe("duplicate_ids");
});

test("代码围栏不产生ID，父章节含子场景，无ID同级标题也终止区间", () => {
  const body = "# A {#a}\n```md\n# fake {#fake}\n```\n## B {#b}\n中文\n# end\n不包含";
  const structure = inspectProdStructure(body);
  expect(structure.sections.map((s) => s.id)).toEqual(["a", "b"]);
  expect(selectProdSection(body, structure, "a")).not.toContain("不包含");
  expect(selectProdSection(body, structure, "b")).toBe("## B {#b}\n中文\n");
});

test("中文/emoji/组合字符按UTF8码点安全分页，可无损重组，任意内部字节偏移拒绝", () => {
  const text = "中文😀👩‍👩‍👧‍👦e\u0301\r\n结束";
  for (const maxBytes of [4, 5, 6, 7, 8, 13]) {
    let offset = 0, result = "";
    while (offset < Buffer.byteLength(text)) {
      const page = pageProdText(text, offset, maxBytes);
      expect(page.text).not.toContain("�");
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(maxBytes);
      expect(page.endByte).toBeGreaterThan(offset);
      result += page.text; offset = page.endByte;
    }
    expect(result).toBe(text);
  }
  expect(() => pageProdText(text, 1, 4)).toThrow("invalid_page_range");
  expect(pageProdText("", 0, 4)).toMatchObject({ text: "", complete: true });
});

const approvalId = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
test("授权分区覆盖metadata、BOM前言及父子ATX真实UTF8字节，无重叠且不改变章节阅读", () => {
  const body = "\uFEFF前言😀\r\n# 父 {#parent}\r\n父文\r\n## 子 {#child}\r\ne\u0301\r\n```md\r\n# 假 {#fake}\r\n```\r\n";
  const p = partitionProdDocument(approvalId, "标题😀", body), doc = createProdDocument(approvalId, "标题😀", body);
  expect(p.prodHash).toBe(doc.prodHash); expect(p.units.map((u) => u.id)).toEqual(["metadata", "preamble", "parent", "child"]);
  const bytes = Buffer.from(doc.bytes); let end = 0, restored = "";
  for (const u of p.units) {
    expect(u.startByte).toBe(end); const fragment = bytes.subarray(u.startByte, u.endByte);
    expect(createHash("sha256").update(fragment.toString().replace(/[\r\n]+$/u, "")).digest("hex")).toBe(u.hash);
    expect(fragment.toString()).not.toContain("�"); restored += fragment.toString(); end = u.endByte;
  }
  expect(end).toBe(bytes.length); expect(restored).toBe(bytes.toString());
  expect(selectProdSection(body, inspectProdStructure(body), "parent")).toContain("## 子");
});
test("在最后一段后面追加新段时，原最后一段文字未变，段落哈希也不变", () => {
  const before = partitionProdDocument(approvalId, "标题", "## 暂停 {#pause}\n暂停时不响应。");
  const after = partitionProdDocument(approvalId, "标题", "## 暂停 {#pause}\n暂停时不响应。\n\n## 死亡 {#death}\n死亡后不能快跑。");
  expect(after.units.find((u) => u.id === "pause")!.hash).toBe(before.units.find((u) => u.id === "pause")!.hash);
  expect(partitionProdDocument(approvalId, "标题", "## 暂停 {#pause}\n暂停时也响应。").units.find((u) => u.id === "pause")!.hash)
    .not.toBe(before.units.find((u) => u.id === "pause")!.hash);
});
test("无ID或混合标题只使用whole-body，空正文只有metadata；重复及保留ID拒绝", () => {
  for (const body of ["# A\n文本", "# A {#a}\n## B\n文本", "无标题😀", "#\n空标题"]) {
    expect(partitionProdDocument(approvalId, "标题", body).units.map((u) => u.id)).toEqual(["metadata", "whole-body"]);
  }
  expect(partitionProdDocument(approvalId, "标题", "").units.map((u) => u.id)).toEqual(["metadata"]);
  for (const body of ["# A {#a}\n# B {#a}", "# A {#metadata}", "# A {#preamble}", "# A {#whole-body}", "# A {#bad/id}"]) {
    expect(() => partitionProdDocument(approvalId, "标题", body)).toThrow(/invalid_approval_unit_id/);
  }
  expect(partitionProdDocument(approvalId, "标题", Array.from({ length: 40 }, (_, i) => `# A {#s${i}}\n`).join("")).units).toHaveLength(41);
});

test("M8A-AC9：按包内默认规范，顶层须依次是背景、需求、功能、实现、验收二级标题", async () => {
  const five = "## 背景 {#background}\n玩家想跑得更快。\n## 需求 {#requirements}\n增加快跑。\n## 功能 {#features}\n### 地面快跑 {#features.sprint}\n按住 Shift 快跑。\n" +
    "## 实现 {#implementation}\n由 PM 规划。\n## 验收 {#acceptance}\n### 地面快跑 {#acceptance.sprint}\n速度为 1.5 倍。\n";
  const sections = await packageSections();
  expect(prodSectionsProblem(five, sections)).toBeNull();
  expect(prodSectionsProblem("```\n# 围栏里的标题 {#x}\n```\n" + five, sections)).toBeNull();
  expect(prodSectionsProblem(MOVEMENT_PROD, sections)).toContain("当前为 movement、scope、constraints");
  expect(prodSectionsProblem(five.replace("## 实现 {#implementation}\n由 PM 规划。\n", ""), sections)).toBe(
    "顶层须为二级标题且依次为 background、requirements、features、implementation、acceptance，当前为 background、requirements、features、acceptance");
  expect(prodSectionsProblem(five.replace("## 背景 {#background}", "## 背景"), sections)).toContain("「## 背景」没有编号");
  expect(prodSectionsProblem("# 总标题 {#top}\n" + five, sections)).toContain("当前为 top");
});

test("M8C：批准核对按规范的板块清单，且每个标题（含各级小节）都须有唯一编号", async () => {
  const sections = [{ id: "goal", title: "目标" }, { id: "build", title: "实现", record: "implementation" as const }, { id: "check", title: "验收", record: "acceptance" as const }];
  const three = "## 目标 {#goal}\n跑得快。\n### 快跑 {#goal.sprint}\n按 Shift。\n## 实现 {#build}\n由 PM 规划。\n## 验收 {#check}\n### 快跑 {#check.sprint}\n1.5 倍。\n";
  expect(prodSectionsProblem(three, sections)).toBeNull();
  expect(prodSectionsProblem(three, await packageSections())).toContain("依次为 background、requirements、features、implementation、acceptance，当前为 goal、build、check");
  expect(prodSectionsProblem(three.replace("### 快跑 {#goal.sprint}", "### 快跑"), sections)).toBe("每个标题都须以唯一编号结尾：「### 快跑」没有编号");
  expect(prodSectionsProblem(three.replace("{#check.sprint}", "{#goal.sprint}"), sections)).toBe("每个标题都须以唯一编号结尾：编号 goal.sprint 重复");
  expect(prodSectionsProblem(three.replace("{#check.sprint}", "{#bad/id}"), sections)).toContain("「### 快跑 {#bad/id}」没有编号");
});

test("M8O-AC2：实施目标板块下的小节编号须以“板块编号.”开头，以它开头的小节也须写在该板块下，否则批准核对不通过", () => {
  const sections = [{ id: "goal", title: "目标", goal: true as const }, { id: "build", title: "实现", record: "implementation" as const }, { id: "check", title: "验收", record: "acceptance" as const }];
  const three = "## 目标 {#goal}\n跑得快。\n### 快跑 {#goal.sprint}\n按 Shift。\n## 实现 {#build}\n由 PM 规划。\n## 验收 {#check}\n### 快跑 {#check.sprint}\n1.5 倍。\n";
  expect(prodSectionsProblem(three, sections)).toBeNull();
  expect(prodSectionsProblem(three.replace("{#goal.sprint}", "{#sprint}"), sections)).toBe("实施目标板块 goal 下的小节编号须以「goal.」开头：「### 快跑 {#sprint}」");
  expect(prodSectionsProblem(three.replace("{#check.sprint}", "{#goal.check}"), sections)).toBe("编号以「goal.」开头的小节须写在实施目标板块 goal 下：「### 快跑 {#goal.check}」在 check 下");
  expect(prodSectionsProblem(three.replace("{#check.sprint}", "{#A}"), sections)).toBeNull();
});
