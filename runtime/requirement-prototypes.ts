import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { repositoryDatabase, withDatabase } from "./database.ts";
import type { LocalDatabase } from "./database.ts";
import { hash as sha256Hex, id, object, positive } from "./requirement-contracts.ts";
import { RequirementStateError } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { REQUIREMENT_OPERATION_NAMESPACE } from "./requirement-coordination.ts";
import { unsafeFilenameKind } from "./requirement-identity.ts";
import type { FailureAdvice } from "./tool-failure.ts";

const PROTOTYPES = "requirement_prototypes";
const PROTOTYPE_MAX_BYTES = 1_048_576;
const NAME_MAX_LENGTH = 40;
const NOTE_MAX_LENGTH = 2000;
const OPINION_MAX_LENGTH = 4000;
const REASON_MAX_LENGTH = 500;
const MAX_ENTRIES = 50;

const PrototypeFile = object({ version: positive, hash: sha256Hex, bytes: Type.Integer({ minimum: 1, maximum: 1_048_576 }), note: Type.String({ maxLength: 2000 }) });
const PrototypeEntry = object({
  name: Type.String({ minLength: 1, maxLength: 40 }),
  lastVersion: positive,
  draft: Type.Union([PrototypeFile, Type.Null()]),
  approved: Type.Union([PrototypeFile, Type.Null()]),
  removed: Type.Boolean(),
  inFlight: Type.Union([object({ version: positive, runId: id, agent: Type.String(), status: Type.Union([Type.Literal("designing"), Type.Literal("awaiting")]),
    file: Type.Union([PrototypeFile, Type.Null()]) }), Type.Null()]),
  lastRework: Type.Union([object({ version: positive, opinion: Type.String({ minLength: 1, maxLength: 4000 }) }), Type.Null()]),
  lastEnded: Type.Union([object({ version: positive, reason: Type.String({ maxLength: 500 }) }), Type.Null()]),
});
const PrototypeBoard = object({ requirementId: id, entries: Type.Array(PrototypeEntry, { maxItems: 50 }), updatedAt: positive });
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

const assertNotApproving = (db: LocalDatabase, requirementId: string): void => {
  const approving = db.list<{ requirementId?: string; action?: string; finalVersion?: number | null }>(REQUIREMENT_OPERATION_NAMESPACE)
    .some((row) => row.data.requirementId === requirementId && row.data.action === "confirmUpdate" && row.data.finalVersion === null);
  if (approving) deny("approving", "需求正在批准，原型暂时不能改动", "稍后再试");
};

type Ref = { dataRoot: string; repoId: string };
const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const databaseOf = (ref: Ref) => repositoryDatabase(ref.dataRoot, ref.repoId);

export function prototypeFilePath(ref: Ref, input: { requirementId: string; name: string; version: number }): string {
  return join(dirname(databaseOf(ref)), "prototypes", input.requirementId, `${input.name}.v${input.version}.html`);
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

export async function beginDesign(ref: Ref, input: { requirementId: string; name: string; runId: string; agent: string }): Promise<{ version: number; previous: { path: string; opinion: string | null } | null }> {
  checkPrototypeName(input.name);
  return withDatabase(databaseOf(ref), (db) => {
    return mutate(db, input.requirementId, (board) => {
      assertNotApproving(db, input.requirementId);
      const requirement = db.read<RequirementRecord>("requirements", input.requirementId)?.data;
      if (!requirement || requirement.lifecycle === "closing" || requirement.lifecycle === "closed" || requirement.recovery !== "ready") {
        deny("requirement_unavailable", "需求不存在、已完成或正在等用户恢复核对，不能再做原型", "先处理需求状态，不要继续派原型设计");
      }
      let entry = entryNamed(board, input.name);
      if (entry?.inFlight) {
        deny("in_flight", entry.inFlight.status === "designing" ? `原型「${input.name}」还在做` : `原型「${input.name}」还在等确认`,
          entry.inFlight.status === "designing" ? "等设计师交稿后再处理" : "先让用户在窗口里确认这一版");
      }
      if (!entry) {
        const sameLooking = board.entries.find((other) => foldName(other.name) === foldName(input.name));
        if (sameLooking) deny("name_conflict", `已有原型「${sameLooking.name}」，名称只差大小写或写法`, "请用已有名称或换个名字");
        if (board.entries.length >= MAX_ENTRIES) deny("too_many_prototypes", `一个需求最多 ${MAX_ENTRIES} 份原型`, "复用已有名称，或先移除不用的原型");
        entry = { name: input.name, lastVersion: 0, draft: null, approved: null, removed: false, inFlight: null, lastRework: null, lastEnded: null };
        board.entries.push(entry);
      }
      const version = entry.lastVersion + 1;
      const source = entry.lastRework ? { version: entry.lastRework.version, opinion: entry.lastRework.opinion as string | null }
        : (entry.draft ?? entry.approved) ? { version: (entry.draft ?? entry.approved)!.version, opinion: null } : null;
      const previous = source && { path: prototypeFilePath(ref, { requirementId: input.requirementId, name: input.name, version: source.version }), opinion: source.opinion };
      entry.lastVersion = version;
      entry.inFlight = { version, runId: input.runId, agent: input.agent, status: "designing", file: null };
      return { version, previous };
    });
  });
}

const HTML_START = /^\s*<(?:!doctype\s+html|html)[\s>]/i;

export async function submitDesign(ref: Ref, input: { requirementId: string; name: string; runId: string; html: string; note: string }): Promise<void> {
  const bytes = Buffer.byteLength(input.html, "utf8");
  if (bytes > PROTOTYPE_MAX_BYTES) deny("too_large", `原型 ${bytes} 字节，超过 ${PROTOTYPE_MAX_BYTES} 字节上限`, "精简原型后重交");
  if (!HTML_START.test(input.html)) deny("not_html", "交稿内容不是 HTML 页面", "交一份以 <!doctype html> 或 <html> 开头的完整页面");
  if (input.note.length > NOTE_MAX_LENGTH) deny("note_too_long", `交稿说明超过 ${NOTE_MAX_LENGTH} 字`, "缩短说明后重交");
  withDatabase(databaseOf(ref), (db) => mutate(db, input.requirementId, (board) => {
    const { inFlight } = requireInFlight(board, input.name, "designing");
    if (inFlight.runId !== input.runId) deny("run_mismatch", "这次运行不是这份原型当前的设计运行", "只有被派出的设计运行才能交稿");
    const path = prototypeFilePath(ref, { requirementId: input.requirementId, name: input.name, version: inFlight.version });
    writeFileAtomicSync(path, input.html);
    inFlight.status = "awaiting";
    inFlight.file = { version: inFlight.version, hash: sha256(input.html), bytes, note: input.note };
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

async function verifiedFile(ref: Ref, requirementId: string, name: string, file: PrototypeFile): Promise<string> {
  const path = prototypeFilePath(ref, { requirementId, name, version: file.version });
  const content = await readFile(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  if (!content || sha256(content) !== file.hash) {
    withDatabase(databaseOf(ref), (db) => mutate(db, requirementId, (board) => {
      const entry = entryNamed(board, name);
      if (entry?.inFlight?.status !== "awaiting" || entry.inFlight.version !== file.version) return;
      entry.lastEnded = { version: file.version, reason: "文件在交稿后被改过，这一版已作废" };
      entry.inFlight = null;
    }));
    deny("file_changed", "文件在交稿后被改过，与登记的指纹不一致", "这一版已作废，请让主代理重新派原型设计师");
  }
  return path;
}

export async function pendingConfirmation(ref: Ref, input: { requirementId: string; name: string }):
  Promise<{ name: string; version: number; hash: string; bytes: number; note: string; path: string; previousOpinion: string | null }> {
  const board = await readPrototypeBoard(ref, input.requirementId);
  const { entry, inFlight } = requireInFlight(board, input.name, "awaiting");
  const file = inFlight.file!;
  const path = await verifiedFile(ref, input.requirementId, input.name, file);
  return { name: input.name, version: file.version, hash: file.hash, bytes: file.bytes, note: file.note, path, previousOpinion: entry.lastRework?.opinion ?? null };
}

export async function decidePrototype(ref: Ref, input: { requirementId: string; name: string; version: number; hash: string; choice: "accept" | "rework" | "abandon"; opinion: string | null }): Promise<void> {
  withDatabase(databaseOf(ref), (db) => assertNotApproving(db, input.requirementId));
  const opinion = input.opinion?.trim() ?? "";
  if (input.choice === "rework") {
    if (!opinion) deny("opinion_required", "返工须写明要改什么", "输入修改意见后再提交");
    if (opinion.length > OPINION_MAX_LENGTH) deny("opinion_too_long", `返工意见超过 ${OPINION_MAX_LENGTH} 字`, "精简意见后再提交");
  }
  const board = await readPrototypeBoard(ref, input.requirementId);
  const matched = (current: PrototypeBoard) => {
    const found = requireInFlight(current, input.name, "awaiting");
    if (found.inFlight.file!.version !== input.version || found.inFlight.file!.hash !== input.hash) {
      deny("item_changed", "窗口显示的版本已不是当前等确认的版本", "请重新打开这份原型");
    }
    return found;
  };
  await verifiedFile(ref, input.requirementId, input.name, matched(board).inFlight.file!);
  withDatabase(databaseOf(ref), (db) => mutate(db, input.requirementId, (current) => {
    assertNotApproving(db, input.requirementId);
    const { entry, inFlight } = matched(current);
    if (input.choice === "accept") { entry.draft = inFlight.file; entry.removed = false; }
    entry.lastRework = input.choice === "rework" ? { version: inFlight.version, opinion } : null;
    entry.inFlight = null;
  }));
}

const inDraftSet = (entry: PrototypeEntry) => !entry.removed && (entry.draft ?? entry.approved);

export async function removeFromDraft(ref: Ref, input: { requirementId: string; name: string }): Promise<void> {
  withDatabase(databaseOf(ref), (db) => mutate(db, input.requirementId, (board) => {
    assertNotApproving(db, input.requirementId);
    const entry = entryNamed(board, input.name);
    if (!entry || !inDraftSet(entry)) deny("not_in_draft", "这份原型不在当前草稿集合里，无法移除", "只能移除草稿集合里已有的原型");
    entry!.draft = null;
    entry!.removed = true;
    entry!.lastRework = null;
  }));
}

export async function inFlightSummary(ref: Ref, requirementId: string): Promise<Array<{ name: string; version: number; status: "designing" | "awaiting" }>> {
  const board = await readPrototypeBoard(ref, requirementId);
  return board.entries.flatMap((entry) => entry.inFlight ? [{ name: entry.name, version: entry.inFlight.version, status: entry.inFlight.status }] : []);
}

export function inFlightBlock(items: Array<{ name: string; version: number; status: "designing" | "awaiting" }>): PrototypeBoardError | null {
  if (!items.length) return null;
  const why = `还不能批准：${items.map((item) => item.status === "awaiting" ? `原型「${item.name}」第 ${item.version} 版还在等你确认` : `原型「${item.name}」设计师还在做`).join("，")}`;
  return new PrototypeBoardError("in_flight", why, `先把${items.length === 1 ? "它" : `这 ${items.length} 份`}处理完（通过、返工或放弃），再说批准`);
}

export interface DraftItem { name: string; version: number; hash: string; bytes: number; note: string; label: "new" | "kept" | "removed" }

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

export function assertApprovableIn(db: LocalDatabase, requirementId: string, digest: string | undefined): void {
  const board = readBoardIn(db, requirementId)?.data;
  if (!board?.entries.length) return;
  if (!digest) throw new RequirementStateError("prototype_digest_required");
  const blocked = inFlightBlock(board.entries.flatMap((entry) => entry.inFlight ? [{ name: entry.name, version: entry.inFlight.version, status: entry.inFlight.status }] : []));
  if (blocked) throw blocked;
  if (draftSet(board).digest !== digest) deny("digest_changed", "草稿里的原型与批准窗口显示时不一致", "重新打开批准窗口确认当前原型");
}

export function promoteOnApprovalIn(db: LocalDatabase, input: { requirementId: string; digest: string }): { items: DraftItem[]; digest: string } {
  return apply(db, input.requirementId, (board) => {
    if (board.entries.some((entry) => entry.inFlight)) deny("in_flight", "还有原型在做或在等确认，不能批准", "等这些原型处理完再批准");
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

export async function promoteOnApproval(ref: Ref, input: { requirementId: string; digest: string }): Promise<{ items: DraftItem[]; digest: string }> {
  return withDatabase(databaseOf(ref), (db) => db.transaction(() => promoteOnApprovalIn(db, input)));
}
