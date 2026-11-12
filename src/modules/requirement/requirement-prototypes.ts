import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Type } from "typebox";
import type { Static, TProperties } from "typebox";
import { Value } from "typebox/value";
import { sanitizeText } from "../../core/policy/text-sanitize.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "../../core/storage/database.ts";
import type { LocalDatabase } from "../../core/storage/database.ts";
import { hash as sha256Hex, id, object, positive } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { unsafeFilenameKind } from "./requirement-identity.ts";
import { DESIGN_SPEC_FILE, DesignSpecError, changedChapters, checkDesignSpec } from "./design-spec.ts";
import { buildPrototypeFrame } from "./prototype-frame.ts";
import type { PrototypePage } from "./prototype-frame.ts";
import { attachRecordIn, countedAnchorsIn, createLineAnchorIn, draftLineViewIn, memberAnchorIn, resolveLineTipIn } from "./line-anchors.ts";
import { claimRequirementWriteIn, releaseDeadRequirementWriteIn, releaseRequirementWriteIn } from "./requirement-coordination.ts";
import { commitDraftFiles, readDraftFiles } from "./prd-storage.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";

const CHANGES = "prototype_changes";
const PROTOTYPE_MAX_BYTES = 1_048_576;
const NAME_MAX_LENGTH = 40;
const NOTE_MAX_LENGTH = 2000;
const OPINION_MAX_LENGTH = 4000;
const REASON_MAX_LENGTH = 500;
const MAX_ENTRIES = 50;

const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
const OPTION_NAME_MAX_LENGTH = 20;
export const PickedOption = object({ letter: Type.Enum(OPTION_LETTERS), name: Type.String({ minLength: 1, maxLength: 20 }) });
const PrototypeFile = object({ version: positive, hash: sha256Hex, bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }), note: Type.String({ maxLength: 2000 }),
  options: Type.Array(Type.String({ minLength: 1, maxLength: 20 }), { maxItems: 6 }), picked: Type.Union([PickedOption, Type.Null()]) });
const SubmittedDesigns = Type.Union([Type.Array(object({ letter: Type.Union([Type.Enum(OPTION_LETTERS), Type.Null()]), hash: sha256Hex, bytes: Type.Integer({ minimum: 1, maximum: 16384 }) }), { minItems: 1, maxItems: 6 }), Type.Null()]);
export type PickedOption = Static<typeof PickedOption>;
const PrototypeEntry = object({
  name: Type.String({ minLength: 1, maxLength: 40 }),
  lastVersion: positive,
  draft: Type.Union([PrototypeFile, Type.Null()]),
  approved: Type.Union([PrototypeFile, Type.Null()]),
  removed: Type.Boolean(),
  inFlight: Type.Union([object({ version: positive, runId: id, agent: Type.String(), status: Type.Union([Type.Literal("designing"), Type.Literal("awaiting")]),
    file: Type.Union([PrototypeFile, Type.Null()]),
    designBase: Type.Union([sha256Hex, Type.Null()]),
    designs: SubmittedDesigns }), Type.Null()]),
  lastOpinion: Type.Union([object({ version: positive, opinion: Type.String({ minLength: 1, maxLength: 4000 }) }), Type.Null()]),
  lastEnded: Type.Union([object({ version: positive, reason: Type.String({ maxLength: 500 }) }), Type.Null()]),
});
export const PrototypeBoard = object({ requirementId: id, entries: Type.Array(PrototypeEntry, { maxItems: 50 }), updatedAt: positive });
type PrototypeFile = Static<typeof PrototypeFile>;
type PrototypeEntry = Static<typeof PrototypeEntry>;
export type PrototypeBoard = Static<typeof PrototypeBoard>;

const changeOf = <K extends string, P extends TProperties>(kind: K, properties: P) =>
  object({ format: Type.Literal("prototype-change/v1"), requirementId: id, seq: positive, at: positive, kind: Type.Literal(kind), ...properties });
const entryName = Type.String({ minLength: 1, maxLength: 40 });
const PrototypeChange = Type.Union([
  changeOf("begin", { name: entryName, version: positive, runId: id, agent: Type.String(), designBase: Type.Union([sha256Hex, Type.Null()]) }),
  changeOf("submit", { name: entryName, version: positive, runId: id, file: PrototypeFile, designs: SubmittedDesigns }),
  changeOf("end", { name: entryName, version: positive, runId: id, reason: Type.String({ maxLength: 500 }) }),
  changeOf("accept", { name: entryName, version: positive, picked: Type.Union([PickedOption, Type.Null()]) }),
  changeOf("opinion", { name: entryName, version: positive, opinion: Type.String({ minLength: 1, maxLength: 4000 }) }),
  changeOf("abandon", { name: entryName, version: positive }),
  changeOf("remove", { name: entryName, version: positive }),
  changeOf("approve", {}),
]);
type PrototypeChange = Static<typeof PrototypeChange>;
type ChangeKind<K extends PrototypeChange["kind"]> = Extract<PrototypeChange, { kind: K }>;
type ChangeInput = PrototypeChange extends infer C ? C extends PrototypeChange ? Omit<C, "format" | "requirementId" | "seq" | "at"> : never : never;

export class PrototypeBoardError extends Error {
  readonly code: string;
  readonly advice: FailureAdvice;
  constructor(code: string, why: string, next: string) {
    super(`${code}：${why}`); this.name = "PrototypeBoardError"; this.code = code; this.advice = { why, next };
  }
}
const deny = (code: string, why: string, next: string): never => { throw new PrototypeBoardError(code, why, next); };

const assertRequirementEditable = (db: LocalDatabase, requirementId: string): void => {
  const requirement = db.read<RequirementRecord>("requirements", requirementId)?.data;
  if (!requirement) deny("requirement_unavailable", "需求不存在", "先建需求草稿，再用它的编号派原型设计师");
  else if (requirement.lifecycle === "closing" || requirement.lifecycle === "closed") {
    const verb = { completed: "完成", cancelled: "取消", rejected: "驳回" }[requirement.close?.reason ?? "completed"];
    deny("requirement_unavailable", `需求${requirement.lifecycle === "closed" ? "已" : "正在"}${verb}，不能再做原型`, "界面还要改就先建一个新需求，再派原型设计师");
  } else if (requirement.recovery !== "ready") deny("requirement_unavailable", "需求正在等用户恢复核对，不能再做原型", "请用户先处理恢复核对，再派原型设计师");
};

type Ref = { dataRoot: string; repoId: string };
const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const databaseOf = (ref: Ref) => repositoryDatabase(ref.dataRoot, ref.repoId);

export async function assertRequirementOpenForPrototypes(ref: Ref, requirementId: string): Promise<void> {
  withDatabase(databaseOf(ref), (db) => assertRequirementEditable(db, requirementId));
}

export function prototypeFilePath(ref: Ref, input: { requirementId: string; name: string; version: number }): string {
  return join(dirname(databaseOf(ref)), "prototypes", input.requirementId, `${input.name}.v${input.version}.html`);
}

export function designFilePath(ref: Ref, input: { requirementId: string; name: string; version: number; letter: string | null }): string {
  return join(dirname(databaseOf(ref)), "prototypes", input.requirementId, `${input.name}.v${input.version}.design${input.letter ? `-${input.letter}` : ""}.md`);
}

export function checkPrototypeName(name: string): void {
  if (name.length === 0) deny("invalid_name", "原型名称不能为空", "换一个名称后重新派出");
  if (Array.from(name).length > NAME_MAX_LENGTH) deny("invalid_name", `原型名称超过 ${NAME_MAX_LENGTH} 字上限`, "缩短名称后重新派出");
  if (/\p{Cs}/u.test(name)) deny("invalid_name", "原型名称含孤立代理码点", "换一个名称后重新派出");
  const unsafe = unsafeFilenameKind(name);
  if (unsafe) deny("invalid_name", unsafe === "path" ? "原型名称含路径分隔符、穿越片段或不支持的文件名字符" : "原型名称含控制字符", "换一个名称后重新派出");
}

type ChangeRow = { key: string; data: PrototypeChange };
const changeRows = (db: LocalDatabase, requirementId: string): ChangeRow[] =>
  db.list<PrototypeChange>(CHANGES).filter((row) => row.data.requirementId === requirementId).map((row) => ({ key: row.key, data: row.data }));
const anchorOfRow = (db: LocalDatabase, row: ChangeRow) => memberAnchorIn(db, CHANGES, row.key);

function recordChange(db: LocalDatabase, requirementId: string, anchor: string | null, change: ChangeInput): void {
  const record = { format: "prototype-change/v1", requirementId, seq: changeRows(db, requirementId).reduce((max, row) => Math.max(max, row.data.seq), 0) + 1, at: Date.now(), ...change };
  if (!Value.Check(PrototypeChange, record)) throw new Error("原型变动记录不符合结构");
  const key = uuidv7();
  db.create(CHANGES, key, record);
  if (anchor) attachRecordIn(db, { namespace: CHANGES, key, requirementId, anchor });
}

const lineViewOf = (db: LocalDatabase, requirementId: string, line: readonly string[]) =>
  draftLineViewIn(db, db.read<RequirementRecord>("requirements", requirementId)!, line, true);

function newAnchor(db: LocalDatabase, ref: Ref, input: { requirementId: string; line: readonly string[]; anchor: string; fileCommit?: string }): string {
  const fileCommit = input.fileCommit ?? lineViewOf(db, input.requirementId, input.line).fileCommit;
  createLineAnchorIn(db, { repoId: ref.repoId, requirementId: input.requirementId, anchor: input.anchor, kind: "prototype", line: input.line, now: Date.now(), ...(fileCommit ? { fileCommit } : {}) });
  return input.anchor;
}

function foldChanges(requirementId: string, changes: PrototypeChange[]): PrototypeBoard {
  const entries: PrototypeEntry[] = [];
  for (const change of changes) {
    if (change.kind === "approve") {
      for (const entry of entries) {
        if (entry.removed) entry.approved = null;
        else if (entry.draft) entry.approved = entry.draft;
        entry.draft = null;
        entry.removed = false;
      }
      continue;
    }
    let entry = entries.find((candidate) => candidate.name === change.name);
    switch (change.kind) {
      case "begin":
        if (!entry) {
          entry = { name: change.name, lastVersion: 0, draft: null, approved: null, removed: false, inFlight: null, lastOpinion: null, lastEnded: null };
          entries.push(entry);
        }
        if (entry.inFlight) entry.lastEnded = { version: entry.inFlight.version, reason: "用户提了意见后重派，这一版作废" };
        entry.lastVersion = change.version;
        entry.inFlight = { version: change.version, runId: change.runId, agent: change.agent, status: "designing", file: null, designBase: change.designBase, designs: null };
        break;
      case "submit":
        if (entry?.inFlight?.runId !== change.runId) break;
        entry!.inFlight!.status = "awaiting";
        entry!.inFlight!.file = change.file;
        entry!.inFlight!.designs = change.designs;
        break;
      case "end":
        if (entry?.inFlight?.runId !== change.runId) break;
        entry!.lastEnded = { version: change.version, reason: change.reason };
        entry!.inFlight = null;
        break;
      case "accept":
        entry!.draft = { ...entry!.inFlight!.file!, picked: change.picked };
        entry!.removed = false;
        entry!.lastOpinion = null;
        entry!.inFlight = null;
        break;
      case "opinion":
        entry!.lastOpinion = { version: change.version, opinion: change.opinion };
        break;
      case "abandon":
        entry!.lastOpinion = null;
        entry!.inFlight = null;
        break;
      case "remove":
        entry!.draft = null;
        entry!.removed = true;
        break;
    }
  }
  return { requirementId, entries, updatedAt: changes.at(-1)?.at ?? Date.now() };
}

function stateOn(db: LocalDatabase, requirementId: string, line: readonly string[]): PrototypeBoard {
  const counted = countedAnchorsIn(db, requirementId, line);
  const changes = changeRows(db, requirementId)
    .filter((row) => { const anchor = anchorOfRow(db, row); return anchor === null || counted.has(anchor); })
    .map((row) => row.data).sort((a, b) => a.seq - b.seq);
  return foldChanges(requirementId, changes);
}

export const readBoardIn = (db: LocalDatabase, requirementId: string, line: readonly string[]): PrototypeBoard => stateOn(db, requirementId, line);

export async function readPrototypeBoard(ref: Ref, requirementId: string, line: readonly string[]): Promise<PrototypeBoard> {
  return withDatabase(databaseOf(ref), (db) => stateOn(db, requirementId, line));
}

const foldName = (name: string) => name.normalize("NFC").toLowerCase();
const entryNamed = (board: PrototypeBoard, name: string) => board.entries.find((entry) => entry.name === name);

function requireInFlight(board: PrototypeBoard, name: string, status: "designing" | "awaiting"): { entry: PrototypeEntry; inFlight: NonNullable<PrototypeEntry["inFlight"]> } {
  const entry = entryNamed(board, name);
  if (!entry?.inFlight || entry.inFlight.status !== status) {
    return deny("not_in_flight", status === "designing" ? "这份原型当前没有在做的设计" : "这份原型当前没有等用户确认的版本", "刷新后按看板当前状态操作");
  }
  return { entry, inFlight: entry.inFlight };
}

export async function beginDesign(ref: Ref, input: { requirementId: string; name: string; runId: string; agent: string; designBase: string | null; line: readonly string[]; anchor: string }):
  Promise<{ version: number; previous: { path: string; opinion: string | null; designPaths: string[] } | null }> {
  checkPrototypeName(input.name);
  const { line } = input;
  return withDatabase(databaseOf(ref), (db) => db.transaction(() => {
    assertRequirementEditable(db, input.requirementId);
    const board = stateOn(db, input.requirementId, line);
    const entry = entryNamed(board, input.name);
    const replacedDesigns = entry?.inFlight?.designs ?? [];
    if (entry?.inFlight) {
      const { inFlight } = entry;
      if (inFlight.status === "designing") deny("in_flight", `原型「${input.name}」还在做`, "等设计师交稿后再处理");
      if (entry.lastOpinion?.version !== inFlight.version) {
        deny("in_flight", `原型「${input.name}」第 ${inFlight.version} 版还在等用户确认，用户没有对它提意见，不能重派`, "先请用户在确认窗口里处理");
      }
    }
    if (!entry) {
      const sameLooking = board.entries.find((other) => foldName(other.name) === foldName(input.name));
      if (sameLooking) deny("name_conflict", `已有原型「${sameLooking.name}」，名称只差大小写或写法`, "请用已有名称或换个名字");
      if (board.entries.length >= MAX_ENTRIES) deny("too_many_prototypes", `一个需求最多 ${MAX_ENTRIES} 份原型`, "复用已有名称");
    }
    const version = beginRows(changeRows(db, input.requirementId)).reduce((max, row) => row.data.name === input.name ? Math.max(max, row.data.version) : max, 0) + 1;
    const source = entry?.lastOpinion ? { version: entry.lastOpinion.version, opinion: entry.lastOpinion.opinion as string | null }
      : (entry?.draft ?? entry?.approved) ? { version: (entry.draft ?? entry.approved)!.version, opinion: null } : null;
    const previous = source && {
      path: prototypeFilePath(ref, { requirementId: input.requirementId, name: input.name, version: source.version }), opinion: source.opinion,
      designPaths: replacedDesigns.map((design) => designFilePath(ref, { requirementId: input.requirementId, name: input.name, version: source.version, letter: design.letter })),
    };
    const anchor = newAnchor(db, ref, { requirementId: input.requirementId, line, anchor: input.anchor });
    recordChange(db, input.requirementId, anchor, { kind: "begin", name: input.name, version, runId: input.runId, agent: input.agent, designBase: input.designBase });
    return { version, previous };
  }));
}

export const optionLetter = (index: number): PickedOption["letter"] => OPTION_LETTERS[index]!;
export const pickedOptionText = (picked: PickedOption): string => `${picked.letter}「${picked.name}」，其余方案不做`;

const cleanName = (name: string): string => sanitizeText(name).replace(/\s+/g, " ").trim();

function checkOptionList(raw: readonly string[] | undefined): string[] {
  if (!raw?.length) return [];
  const next = "改好方案清单后重交";
  const options = raw.map(cleanName);
  if (options.length < 2) deny("invalid_options", `方案清单只有 ${options.length} 个方案，至少 2 个；只画了一种方案时不附清单`, next);
  if (options.length > OPTION_LETTERS.length) deny("invalid_options", `方案清单有 ${options.length} 个方案，最多 ${OPTION_LETTERS.length} 个`, next);
  const empty = options.findIndex((name) => name === "");
  if (empty >= 0) deny("invalid_options", `第 ${empty + 1} 个方案名是空的`, next);
  const long = options.findIndex((name) => Array.from(name).length > OPTION_NAME_MAX_LENGTH);
  if (long >= 0) deny("invalid_options", `第 ${long + 1} 个方案名超过 ${OPTION_NAME_MAX_LENGTH} 字`, next);
  const second = options.findIndex((name, index) => options.indexOf(name) !== index);
  if (second >= 0) deny("invalid_options", `第 ${options.indexOf(options[second]!) + 1} 个和第 ${second + 1} 个方案重名`, next);
  return options;
}

export interface SubmittedPage { name: string; group?: string; views: { name: string; notes?: string[] }[] }

const cleanLines = (lines: readonly string[] | undefined): string[] => (lines ?? []).map((line) => line.trim()).filter((line) => line !== "");

function checkPageList(raw: readonly SubmittedPage[]): PrototypePage[] {
  const next = "改好页面清单后重交";
  if (raw.length === 0) deny("invalid_pages", "页面清单是空的，至少写 1 个页面", next);
  const names = raw.map((page) => cleanName(page.name));
  const empty = names.findIndex((name) => name === "");
  if (empty >= 0) deny("invalid_pages", `第 ${empty + 1} 个页面名是空的`, next);
  const second = names.findIndex((name, index) => names.indexOf(name) !== index);
  if (second >= 0) deny("invalid_pages", `页面「${names[second]}」重名`, next);
  const dirty = raw.findIndex((page, index) => page.name !== names[index]);
  if (dirty >= 0) deny("invalid_pages", `第 ${dirty + 1} 个页面名有多余空白或不可见字符`, next);
  return raw.map((page, index) => {
    const name = names[index]!;
    if (page.views.length === 0) deny("invalid_pages", `页面「${name}」没有画面，至少写 1 个`, next);
    const viewNames = page.views.map((view) => cleanName(view.name));
    const emptyView = viewNames.findIndex((viewName) => viewName === "");
    if (emptyView >= 0) deny("invalid_pages", `页面「${name}」的第 ${emptyView + 1} 个画面名是空的`, next);
    const repeated = viewNames.findIndex((viewName, i) => viewNames.indexOf(viewName) !== i);
    if (repeated >= 0) deny("invalid_pages", `页面「${name}」的画面「${viewNames[repeated]}」重名`, next);
    const dirtyView = page.views.findIndex((view, i) => view.name !== viewNames[i]);
    if (dirtyView >= 0) deny("invalid_pages", `页面「${name}」的第 ${dirtyView + 1} 个画面名有多余空白或不可见字符`, next);
    return { name, group: cleanName(page.group ?? "") || "状态", views: page.views.map((view, i) => ({ name: viewNames[i]!, notes: cleanLines(view.notes) })) };
  });
}

function checkSubmittedDesigns(design: string | string[] | undefined, options: readonly string[]): { letter: PickedOption["letter"] | null; text: string }[] {
  const next = "按原因改好 DESIGN.md 后重交";
  if (design === undefined) deny("invalid_design", "交稿没带 DESIGN.md 全文", "在 design 里带上 DESIGN.md 全文后重交");
  const texts = typeof design === "string" ? [design] : design!;
  if (typeof design !== "string") {
    if (!options.length) deny("invalid_design", "只画了一种方案，DESIGN.md 交一份就行", next);
    if (texts.length !== options.length) {
      const missing = texts.length < options.length ? `，缺${options.slice(texts.length).map((_, i) => `方案 ${optionLetter(texts.length + i)} 的 DESIGN.md`).join("、")}` : "";
      deny("invalid_design", `画了 ${options.length} 个方案，DESIGN.md 交了 ${texts.length} 份${missing}；各方案风格不同时每个方案各交一份，按方案顺序，相同时交一份`, next);
    }
  }
  return texts.map((text, index) => {
    const letter = typeof design === "string" ? null : optionLetter(index);
    const prefix = letter ? `方案 ${letter} 的 ` : "";
    if (text === "") deny("invalid_design", `${prefix}DESIGN.md 没交`, next);
    try { checkDesignSpec(text); }
    catch (error) {
      if (error instanceof DesignSpecError) deny("invalid_design", `${prefix}${error.message}`, next);
      throw error;
    }
    return { letter, text };
  });
}

const HTML_START = /^\s*<(?:!doctype\s+html|html)[\s>]/i;

function settledRuns(rows: ChangeRow[]): Set<string> {
  return new Set(rows.flatMap((row) => row.data.kind === "submit" || row.data.kind === "end" ? [row.data.runId] : []));
}

const beginRows = (rows: ChangeRow[]) => rows.filter((row): row is ChangeRow & { data: ChangeKind<"begin"> } => row.data.kind === "begin");

export async function submitDesign(ref: Ref, input: { requirementId: string; name: string; runId: string; design?: string | string[]; html: string; note: string; pages: SubmittedPage[]; options?: string[]; prototypeOnly?: string[]; openQuestions?: string[] }): Promise<void> {
  const options = checkOptionList(input.options);
  const designs = checkSubmittedDesigns(input.design, options);
  if (!HTML_START.test(input.html)) deny("not_html", "交稿内容不是 HTML 页面", "交一份以 <!doctype html> 或 <html> 开头的完整页面");
  if (input.note.length > NOTE_MAX_LENGTH) deny("note_too_long", `交稿说明超过 ${NOTE_MAX_LENGTH} 字`, "缩短说明后重交");
  const pages = checkPageList(input.pages);
  const prototypeOnly = cleanLines(input.prototypeOnly);
  const openQuestions = cleanLines(input.openQuestions);
  withDatabase(databaseOf(ref), (db) => db.transaction(() => {
    assertRequirementEditable(db, input.requirementId);
    const rows = changeRows(db, input.requirementId);
    const settled = settledRuns(rows);
    const running = beginRows(rows).filter((row) => row.data.name === input.name && !settled.has(row.data.runId));
    if (!running.length) deny("not_in_flight", "这份原型当前没有在做的设计", "刷新后按看板当前状态操作");
    const begin = running.find((row) => row.data.runId === input.runId);
    if (!begin) deny("run_mismatch", "这次运行不是这份原型当前的设计运行", "只有被派出的设计运行才能交稿");
    const { version } = begin!.data;
    const path = prototypeFilePath(ref, { requirementId: input.requirementId, name: input.name, version });
    const content = buildPrototypeFrame({ html: input.html, name: input.name, version, pages, options, prototypeOnly, openQuestions });
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > PROTOTYPE_MAX_BYTES) deny("too_large", `原型 ${bytes} 字节，超过 ${PROTOTYPE_MAX_BYTES} 字节上限`, "精简原型后重交");
    for (const { letter, text } of designs) writeFileAtomicSync(designFilePath(ref, { requirementId: input.requirementId, name: input.name, version, letter }), text);
    writeFileAtomicSync(path, content);
    recordChange(db, input.requirementId, anchorOfRow(db, begin!), { kind: "submit", name: input.name, version, runId: input.runId,
      file: { version, hash: sha256(content), bytes, note: input.note, options, picked: null },
      designs: designs.map(({ letter, text }) => ({ letter, hash: sha256(text), bytes: Buffer.byteLength(text, "utf8") })) });
  }));
}

function writeFileAtomicSync(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const file = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(file, content, "utf8");
    fsyncSync(file);
  } catch (error) {
    closeSync(file);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(file);
  try { renameSync(temporary, path); }
  catch (error) { rmSync(temporary, { force: true }); throw error; }
  const directory = openSync(dir, "r");
  try { fsyncSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EINVAL") throw error; }
  finally { closeSync(directory); }
}

function endRuns(ref: Ref, reason: string, matches: (begin: ChangeKind<"begin">) => boolean): void {
  withDatabase(databaseOf(ref), (db) => db.transaction(() => {
    const rows = db.list<PrototypeChange>(CHANGES).map((row) => ({ key: row.key, data: row.data }));
    const settled = settledRuns(rows);
    for (const row of beginRows(rows)) {
      if (settled.has(row.data.runId) || !matches(row.data)) continue;
      recordChange(db, row.data.requirementId, anchorOfRow(db, row), { kind: "end", name: row.data.name, version: row.data.version, runId: row.data.runId, reason: reason.slice(0, REASON_MAX_LENGTH) });
    }
  }));
}

export async function endDesign(ref: Ref, input: { runId: string; reason: string }): Promise<void> {
  endRuns(ref, input.reason, (begin) => begin.runId === input.runId);
}

export async function clearStaleDesigns(ref: Ref): Promise<void> {
  endRuns(ref, "守护进程重启，设计中断", () => true);
}

function voidRun(ref: Ref, requirementId: string, runId: string): never {
  withDatabase(databaseOf(ref), (db) => db.transaction(() => {
    const rows = changeRows(db, requirementId);
    const begin = beginRows(rows).find((row) => row.data.runId === runId);
    if (!begin || rows.some((row) => row.data.kind === "end" && row.data.runId === runId)) return;
    recordChange(db, requirementId, anchorOfRow(db, begin), { kind: "end", name: begin.data.name, version: begin.data.version, runId, reason: "文件在交稿后被改过，这一版已作废" });
  }));
  return deny("file_changed", "文件在交稿后被改过，与登记的指纹不一致", "这一版已作废，请让主代理重新派原型设计师");
}

const readOrNull = (path: string) => readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });

async function verifiedFile(ref: Ref, requirementId: string, name: string, inFlight: NonNullable<PrototypeEntry["inFlight"]>): Promise<{ path: string; content: Buffer }> {
  const file = inFlight.file!;
  const path = prototypeFilePath(ref, { requirementId, name, version: file.version });
  const content = await readOrNull(path);
  if (!content || sha256(content) !== file.hash) voidRun(ref, requirementId, inFlight.runId);
  return { path, content: content! };
}

type DesignCandidate = { letter: PickedOption["letter"] | null; text: string };

async function verifiedDesigns(ref: Ref, requirementId: string, name: string, inFlight: NonNullable<PrototypeEntry["inFlight"]>): Promise<DesignCandidate[]> {
  const candidates: DesignCandidate[] = [];
  for (const design of inFlight.designs ?? []) {
    const content = await readOrNull(designFilePath(ref, { requirementId, name, version: inFlight.version, letter: design.letter }));
    if (!content || sha256(content) !== design.hash) voidRun(ref, requirementId, inFlight.runId);
    candidates.push({ letter: design.letter, text: content!.toString("utf8") });
  }
  return candidates;
}

const readRootDesign = (repositoryRoot: string) => readFile(join(repositoryRoot, DESIGN_SPEC_FILE), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
const designFingerprint = (text: string | null) => text === null ? null : sha256(text);

async function readLineDesign(ref: Ref, input: { requirementId: string; line: readonly string[]; repositoryRoot: string }): Promise<{ onLine: string | null; root: string | null }> {
  const commit = withDatabase(databaseOf(ref), (db) => { assertRequirementEditable(db, input.requirementId); return lineViewOf(db, input.requirementId, input.line).fileCommit; });
  const files = commit === null ? null : await readDraftFiles({ dataRoot: ref.dataRoot, repoId: ref.repoId, requirementId: input.requirementId, commit, authorize: () => true });
  return { onLine: files?.design ? Buffer.from(files.design).toString("utf8") : null, root: await readRootDesign(input.repositoryRoot) };
}

export async function lineDesignSpec(ref: Ref, input: { requirementId: string; line: readonly string[]; repositoryRoot: string }): Promise<string | null> {
  const { onLine, root } = await readLineDesign(ref, input);
  return onLine ?? root;
}

export type DesignState =
  | { state: "created" | "same" | "conflict" }
  | { state: "changed"; changes: Array<{ letter: PickedOption["letter"] | null; chapters: string[] }> };

function designState(current: string | null, designBase: string | null, candidates: DesignCandidate[]): DesignState {
  if (designFingerprint(current) !== designBase && !(candidates.length > 0 && candidates.every((candidate) => candidate.text === current))) return { state: "conflict" };
  if (current === null) return { state: "created" };
  const changes = candidates.map(({ letter, text }) => ({ letter, chapters: changedChapters(current, text) }));
  return changes.every((change) => change.chapters.length === 0) ? { state: "same" } : { state: "changed", changes };
}

export async function pendingConfirmation(ref: Ref, input: { repositoryRoot: string; requirementId: string; name: string; line: readonly string[] }):
  Promise<{ name: string; version: number; hash: string; bytes: number; note: string; options: string[]; path: string; previousOpinion: string | null; design: DesignState }> {
  withDatabase(databaseOf(ref), (db) => assertRequirementEditable(db, input.requirementId));
  const board = await readPrototypeBoard(ref, input.requirementId, input.line);
  const { entry, inFlight } = requireInFlight(board, input.name, "awaiting");
  const file = inFlight.file!;
  const { path } = await verifiedFile(ref, input.requirementId, input.name, inFlight);
  const candidates = await verifiedDesigns(ref, input.requirementId, input.name, inFlight);
  const design = designState(await lineDesignSpec(ref, input), inFlight.designBase, candidates);
  return { name: input.name, version: file.version, hash: file.hash, bytes: file.bytes, note: file.note, options: file.options, path, previousOpinion: entry.lastOpinion && entry.lastOpinion.version < file.version ? entry.lastOpinion.opinion : null, design };
}

const lanes = new Map<string, { tail: Promise<unknown>; pending: number }>();

/** 同一个需求的写操作排队一个个做；后到的操作只按自己传入的对话线判断。 */
function inLane<T>(ref: Ref, requirementId: string, work: () => Promise<T>): Promise<T> {
  const key = `${ref.dataRoot}\0${ref.repoId}\0${requirementId}`;
  const lane = lanes.get(key) ?? { tail: Promise.resolve(), pending: 0 };
  lanes.set(key, lane);
  lane.pending++;
  const run = lane.tail.then(work);
  lane.tail = run.catch(() => undefined);
  return run.finally(() => { if (--lane.pending === 0) lanes.delete(key); });
}

async function commitLineFiles(ref: Ref, input: { requirementId: string; anchor: string; line: readonly string[]; changes: Record<string, Uint8Array | null> }): Promise<string> {
  const expectedParent = withDatabase(databaseOf(ref), (db) => lineViewOf(db, input.requirementId, input.line).fileCommit);
  if (!expectedParent) return deny("requirement_unavailable", "这条对话线上还没有保存过的需求正文，原型文件没有地方可记", "先保存需求草稿，再处理原型");
  const owner = { ownerToken: uuidv7(), pid: process.pid };
  withDatabase(databaseOf(ref), (db) => db.transaction(() => {
    releaseDeadRequirementWriteIn(db, ref.repoId, input.requirementId);
    claimRequirementWriteIn(db, { ...owner, repoId: ref.repoId, requirementId: input.requirementId, operationId: input.anchor, acquiredAt: Date.now() }, { allowDeadOriginalOperationRecovery: false });
  }));
  try {
    const { commit } = await commitDraftFiles({ dataRoot: ref.dataRoot, repoId: ref.repoId, requirementId: input.requirementId, operationId: input.anchor, anchor: input.anchor,
      kind: "prototype", expectedParent, changes: input.changes, authorize: () => true });
    return commit;
  } finally {
    withDatabase(databaseOf(ref), (db) => db.transaction(() => { releaseRequirementWriteIn(db, ref.repoId, input.requirementId, input.anchor, owner); }));
  }
}

const treePath = (name: string, version: number) => `prototypes/${name}.v${version}.html`;

export async function decidePrototype(ref: Ref, input: { repositoryRoot: string; requirementId: string; name: string; version: number; hash: string; choice: "accept" | "opinion" | "abandon"; opinion: string | null; option: string | null; line: readonly string[]; anchor: string }): Promise<void> {
  withDatabase(databaseOf(ref), (db) => { assertRequirementEditable(db, input.requirementId); });
  const opinion = input.opinion?.trim() ?? "";
  if (input.choice === "opinion") {
    if (!opinion) deny("opinion_required", "意见不能为空", "写上意见后再提交");
    if (opinion.length > OPINION_MAX_LENGTH) deny("opinion_too_long", `意见超过 ${OPINION_MAX_LENGTH} 字`, "精简意见后再提交");
  }
  return inLane(ref, input.requirementId, async () => {
    const { line } = input;
    const matched = (board: PrototypeBoard) => {
      const found = requireInFlight(board, input.name, "awaiting");
      if (found.inFlight.file!.version !== input.version || found.inFlight.file!.hash !== input.hash) {
        deny("item_changed", "窗口显示的版本已不是当前等确认的版本", "请重新打开这份原型");
      }
      return found;
    };
    const { inFlight } = matched(await readPrototypeBoard(ref, input.requirementId, line));
    const { content } = await verifiedFile(ref, input.requirementId, input.name, inFlight);
    const candidates = input.choice === "accept" ? await verifiedDesigns(ref, input.requirementId, input.name, inFlight) : [];
    const lineDesign = input.choice === "accept" ? await readLineDesign(ref, { requirementId: input.requirementId, line, repositoryRoot: input.repositoryRoot }) : null;
    const settle = (db: LocalDatabase) => {
      assertRequirementEditable(db, input.requirementId);
      const { entry, inFlight: current } = matched(stateOn(db, input.requirementId, line));
      if (input.choice !== "accept") return { version: current.version, accept: null };
      const { options } = current.file!;
      let picked: PickedOption | null = null;
      if (options.length) {
        const index = OPTION_LETTERS.findIndex((letter) => letter === input.option);
        if (index < 0 || index >= options.length) deny("invalid_option", `这份原型有 ${options.length} 个方案（${OPTION_LETTERS.slice(0, options.length).join("、")}），通过时必须选其中一个`, "选定一个方案后再通过");
        picked = { letter: OPTION_LETTERS[index]!, name: options[index]! };
      } else if (input.option != null) deny("invalid_option", "这份原型没有方案清单，不能选方案", "不选方案直接通过");
      const currentDesign = lineDesign!.onLine ?? lineDesign!.root;
      const chosen = candidates.length === 1 ? candidates[0] : candidates.find((candidate) => candidate.letter === input.option);
      // 候选和这条线上现有的 DESIGN.md 一样时没有东西会被覆盖，开工后线上被改过也不算冲突
      if (designFingerprint(currentDesign) !== current.designBase && chosen?.text !== currentDesign) {
        deny("design_changed", "DESIGN.md 在你确认时被改过，这一版没有通过", "在窗口里选「其他」写意见，让主代理按最新的 DESIGN.md 重派一版");
      }
      const design = chosen && (currentDesign === null || changedChapters(currentDesign, chosen.text).length > 0) ? chosen.text : null;
      const previous = (entry.draft ?? entry.approved)?.version;
      return { version: current.version, accept: { picked, design, base: design !== null && lineDesign!.onLine === null ? lineDesign!.root : null, previous } };
    };
    const planned = withDatabase(databaseOf(ref), settle);
    const fileCommit = planned.accept
      ? await commitLineFiles(ref, { requirementId: input.requirementId, anchor: input.anchor, line, changes: {
        [treePath(input.name, planned.version)]: content,
        ...(planned.accept.previous !== undefined && planned.accept.previous !== planned.version ? { [treePath(input.name, planned.accept.previous)]: null } : {}),
        ...(planned.accept.design !== null ? { [DESIGN_SPEC_FILE]: Buffer.from(planned.accept.design) } : {}),
        ...(planned.accept.base !== null ? { "DESIGN.base.md": Buffer.from(planned.accept.base) } : {}) } })
      : undefined;
    withDatabase(databaseOf(ref), (db) => db.transaction(() => {
      const settled = settle(db);
      const anchor = newAnchor(db, ref, { requirementId: input.requirementId, line, anchor: input.anchor, fileCommit });
      const named = { name: input.name, version: settled.version };
      if (settled.accept) recordChange(db, input.requirementId, anchor, { kind: "accept", ...named, picked: settled.accept.picked });
      else if (input.choice === "opinion") recordChange(db, input.requirementId, anchor, { kind: "opinion", ...named, opinion });
      else recordChange(db, input.requirementId, anchor, { kind: "abandon", ...named });
    }));
  });
}

const inDraftSet = (entry: PrototypeEntry) => !entry.removed && (entry.draft ?? entry.approved);

export async function removeFromDraft(ref: Ref, input: { requirementId: string; name: string; version: number; line: readonly string[]; anchor: string }): Promise<void> {
  return inLane(ref, input.requirementId, async () => {
    const { line } = input;
    const check = (db: LocalDatabase) => {
      assertRequirementEditable(db, input.requirementId);
      const entry = entryNamed(stateOn(db, input.requirementId, line), input.name);
      if (!entry || !inDraftSet(entry)) deny("not_in_draft", "这份原型不在当前草稿集合里，无法移除", "只能移除草稿集合里已有的原型，窗口显示的内容可能已过期，请重新打开移除窗口");
      if ((entry!.draft ?? entry!.approved)!.version !== input.version) deny("item_changed", "窗口显示的版本已不是草稿里的那一版", "请重新打开移除窗口");
    };
    withDatabase(databaseOf(ref), check);
    const fileCommit = await commitLineFiles(ref, { requirementId: input.requirementId, anchor: input.anchor, line, changes: { [treePath(input.name, input.version)]: null } });
    withDatabase(databaseOf(ref), (db) => db.transaction(() => {
      check(db);
      const anchor = newAnchor(db, ref, { requirementId: input.requirementId, line, anchor: input.anchor, fileCommit });
      recordChange(db, input.requirementId, anchor, { kind: "remove", name: input.name, version: input.version });
    }));
  });
}

const inFlightItems = (board: PrototypeBoard) => board.entries.flatMap((entry) => entry.inFlight ? [{ name: entry.name, version: entry.inFlight.version, status: entry.inFlight.status }] : []);

export async function inFlightSummary(ref: Ref, requirementId: string, line: readonly string[]): Promise<Array<{ name: string; version: number; status: "designing" | "awaiting" }>> {
  return inFlightItems(await readPrototypeBoard(ref, requirementId, line));
}

export function inFlightBlock(items: Array<{ name: string; version: number; status: "designing" | "awaiting" }>): PrototypeBoardError | null {
  if (!items.length) return null;
  const why = `还不能批准：${items.map((item) => item.status === "awaiting" ? `原型「${item.name}」第 ${item.version} 版还在等你确认` : `原型「${item.name}」设计师还在做`).join("，")}`;
  return new PrototypeBoardError("in_flight", why, `先把${items.length === 1 ? "它" : `这 ${items.length} 份`}处理完（通过，或在确认窗口按 Esc 放弃），再说批准`);
}

export interface DraftItem { name: string; version: number; hash: string; bytes: number; note: string; picked: PickedOption | null; label: "new" | "kept" | "removed" }

function draftSet(board: PrototypeBoard): { items: DraftItem[]; digest: string } {
  const items = board.entries.flatMap((entry): DraftItem[] => {
    if (entry.removed) return entry.approved ? [{ name: entry.name, ...entry.approved, label: "removed" }] : [];
    if (entry.draft) return [{ name: entry.name, ...entry.draft, label: "new" }];
    return entry.approved ? [{ name: entry.name, ...entry.approved, label: "kept" }] : [];
  });
  const members = items.filter((item) => item.label !== "removed").map((item) => [item.name, item.version, item.hash]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return { items, digest: sha256(JSON.stringify(members)) };
}

export async function draftPrototypes(ref: Ref, requirementId: string, line: readonly string[]): Promise<{ items: DraftItem[]; digest: string }> {
  return draftSet(await readPrototypeBoard(ref, requirementId, line));
}

export async function verifyDraftFiles(ref: Ref, requirementId: string, line: readonly string[]): Promise<void> {
  const { items } = await draftPrototypes(ref, requirementId, line);
  const changed: string[] = [];
  for (const item of items) {
    if (item.label === "removed") continue;
    const content = await readFile(prototypeFilePath(ref, { requirementId, name: item.name, version: item.version }))
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!content || sha256(content) !== item.hash) changed.push(`原型「${item.name}」第 ${item.version} 版的文件和通过时不一样或已不存在`);
  }
  if (changed.length) deny("file_changed", changed.join("；"), "重新派原型设计师出新版，或把它从草稿移除后再批准");
}

export function promoteOnApprovalIn(db: LocalDatabase, input: { requirementId: string; digest: string; line: readonly string[] }): { items: DraftItem[]; digest: string } {
  const { line } = input;
  const board = stateOn(db, input.requirementId, line);
  const blocked = inFlightBlock(inFlightItems(board));
  if (blocked) throw blocked;
  const set = draftSet(board);
  if (set.digest !== input.digest) deny("digest_changed", "草稿里的原型与批准窗口显示时不一致", "重新打开批准窗口确认当前原型");
  recordChange(db, input.requirementId, resolveLineTipIn(db, input.requirementId, line)?.anchor ?? null, { kind: "approve" });
  return set;
}
