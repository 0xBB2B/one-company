import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static } from "typebox";
import { snapshotBranchState } from "./branch-guard.ts";
import { authorizeToolAction, writePathAllowed } from "./core-permissions.ts";
import { repositoryDatabase, withDatabase } from "./database.ts";
import { checked, hash, id, object, PmLease, positive } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { checkServiceInput } from "./requirement-manage-contracts.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import { verifyRequirementWorkspace } from "./requirement-workspace.ts";
import { analyzeSpecSets } from "./spec-analysis.ts";
import { checkSpecSet, SpecFormatError } from "./spec-format.ts";
import type { SpecSource } from "./spec-format.ts";
import { writeFileAtomic } from "./store.ts";
import { resolveRealRepoPath } from "./write-guard.ts";

const SPEC_PROPOSALS = "spec_proposals";
const SPEC_DIRECTORY = "docs/spec";
const MAX_SPEC_FILES = 128;
const MAX_FILE_BYTES = 65_536;
const relativePath = Type.String({ minLength: 1, maxLength: 1024 });
const fileHash = Type.Union([hash, Type.Literal("absent")]);
const Grant = object({
  role: Type.Literal("pm"), callerId: id, runId: id, requirementId: id, repoId: hash, workspaceId: hash,
  branch: Type.String({ minLength: 1, maxLength: 4096, pattern: "^refs/heads/" }), lease: PmLease,
});
export type SpecChangeGrant = Static<typeof Grant>;
const proposalFile = object({ path: relativePath, baseHash: fileHash, content: Type.Union([Type.String({ maxLength: MAX_FILE_BYTES }), Type.Null()]) });
export const SPEC_CHANGE_PARAMETERS = Type.Union([
  object({ action: Type.Literal("propose"), operationId: id, files: Type.Array(proposalFile, { minItems: 1, maxItems: 32 }) }),
  object({ action: Type.Literal("validate"), operationId: id }),
  object({ action: Type.Literal("publish"), operationId: id }),
]);
export type SpecChangeParameters = Static<typeof SPEC_CHANGE_PARAMETERS>;
export type SpecChangeAction = SpecChangeParameters["action"];
const ProposalFile = object({ path: relativePath, baseHash: fileHash, targetHash: fileHash, content: Type.Union([Type.String(), Type.Null()]),
  status: Type.Union([Type.Literal("pending"), Type.Literal("written"), Type.Literal("failed")]), reason: Type.Optional(Type.String({ maxLength: 512 })) });
const Proposal = object({
  format: Type.Literal("spec-proposal/v1"), operationId: id, runId: id, requirementId: id, repoId: hash, workspaceId: hash,
  branch: Type.String({ minLength: 1 }), epoch: positive, fence: positive, approvedProdHash: hash, baseContractSetHash: hash, targetSpecSetHash: hash,
  analysisHash: Type.Union([hash, Type.Null()]),
  status: Type.Union([Type.Literal("proposed"), Type.Literal("validated"), Type.Literal("published"), Type.Literal("partial_failure"), Type.Literal("stale")]),
  publishedHead: Type.Union([Type.String({ minLength: 1 }), Type.Null()]), files: Type.Array(ProposalFile), createdAt: positive, updatedAt: positive,
});
export type SpecProposal = Static<typeof Proposal>;
export type SpecChangeErrorCode = "spec_change_denied" | "invalid_shape" | "forbidden_path" | "path_escape" | "stale_base" | "invalid_spec"
  | "operation_conflict" | "validation_required" | "check_phase_active" | "evidence_required" | "prod_changed" | "not_found" | "resource_limit";
export class SpecChangeError extends Error {
  readonly code: SpecChangeErrorCode;
  constructor(code: SpecChangeErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code); this.name = "SpecChangeError"; this.code = code;
  }
}
export interface SpecChangeAuthorization { readonly grant: Readonly<SpecChangeGrant>; readonly action: SpecChangeAction }
export interface SpecPublishGateRequest {
  readonly grant: Readonly<SpecChangeGrant>;
  readonly proposal: Readonly<{ operationId: string; targetSpecSetHash: string; approvedProdHash: string }>;
}
export interface SpecPublishEvidence {
  readonly verificationId: string;
  readonly status: "passed" | "failed" | "unknown";
  readonly targetSpecSetHash: string;
  readonly approvedProdHash: string;
  readonly codeHead: string;
}
export interface SpecPublishGate { readonly checkPhaseReleased: boolean; readonly evidence: SpecPublishEvidence | null }
export interface SpecChangeToolOptions {
  repositoryRoot: string;
  dataRoot: string;
  grant: SpecChangeGrant;
  /** 必须由宿主核验当前物理角色会话/调用者及动作许可；不能从工具参数或角色文本构造true。 */
  authorize: (request: Readonly<SpecChangeAuthorization>) => boolean;
  /** 检查阶段令牌与正式检查证据只能由可信服务提供；模型参数不能携带这些字段。 */
  publishGate: (request: Readonly<SpecPublishGateRequest>) => SpecPublishGate;
}

function sha256(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function specCheck(sources: SpecSource[], stage: string) {
  try { return checkSpecSet(sources); }
  catch (error) { throw new SpecChangeError("invalid_spec", `${stage}:${error instanceof SpecFormatError ? error.code : "unknown"}`); }
}

export async function createSpecChangeTool(options: SpecChangeToolOptions) {
  try { return await openSpecChangeTool(options); }
  catch { throw new SpecChangeError("spec_change_denied"); }
}

async function openSpecChangeTool(options: SpecChangeToolOptions) {
  const grant = freeze(checked(Grant, structuredClone(options.grant)));
  const deny: () => never = () => { throw new SpecChangeError("spec_change_denied"); };
  if (grant.lease.requirementId !== grant.requirementId || grant.lease.workspaceId !== grant.workspaceId || grant.lease.runId !== grant.runId) deny();
  let disposed = false;
  function host(action: SpecChangeAction) {
    if (disposed || !authorizeToolAction(grant.role, "spec_change", action)) deny();
    let result: unknown;
    try { result = options.authorize(freeze({ grant, action })); } catch { return deny(); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) deny();
  }
  host("validate");
  const config = { repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, repoId: grant.repoId };
  const state = await RequirementStateStore.open({ ...config, authorize: (request) => !disposed && request.repoId === grant.repoId &&
    ["open", "read", "check-pm"].includes(request.action) && (request.input.requirementId === undefined || request.input.requirementId === grant.requirementId) });
  const database = repositoryDatabase(options.dataRoot, grant.repoId);

  function activeRecord(): RequirementRecord & { workspace: NonNullable<RequirementRecord["workspace"]>; approved: NonNullable<RequirementRecord["approved"]> } {
    const data = state.read(grant.requirementId).data;
    const workspace = data.workspace, approved = data.approved;
    const owner = state.pmOwner(grant.requirementId), lease = owner?.lease;
    if (data.lifecycle !== "active" || data.recovery !== "ready" || !approved || !workspace || data.epoch !== grant.lease.epoch ||
      workspace.repoId !== grant.repoId || workspace.workspaceId !== grant.workspaceId || workspace.branch !== grant.branch ||
      workspace.requirementId !== grant.requirementId || !lease || owner!.fence !== grant.lease.fence || lease.fence !== grant.lease.fence ||
      lease.runId !== grant.runId || lease.epoch !== grant.lease.epoch || lease.expiresAt <= Date.now()) deny();
    return { ...data, workspace, approved };
  }
  async function bind(action: SpecChangeAction) {
    host(action);
    const record = activeRecord();
    await verifyRequirementWorkspace(options.dataRoot, record.workspace);
    await state.checkPm(grant.lease);
    host(action);
    return { record: activeRecord(), root: await realpath(record.workspace.path) };
  }
  async function currentSources(root: string): Promise<SpecSource[]> {
    const directory = join(root, ...SPEC_DIRECTORY.split("/"));
    let names: string[];
    try { names = (await readdir(directory, { recursive: true })) as string[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const sources: SpecSource[] = [];
    for (const name of names.map((entry) => entry.split(sep).join("/")).sort()) {
      if (!name.endsWith(".rules.json")) continue;
      const absolute = join(directory, ...name.split("/"));
      if (!(await lstat(absolute)).isFile()) continue;
      if (sources.length >= MAX_SPEC_FILES) throw new SpecChangeError("resource_limit", "当前规则文件数超限");
      sources.push({ path: posix.join(SPEC_DIRECTORY, name), content: await readFile(absolute, "utf8") });
    }
    return sources;
  }
  async function locate(root: string, path: string): Promise<string> {
    if (!writePathAllowed("spec_change", path)) throw new SpecChangeError("forbidden_path", path);
    const normalized = posix.normalize(path);
    let real: string;
    try { real = await resolveRealRepoPath(root, join(root, ...normalized.split("/")), false); }
    catch { throw new SpecChangeError("path_escape", path); }
    if (real !== normalized) throw new SpecChangeError("path_escape", path);
    return normalized;
  }
  function overlay(current: SpecSource[], files: ReadonlyArray<{ path: string; content: string | null }>): SpecSource[] {
    const map = new Map(current.map((source) => [source.path, source.content]));
    for (const file of files) { if (file.content === null) map.delete(file.path); else map.set(file.path, file.content); }
    return [...map.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, content]) => ({ path, content }));
  }
  function readProposal(operationId: string) {
    return withDatabase(database, (db) => {
      const row = db.read<unknown>(SPEC_PROPOSALS, operationId);
      return row ? { version: row.version, data: checked(Proposal, row.data) } : null;
    });
  }
  function own(proposal: SpecProposal) {
    return proposal.runId === grant.runId && proposal.requirementId === grant.requirementId && proposal.repoId === grant.repoId &&
      proposal.workspaceId === grant.workspaceId && proposal.branch === grant.branch && proposal.epoch === grant.lease.epoch && proposal.fence === grant.lease.fence;
  }
  function save(version: number, data: SpecProposal): number {
    return withDatabase(database, (db) => db.transaction(() => db.update(SPEC_PROPOSALS, data.operationId, version, checked(Proposal, { ...data, updatedAt: Date.now() }))));
  }
  function summary(proposal: SpecProposal) {
    return freeze({ status: proposal.status, operationId: proposal.operationId, baseContractSetHash: proposal.baseContractSetHash,
      targetSpecSetHash: proposal.targetSpecSetHash, analysisHash: proposal.analysisHash, approvedProdHash: proposal.approvedProdHash,
      publishedHead: proposal.publishedHead, files: proposal.files.map(({ content: _content, ...file }) => file) });
  }
  async function loadOwn(operationId: string) {
    const proposal = readProposal(operationId);
    if (!proposal || !own(proposal.data)) throw new SpecChangeError("not_found");
    return proposal;
  }
  function currentnessOf(proposal: SpecProposal, current: SpecSource[], record: ReturnType<typeof activeRecord>) {
    const hashes = new Map(current.map((source) => [source.path, sha256(source.content)]));
    const stale = proposal.files.filter((file) => (hashes.get(file.path) ?? "absent") !== file.baseHash).map((file) => file.path);
    const base = specCheck(current, "current");
    if (stale.length > 0 || base.contractSetHash !== proposal.baseContractSetHash) return { code: "stale_base" as const, detail: stale.join(",") };
    if (record.approved.hash !== proposal.approvedProdHash) return { code: "prod_changed" as const, detail: "" };
    return null;
  }

  async function propose(params: Extract<SpecChangeParameters, { action: "propose" }>) {
    const { record, root } = await bind("propose");
    const seen = new Set<string>();
    const files: SpecProposal["files"] = [];
    for (const file of params.files) {
      const path = await locate(root, file.path);
      if (seen.has(path)) throw new SpecChangeError("invalid_shape", `重复路径 ${path}`);
      seen.add(path);
      files.push({ path, baseHash: file.baseHash, targetHash: file.content === null ? "absent" : sha256(file.content), content: file.content, status: "pending" });
    }
    const current = await currentSources(root);
    const hashes = new Map(current.map((source) => [source.path, sha256(source.content)]));
    const stale = files.filter((file) => (hashes.get(file.path) ?? "absent") !== file.baseHash).map((file) => file.path);
    if (stale.length > 0) throw new SpecChangeError("stale_base", stale.join(","));
    const base = specCheck(current, "current");
    const target = specCheck(overlay(current, files), "candidate");
    if (readProposal(params.operationId)) throw new SpecChangeError("operation_conflict");
    host("propose");
    const proposal = checked(Proposal, { format: "spec-proposal/v1", operationId: params.operationId, runId: grant.runId, requirementId: grant.requirementId,
      repoId: grant.repoId, workspaceId: grant.workspaceId, branch: grant.branch, epoch: grant.lease.epoch, fence: grant.lease.fence,
      approvedProdHash: record.approved.hash, baseContractSetHash: base.contractSetHash, targetSpecSetHash: target.contractSetHash, analysisHash: null,
      status: "proposed", publishedHead: null, files, createdAt: Date.now(), updatedAt: Date.now() });
    withDatabase(database, (db) => db.transaction(() => {
      if (db.read(SPEC_PROPOSALS, proposal.operationId)) throw new SpecChangeError("operation_conflict");
      db.create(SPEC_PROPOSALS, proposal.operationId, proposal);
    }));
    return freeze({ ...summary(proposal), conflictCandidates: target.semanticReview.conflictCandidates });
  }
  async function validate(params: Extract<SpecChangeParameters, { action: "validate" }>) {
    const { record, root } = await bind("validate");
    const { version, data: proposal } = await loadOwn(params.operationId);
    if (proposal.status === "published") return summary(proposal);
    if (proposal.status !== "proposed" && proposal.status !== "validated") throw new SpecChangeError("stale_base", proposal.status);
    const current = await currentSources(root);
    const lost = currentnessOf(proposal, current, record);
    if (lost) { save(version, { ...proposal, status: "stale" }); throw new SpecChangeError(lost.code, lost.detail); }
    const pending = overlay(current, proposal.files);
    if (specCheck(pending, "candidate").contractSetHash !== proposal.targetSpecSetHash) throw new SpecChangeError("operation_conflict");
    const head = (await snapshotBranchState({ repoRoot: root })).head;
    const analysis = analyzeSpecSets({ context: { workspaceId: grant.workspaceId, generation: head, asOf: new Date().toISOString() }, current, pending });
    host("validate");
    const updated: SpecProposal = { ...proposal, status: "validated", analysisHash: analysis.analysisHash };
    save(version, updated);
    return freeze({ ...summary(updated), pairs: analysis.pending!.pairs.map((pair) => ({ left: pair.left.id, right: pair.right.id, mechanical: pair.mechanical })),
      blockers: analysis.pending!.blockers });
  }
  async function publish(params: Extract<SpecChangeParameters, { action: "publish" }>) {
    const { record, root } = await bind("publish");
    let { version, data: proposal } = await loadOwn(params.operationId);
    if (proposal.status === "published") return summary(proposal);
    if (proposal.status === "proposed") throw new SpecChangeError("validation_required");
    if (proposal.status !== "validated" && proposal.status !== "partial_failure") throw new SpecChangeError("stale_base", proposal.status);
    const current = await currentSources(root);
    if (proposal.status === "validated") {
      const lost = currentnessOf(proposal, current, record);
      if (lost) { save(version, { ...proposal, status: "stale" }); throw new SpecChangeError(lost.code, lost.detail); }
    } else if (record.approved.hash !== proposal.approvedProdHash) throw new SpecChangeError("prod_changed");
    const head = (await snapshotBranchState({ repoRoot: root })).head;
    let gate: SpecPublishGate;
    try { gate = options.publishGate(freeze({ grant, proposal: { operationId: proposal.operationId, targetSpecSetHash: proposal.targetSpecSetHash, approvedProdHash: proposal.approvedProdHash } })); }
    catch { return deny(); }
    if (gate.checkPhaseReleased !== true) throw new SpecChangeError("check_phase_active");
    const evidence = gate.evidence;
    if (!evidence || evidence.status !== "passed" || evidence.targetSpecSetHash !== proposal.targetSpecSetHash ||
      evidence.approvedProdHash !== proposal.approvedProdHash || evidence.codeHead !== head) throw new SpecChangeError("evidence_required");
    host("publish");
    proposal = structuredClone(proposal);
    const hashes = new Map(current.map((source) => [source.path, sha256(source.content)]));
    for (const file of proposal.files) {
      if (file.status === "written") continue;
      const absolute = join(root, ...file.path.split("/"));
      const currentHash = hashes.get(file.path) ?? "absent";
      if (currentHash === file.targetHash) { file.status = "written"; delete file.reason; version = save(version, proposal); continue; }
      if (currentHash !== file.baseHash) { proposal.status = "stale"; save(version, proposal); throw new SpecChangeError("stale_base", file.path); }
      try {
        if (file.content === null) await rm(absolute, { force: true });
        else { await mkdir(dirname(absolute), { recursive: true }); await writeFileAtomic(absolute, file.content); }
        const written = file.content === null ? "absent" : sha256(await readFile(absolute, "utf8"));
        if (written !== file.targetHash) throw new Error("写入后指纹不符");
      } catch (error) {
        file.status = "failed"; file.reason = (error instanceof Error ? error.message : String(error)).slice(0, 512); proposal.status = "partial_failure";
        save(version, proposal);
        return summary(proposal);
      }
      file.status = "written"; delete file.reason;
      version = save(version, proposal);
    }
    const published = specCheck(await currentSources(root), "published");
    if (published.contractSetHash !== proposal.targetSpecSetHash) { proposal.status = "partial_failure"; save(version, proposal); throw new SpecChangeError("stale_base", "发布后集合指纹不符"); }
    proposal.status = "published"; proposal.publishedHead = head;
    save(version, proposal);
    host("publish"); activeRecord();
    return summary(proposal);
  }

  async function execute(input: unknown) {
    if (Buffer.byteLength(JSON.stringify(input ?? null)) > 4 * 1024 * 1024) throw new SpecChangeError("resource_limit");
    let params: SpecChangeParameters;
    try { params = checkServiceInput(SPEC_CHANGE_PARAMETERS, input); } catch { throw new SpecChangeError("invalid_shape"); }
    host(params.action);
    switch (params.action) {
      case "propose": return propose(params);
      case "validate": return validate(params);
      case "publish": return publish(params);
    }
  }
  return { execute, dispose() { disposed = true; } };
}
