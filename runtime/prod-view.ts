import { createHash } from "node:crypto";
import { createProdDocument } from "./requirement-identity.ts";

export const PROD_PAGE_BYTES = 16_384;
export const PROD_MAX_PAGE_BYTES = 32_768;
/** 紧凑JSON整包上限，另留2KiB供50KiB宿主的外层封装。maxBytes仍是原始text上限。 */
export const PROD_RESPONSE_MAX_BYTES = 49_152;
export const PROD_SECTION_ID_PATTERN = "^[a-zA-Z][a-zA-Z0-9._-]{0,95}$";
const sectionId = new RegExp(PROD_SECTION_ID_PATTERN);

export interface ProdSection {
  id: string;
  /** UTF-8字节区间，包含本标题及下级章节，结束位置不包含在内。 */
  startByte: number;
  endByte: number;
  hash: `sha256:${string}`;
}
export interface ProdStructure {
  status: "available" | "section_structure_unavailable";
  reason: "explicit_ids" | "no_explicit_ids" | "duplicate_ids" | "too_many_sections";
  sections: ProdSection[];
  businessCompleteness: "not_mechanically_proven";
}

export const PROD_SECTIONS = ["background", "requirements", "features", "implementation", "acceptance"] as const;

/** 批准前核对五大板块：一、二级标题必须恰好是这五个固定编号的二级标题且按此顺序；符合返回 null，否则返回期望与实际。 */
export function prodSectionsProblem(body: string): string | null {
  const top = headingsOf(body).filter((heading) => heading.level <= 2);
  const actual = top.map((heading) => heading.id ?? "无编号");
  if (top.every((heading) => heading.level === 2) && actual.join() === PROD_SECTIONS.join()) return null;
  return `顶层须为二级标题且依次为 ${PROD_SECTIONS.join("、")}，当前为 ${actual.length ? actual.join("、") : "无标题"}`;
}

/** 编号为 id 的标题所在章节的结束字节位置（下一个同级或更高级标题处，或全文末尾）；找不到返回 null。 */
export function sectionEndByte(text: string, id: string): number | null {
  const headings = headingsOf(text), index = headings.findIndex((heading) => heading.id === id);
  if (index < 0) return null;
  return headings.slice(index + 1).find((next) => next.level <= headings[index]!.level)?.offset ?? Buffer.byteLength(text);
}

/** 只识别代码围栏外的ATX标题末尾显式{#id}；不把自然语言标题变成永久身份。 */
export function inspectProdStructure(body: string): ProdStructure {
  const headings = headingsOf(body);
  const identified = headings.filter((heading) => heading.id !== undefined);
  const unavailable = (reason: ProdStructure["reason"]): ProdStructure => ({ status: "section_structure_unavailable", reason,
    sections: [], businessCompleteness: "not_mechanically_proven" });
  if (!identified.length) return unavailable("no_explicit_ids");
  if (identified.length > 256) return unavailable("too_many_sections");
  if (new Set(identified.map((heading) => heading.id)).size !== identified.length) return unavailable("duplicate_ids");
  const bytes = Buffer.from(body);
  return { status: "available", reason: "explicit_ids", businessCompleteness: "not_mechanically_proven",
    sections: identified.map((heading) => {
      const index = headings.indexOf(heading);
      const endByte = headings.slice(index + 1).find((next) => next.level <= heading.level)?.offset ?? bytes.length;
      return { id: heading.id!, startByte: heading.offset, endByte,
        hash: `sha256:${createHash("sha256").update(bytes.subarray(heading.offset, endByte)).digest("hex")}` };
    }) };
}

function headingsOf(body: string): Array<{ level: number; id?: string; offset: number }> {
  const headings: Array<{ level: number; id?: string; offset: number }> = [];
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  for (const line of body.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const text = line.replace(/\r?\n$/u, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
    } else if (marker) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
    } else {
      const heading = /^ {0,3}(#{1,6})[\t ]+(.+)$/u.exec(text);
      if (heading) {
        const explicit = /\{#([^{}]+)\}[\t ]*(?:#+[\t ]*)?$/u.exec(heading[2]!);
        headings.push({ level: heading[1]!.length, offset,
          ...(explicit && sectionId.test(explicit[1]!) ? { id: explicit[1]! } : {}) });
      }
    }
    offset += Buffer.byteLength(line);
  }
  return headings;
}

export interface ProdApprovalPartition {
  prodHash: string;
  totalBytes: number;
  units: Array<{ id: string; hash: string; startByte: number; endByte: number }>;
}

/** 授权分区按完整prod字节覆盖；父子标题各占到下一标题之前的范围，不沿用阅读区间。 */
export function partitionProdDocument(requirementId: string, title: string, body: string): ProdApprovalPartition {
  const document = createProdDocument(requirementId, title, body), bytes = Buffer.from(document.bytes);
  const bodyStart = bytes.length - Buffer.byteLength(body);
  const headings: Array<{ id?: string; offset: number }> = [];
  let offset = bodyStart, fence: { char: string; length: number } | null = null;
  const reserved = new Set(["metadata", "preamble", "whole-body"]), seen = new Set<string>();
  for (const line of body.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const text = line.replace(/\r?\n$/u, "");
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
    if (fence) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
    } else if (marker) fence = { char: marker[1]![0]!, length: marker[1]!.length };
    else if (/^ {0,3}#{1,6}(?:[\t ]|$)/u.test(text)) {
      const explicit = /\{#([^{}]+)\}[\t ]*(?:#+[\t ]*)?$/u.exec(text);
      const id = explicit?.[1];
      if (id && (!sectionId.test(id) || id.length > 96 || reserved.has(id) || seen.has(id))) throw new Error("invalid_approval_unit_id");
      if (id) seen.add(id);
      headings.push({ id, offset });
    }
    offset += Buffer.byteLength(line);
  }
  const starts = [{ id: "metadata", offset: 0 }];
  if (body.length) {
    if (!headings.length || headings.some((h) => !h.id)) starts.push({ id: "whole-body", offset: bodyStart });
    else {
      if (headings[0]!.offset > bodyStart) starts.push({ id: "preamble", offset: bodyStart });
      starts.push(...headings.map((h) => ({ id: h.id!, offset: h.offset })));
    }
  }
  if (starts.length > 20) throw new Error("approval_unit_limit");
  return { prodHash: document.prodHash, totalBytes: bytes.length,
    units: starts.map((start, index) => {
      const endByte = starts[index + 1]?.offset ?? bytes.length;
      return { id: start.id, startByte: start.offset, endByte,
        hash: createHash("sha256").update(bytes.subarray(start.offset, endByte)).digest("hex") };
    }) };
}

export interface ProdTextPage {
  text: string;
  startByte: number;
  endByte: number;
  totalBytes: number;
  complete: boolean;
}

/** 字节预算内按Unicode码点切页，不拆开中文或emoji的UTF-8编码。 */
export function pageProdText(text: string, startByte = 0, maxBytes = PROD_PAGE_BYTES): ProdTextPage {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > PROD_MAX_PAGE_BYTES ||
    !Number.isSafeInteger(startByte) || startByte < 0) throw new Error("invalid_page_range");
  const bytes = Buffer.from(text);
  if (startByte > bytes.length || (startByte < bytes.length && (bytes[startByte]! & 0xc0) === 0x80)) throw new Error("invalid_page_range");
  let endByte = Math.min(startByte + maxBytes, bytes.length);
  while (endByte < bytes.length && (bytes[endByte]! & 0xc0) === 0x80) endByte--;
  return { text: bytes.subarray(startByte, endByte).toString("utf8"), startByte, endByte, totalBytes: bytes.length,
    complete: startByte === 0 && endByte === bytes.length };
}

export interface ProdStructurePage extends ProdStructure {
  totalSections: number;
  /** 章节数组的半开区间；complete只表示本页包含全部结构，不累计以前的页。 */
  startSection: number;
  endSection: number;
  remainingSections: number;
  complete: boolean;
}

/** 整包JSON计入转义及所有元数据；先分正文，再以余量分结构，两种偏移均需由可信游标绑定。 */
export function pageProdResponse<T>(options: {
  text: string; startByte: number; maxBytes: number; structure?: ProdStructure; startSection: number;
  response: (page: ProdTextPage, structure: ProdStructurePage | undefined, hasMore: boolean) => T;
}): { response: T; page: ProdTextPage; endSection: number; hasMore: boolean } {
  const { text, startByte, maxBytes, structure, startSection } = options;
  const totalSections = structure?.sections.length ?? 0;
  if (!Number.isSafeInteger(startSection) || startSection < 0 || startSection > totalSections) throw new Error("invalid_page_range");
  function candidate(page: ProdTextPage, endSection: number) {
    const structurePage: ProdStructurePage | undefined = structure ? { ...structure,
      sections: structure.sections.slice(startSection, endSection), totalSections, startSection, endSection,
      remainingSections: totalSections - endSection, complete: startSection === 0 && endSection === totalSections } : undefined;
    const hasMore = page.endByte < page.totalBytes || endSection < totalSections;
    return { response: options.response(page, structurePage, hasMore), page, endSection, hasMore };
  }
  const fits = (result: { response: T }) => Buffer.byteLength(JSON.stringify(result.response)) <= PROD_RESPONSE_MAX_BYTES;
  let page = pageProdText(text, startByte, maxBytes);
  if (!fits(candidate(page, startSection))) {
    // 至少可送一个Unicode码点；固定来源/覆盖包不能容纳最小正文时安全失败。
    let low = 4, high = maxBytes;
    page = pageProdText(text, startByte, low);
    if (!fits(candidate(page, startSection))) throw new Error("prod_response_budget_exceeded");
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const trial = pageProdText(text, startByte, middle);
      if (fits(candidate(trial, startSection))) { low = middle; page = trial; } else high = middle - 1;
    }
  }
  let low = startSection, high = totalSections;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(candidate(page, middle))) low = middle; else high = middle - 1;
  }
  const result = candidate(page, low);
  if (!fits(result) || (result.hasMore && page.endByte === startByte && low === startSection)) {
    throw new Error("prod_response_budget_exceeded");
  }
  return result;
}

export function selectProdSection(body: string, structure: ProdStructure, id?: string): string {
  if (id === undefined) return body;
  if (structure.status !== "available") throw new Error("section_structure_unavailable");
  const section = structure.sections.find((item) => item.id === id);
  if (!section) throw new Error("unknown_section");
  return Buffer.from(body).subarray(section.startByte, section.endByte).toString("utf8");
}
