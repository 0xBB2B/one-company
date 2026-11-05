import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { sanitizeText } from "../../core/policy/text-sanitize.ts";
import { repositoryDatabase, withDatabase } from "../../core/storage/database.ts";
import { writeFileAtomicSync as writeFileAtomicFollowingSymlink } from "../../core/storage/store.ts";
import type { LocalDatabase } from "../../core/storage/database.ts";
import { hash as sha256Hex, id, object, positive } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { unsafeFilenameKind } from "./requirement-identity.ts";
import { DESIGN_SPEC_FILE, DesignSpecError, changedChapters, checkDesignSpec } from "./design-spec.ts";
import { buildPrototypeFrame } from "./prototype-frame.ts";
import type { PrototypePage } from "./prototype-frame.ts";
import type { FailureAdvice } from "../../core/exec/tool-failure.ts";

const PROTOTYPES = "requirement_prototypes";
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
    designs: Type.Union([Type.Array(object({ letter: Type.Union([Type.Enum(OPTION_LETTERS), Type.Null()]), hash: sha256Hex, bytes: Type.Integer({ minimum: 1, maximum: 16384 }) }), { minItems: 1, maxItems: 6 }), Type.Null()]) }), Type.Null()]),
  lastOpinion: Type.Union([object({ version: positive, opinion: Type.String({ minLength: 1, maxLength: 4000 }) }), Type.Null()]),
  lastEnded: Type.Union([object({ version: positive, reason: Type.String({ maxLength: 500 }) }), Type.Null()]),
});
export const PrototypeBoard = object({ requirementId: id, entries: Type.Array(PrototypeEntry, { maxItems: 50 }), updatedAt: positive });
type PrototypeFile = Static<typeof PrototypeFile>;
type PrototypeEntry = Static<typeof PrototypeEntry>;
export type PrototypeBoard = Static<typeof PrototypeBoard>;

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

const emptyBoard = (requirementId: string): PrototypeBoard => ({ requirementId, entries: [], updatedAt: Date.now() });
export const readBoardIn = (db: LocalDatabase, requirementId: string) => db.read<PrototypeBoard>(PROTOTYPES, requirementId);

export async function readPrototypeBoard(ref: Ref, requirementId: string): Promise<PrototypeBoard> {
  return withDatabase(databaseOf(ref), (db) => readBoardIn(db, requirementId)?.data ?? emptyBoard(requirementId));
}

function apply<T>(db: LocalDatabase, requirementId: string, change: (board: PrototypeBoard) => T): T {
  const row = readBoardIn(db, requirementId);
  const board: PrototypeBoard = row?.data ?? emptyBoard(requirementId);
  const result = change(board);
  board.updatedAt = Date.now();
  if (!Value.Check(PrototypeBoard, board)) throw new Error("原型看板记录不符合结构");
  if (row) db.update(PROTOTYPES, requirementId, row.version, board); else db.create(PROTOTYPES, requirementId, board);
  return result;
}

function mutate<T>(db: LocalDatabase, requirementId: string, change: (board: PrototypeBoard) => T): T {
  let result!: T;
  db.transaction(() => { result = apply(db, requirementId, change); });
  return result;
}

const foldName = (name: string) => name.normalize("NFC").toLowerCase();
const entryNamed = (board: PrototypeBoard, name: string) => board.entries.find((entry) => entry.name === name);

function requireInFlight(board: PrototypeBoard, name: string, status: "designing" | "awaiting"): { entry: PrototypeEntry; inFlight: NonNullable<PrototypeEntry["inFlight"]> } {
  const entry = entryNamed(board, name);
  if (!entry?.inFlight || entry.inFlight.status !== status) {
    return deny("not_in_flight", status === "designing" ? "这份原型当前没有在做的设计" : "这份原型当前没有等确认的版本", "刷新后按看板当前状态操作");
  }
  return { entry, inFlight: entry.inFlight };
}

export async function beginDesign(ref: Ref, input: { requirementId: string; name: string; runId: string; agent: string; designBase: string | null }):
  Promise<{ version: number; previous: { path: string; opinion: string | null; designPaths: string[] } | null }> {
  checkPrototypeName(input.name);
  return withDatabase(databaseOf(ref), (db) => {
    return mutate(db, input.requirementId, (board) => {
      assertRequirementEditable(db, input.requirementId);
      let entry = entryNamed(board, input.name);
      const replacedDesigns = entry?.inFlight?.designs ?? [];
      if (entry?.inFlight) {
        const { inFlight } = entry;
        if (inFlight.status === "designing") deny("in_flight", `原型「${input.name}」还在做`, "等设计师交稿后再处理");
        if (entry.lastOpinion?.version !== inFlight.version) {
          deny("in_flight", `原型「${input.name}」第 ${inFlight.version} 版还在等用户确认，用户没有对它提意见，不能重派`, "先请用户在确认窗口里处理");
        }
        entry.lastEnded = { version: inFlight.version, reason: "用户提了意见后重派，这一版作废" };
        entry.inFlight = null;
      }
      if (!entry) {
        const sameLooking = board.entries.find((other) => foldName(other.name) === foldName(input.name));
        if (sameLooking) deny("name_conflict", `已有原型「${sameLooking.name}」，名称只差大小写或写法`, "请用已有名称或换个名字");
        if (board.entries.length >= MAX_ENTRIES) deny("too_many_prototypes", `一个需求最多 ${MAX_ENTRIES} 份原型`, "复用已有名称");
        entry = { name: input.name, lastVersion: 0, draft: null, approved: null, removed: false, inFlight: null, lastOpinion: null, lastEnded: null };
        board.entries.push(entry);
      }
      const version = entry.lastVersion + 1;
      const source = entry.lastOpinion ? { version: entry.lastOpinion.version, opinion: entry.lastOpinion.opinion as string | null }
        : (entry.draft ?? entry.approved) ? { version: (entry.draft ?? entry.approved)!.version, opinion: null } : null;
      const previous = source && {
        path: prototypeFilePath(ref, { requirementId: input.requirementId, name: input.name, version: source.version }), opinion: source.opinion,
        designPaths: replacedDesigns.map((design) => designFilePath(ref, { requirementId: input.requirementId, name: input.name, version: source.version, letter: design.letter })),
      };
      entry.lastVersion = version;
      entry.inFlight = { version, runId: input.runId, agent: input.agent, status: "designing", file: null, designBase: input.designBase, designs: null };
      return { version, previous };
    });
  });
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

export async function submitDesign(ref: Ref, input: { requirementId: string; name: string; runId: string; design?: string | string[]; html: string; note: string; pages: SubmittedPage[]; options?: string[]; prototypeOnly?: string[]; openQuestions?: string[] }): Promise<void> {
  const options = checkOptionList(input.options);
  const designs = checkSubmittedDesigns(input.design, options);
  if (!HTML_START.test(input.html)) deny("not_html", "交稿内容不是 HTML 页面", "交一份以 <!doctype html> 或 <html> 开头的完整页面");
  if (input.note.length > NOTE_MAX_LENGTH) deny("note_too_long", `交稿说明超过 ${NOTE_MAX_LENGTH} 字`, "缩短说明后重交");
  const pages = checkPageList(input.pages);
  const prototypeOnly = cleanLines(input.prototypeOnly);
  const openQuestions = cleanLines(input.openQuestions);
  withDatabase(databaseOf(ref), (db) => mutate(db, input.requirementId, (board) => {
    assertRequirementEditable(db, input.requirementId);
    const { inFlight } = requireInFlight(board, input.name, "designing");
    if (inFlight.runId !== input.runId) deny("run_mismatch", "这次运行不是这份原型当前的设计运行", "只有被派出的设计运行才能交稿");
    const path = prototypeFilePath(ref, { requirementId: input.requirementId, name: input.name, version: inFlight.version });
    const content = buildPrototypeFrame({ html: input.html, name: input.name, version: inFlight.version, pages, options, prototypeOnly, openQuestions });
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > PROTOTYPE_MAX_BYTES) deny("too_large", `原型 ${bytes} 字节，超过 ${PROTOTYPE_MAX_BYTES} 字节上限`, "精简原型后重交");
    for (const { letter, text } of designs) writeFileAtomicSync(designFilePath(ref, { requirementId: input.requirementId, name: input.name, version: inFlight.version, letter }), text);
    writeFileAtomicSync(path, content);
    inFlight.designs = designs.map(({ letter, text }) => ({ letter, hash: sha256(text), bytes: Buffer.byteLength(text, "utf8") }));
    inFlight.status = "awaiting";
    inFlight.file = { version: inFlight.version, hash: sha256(content), bytes, note: input.note, options, picked: null };
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

function endRuns(ref: Ref, reason: string, matches: (inFlight: NonNullable<PrototypeEntry["inFlight"]>) => boolean): void {
  withDatabase(databaseOf(ref), (db) => db.transaction(() => {
    for (const row of db.list<PrototypeBoard>(PROTOTYPES)) {
      if (!row.data.entries.some((entry) => entry.inFlight?.status === "designing" && matches(entry.inFlight))) continue;
      apply(db, row.key, (board) => {
        for (const entry of board.entries) {
          if (entry.inFlight?.status !== "designing" || !matches(entry.inFlight)) continue;
          entry.lastEnded = { version: entry.inFlight.version, reason: reason.slice(0, REASON_MAX_LENGTH) };
          entry.inFlight = null;
        }
      });
    }
  }));
}

export async function endDesign(ref: Ref, input: { runId: string; reason: string }): Promise<void> {
  endRuns(ref, input.reason, (inFlight) => inFlight.runId === input.runId);
}

export async function clearStaleDesigns(ref: Ref): Promise<void> {
  endRuns(ref, "守护进程重启，设计中断", () => true);
}

function voidVersion(ref: Ref, requirementId: string, name: string, version: number): never {
  withDatabase(databaseOf(ref), (db) => mutate(db, requirementId, (board) => {
    const entry = entryNamed(board, name);
    if (entry?.inFlight?.status !== "awaiting" || entry.inFlight.version !== version) return;
    entry.lastEnded = { version, reason: "文件在交稿后被改过，这一版已作废" };
    entry.inFlight = null;
  }));
  return deny("file_changed", "文件在交稿后被改过，与登记的指纹不一致", "这一版已作废，请让主代理重新派原型设计师");
}

const readOrNull = (path: string) => readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });

async function verifiedFile(ref: Ref, requirementId: string, name: string, file: PrototypeFile): Promise<string> {
  const path = prototypeFilePath(ref, { requirementId, name, version: file.version });
  const content = await readOrNull(path);
  if (!content || sha256(content) !== file.hash) voidVersion(ref, requirementId, name, file.version);
  return path;
}

type DesignCandidate = { letter: PickedOption["letter"] | null; text: string };

async function verifiedDesigns(ref: Ref, requirementId: string, name: string, inFlight: NonNullable<PrototypeEntry["inFlight"]>): Promise<DesignCandidate[]> {
  const candidates: DesignCandidate[] = [];
  for (const design of inFlight.designs ?? []) {
    const content = await readOrNull(designFilePath(ref, { requirementId, name, version: inFlight.version, letter: design.letter }));
    if (!content || sha256(content) !== design.hash) voidVersion(ref, requirementId, name, inFlight.version);
    candidates.push({ letter: design.letter, text: content!.toString("utf8") });
  }
  return candidates;
}

const readRootDesign = (repositoryRoot: string) => readFile(join(repositoryRoot, DESIGN_SPEC_FILE), "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
const rootFingerprint = (root: string | null) => root === null ? null : sha256(root);

export type DesignState =
  | { state: "created" | "same" | "conflict" }
  | { state: "changed"; changes: Array<{ letter: PickedOption["letter"] | null; chapters: string[] }> };

function designState(root: string | null, designBase: string | null, candidates: DesignCandidate[]): DesignState {
  if (rootFingerprint(root) !== designBase) return { state: "conflict" };
  if (root === null) return { state: "created" };
  const changes = candidates.map(({ letter, text }) => ({ letter, chapters: changedChapters(root, text) }));
  return changes.every((change) => change.chapters.length === 0) ? { state: "same" } : { state: "changed", changes };
}

export async function pendingConfirmation(ref: Ref, input: { repositoryRoot: string; requirementId: string; name: string }):
  Promise<{ name: string; version: number; hash: string; bytes: number; note: string; options: string[]; path: string; previousOpinion: string | null; design: DesignState }> {
  withDatabase(databaseOf(ref), (db) => assertRequirementEditable(db, input.requirementId));
  const board = await readPrototypeBoard(ref, input.requirementId);
  const { entry, inFlight } = requireInFlight(board, input.name, "awaiting");
  const file = inFlight.file!;
  const path = await verifiedFile(ref, input.requirementId, input.name, file);
  const candidates = await verifiedDesigns(ref, input.requirementId, input.name, inFlight);
  const design = designState(await readRootDesign(input.repositoryRoot), inFlight.designBase, candidates);
  return { name: input.name, version: file.version, hash: file.hash, bytes: file.bytes, note: file.note, options: file.options, path, previousOpinion: entry.lastOpinion && entry.lastOpinion.version < file.version ? entry.lastOpinion.opinion : null, design };
}

export async function decidePrototype(ref: Ref, input: { repositoryRoot: string; requirementId: string; name: string; version: number; hash: string; choice: "accept" | "opinion" | "abandon"; opinion: string | null; option: string | null }): Promise<void> {
  withDatabase(databaseOf(ref), (db) => { assertRequirementEditable(db, input.requirementId); });
  const opinion = input.opinion?.trim() ?? "";
  if (input.choice === "opinion") {
    if (!opinion) deny("opinion_required", "意见不能为空", "写上意见后再提交");
    if (opinion.length > OPINION_MAX_LENGTH) deny("opinion_too_long", `意见超过 ${OPINION_MAX_LENGTH} 字`, "精简意见后再提交");
  }
  const board = await readPrototypeBoard(ref, input.requirementId);
  const matched = (current: PrototypeBoard) => {
    const found = requireInFlight(current, input.name, "awaiting");
    if (found.inFlight.file!.version !== input.version || found.inFlight.file!.hash !== input.hash) {
      deny("item_changed", "窗口显示的版本已不是当前等确认的版本", "请重新打开这份原型");
    }
    return found;
  };
  const { inFlight } = matched(board);
  await verifiedFile(ref, input.requirementId, input.name, inFlight.file!);
  const candidates = input.choice === "accept" ? await verifiedDesigns(ref, input.requirementId, input.name, inFlight) : [];
  withDatabase(databaseOf(ref), (db) => mutate(db, input.requirementId, (current) => {
    assertRequirementEditable(db, input.requirementId);
    const { entry, inFlight } = matched(current);
    if (input.choice === "accept") {
      const { options } = inFlight.file!;
      let picked: PickedOption | null = null;
      if (options.length) {
        const index = OPTION_LETTERS.findIndex((letter) => letter === input.option);
        if (index < 0 || index >= options.length) deny("invalid_option", `这份原型有 ${options.length} 个方案（${OPTION_LETTERS.slice(0, options.length).join("、")}），通过时必须选其中一个`, "选定一个方案后再通过");
        picked = { letter: OPTION_LETTERS[index]!, name: options[index]! };
      } else if (input.option != null) deny("invalid_option", "这份原型没有方案清单，不能选方案", "不选方案直接通过");
      entry.draft = { ...inFlight.file!, picked }; entry.removed = false;
      writeChosenDesign(input, inFlight, candidates);
    }
    if (input.choice === "opinion") { entry.lastOpinion = { version: inFlight.version, opinion }; return; }
    entry.lastOpinion = null;
    entry.inFlight = null;
  }));
}

// 在事务回调里同步写，让所有拒绝都发生在写文件之前，并发请求也不会在读和写之间交错
function writeChosenDesign(input: { repositoryRoot: string; option: string | null }, inFlight: NonNullable<PrototypeEntry["inFlight"]>, candidates: DesignCandidate[]): void {
  const path = join(input.repositoryRoot, DESIGN_SPEC_FILE);
  let root: string | null = null;
  try { root = readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (rootFingerprint(root) !== inFlight.designBase) deny("design_changed", "DESIGN.md 在你确认时被改过，这一版没有通过", "在窗口里选「其他」写意见，让主代理按最新的 DESIGN.md 重派一版");
  const chosen = candidates.length === 1 ? candidates[0] : candidates.find((candidate) => candidate.letter === input.option);
  if (!chosen) return;
  if (root === null || changedChapters(root, chosen.text).length > 0) writeFileAtomicFollowingSymlink(path, chosen.text, { followSymlink: true });
}

const inDraftSet = (entry: PrototypeEntry) => !entry.removed && (entry.draft ?? entry.approved);

export async function removeFromDraft(ref: Ref, input: { requirementId: string; name: string; version: number }): Promise<void> {
  withDatabase(databaseOf(ref), (db) => mutate(db, input.requirementId, (board) => {
    assertRequirementEditable(db, input.requirementId);
    const entry = entryNamed(board, input.name);
    if (!entry || !inDraftSet(entry)) deny("not_in_draft", "这份原型不在当前草稿集合里，无法移除", "只能移除草稿集合里已有的原型，窗口显示的内容可能已过期，请重新打开移除窗口");
    if ((entry!.draft ?? entry!.approved)!.version !== input.version) deny("item_changed", "窗口显示的版本已不是草稿里的那一版", "请重新打开移除窗口");
    entry!.draft = null;
    entry!.removed = true;
  }));
}

export async function inFlightSummary(ref: Ref, requirementId: string): Promise<Array<{ name: string; version: number; status: "designing" | "awaiting" }>> {
  const board = await readPrototypeBoard(ref, requirementId);
  return board.entries.flatMap((entry) => entry.inFlight ? [{ name: entry.name, version: entry.inFlight.version, status: entry.inFlight.status }] : []);
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

export async function draftPrototypes(ref: Ref, requirementId: string): Promise<{ items: DraftItem[]; digest: string }> {
  return draftSet(await readPrototypeBoard(ref, requirementId));
}

export async function verifyDraftFiles(ref: Ref, requirementId: string): Promise<void> {
  const { items } = await draftPrototypes(ref, requirementId);
  const changed: string[] = [];
  for (const item of items) {
    if (item.label === "removed") continue;
    const content = await readFile(prototypeFilePath(ref, { requirementId, name: item.name, version: item.version }))
      .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    if (!content || sha256(content) !== item.hash) changed.push(`原型「${item.name}」第 ${item.version} 版的文件和通过时不一样或已不存在`);
  }
  if (changed.length) deny("file_changed", changed.join("；"), "重新派原型设计师出新版，或把它从草稿移除后再批准");
}

export function promoteOnApprovalIn(db: LocalDatabase, input: { requirementId: string; digest: string }): { items: DraftItem[]; digest: string } {
  return apply(db, input.requirementId, (board) => {
    const blocked = inFlightBlock(board.entries.flatMap((entry) => entry.inFlight ? [{ name: entry.name, version: entry.inFlight.version, status: entry.inFlight.status }] : []));
    if (blocked) throw blocked;
    const set = draftSet(board);
    if (set.digest !== input.digest) deny("digest_changed", "草稿里的原型与批准窗口显示时不一致", "重新打开批准窗口确认当前原型");
    for (const entry of board.entries) {
      if (entry.removed) entry.approved = null;
      else if (entry.draft) entry.approved = entry.draft;
      entry.draft = null;
      entry.removed = false;
    }
    return set;
  });
}
