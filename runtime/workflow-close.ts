import { createHash } from "node:crypto";
import { adviceOf, COMMON_ADVICE, withDetail } from "./tool-failure.ts";
import type { FailureAdvice } from "./tool-failure.ts";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPromise } from "node:util/types";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { activeCheckRoundIn, assertWritersQuiescentIn, CheckRound, CheckRoundError, collectInputManifest, formalEvidence, manifestMatchesBaseline, VerificationRun, CHECK_ROUNDS, VERIFICATION_RUNS } from "./check-round.ts";
import { repositoryDatabase, uuidv7, withDatabase } from "./database.ts";
import type { LocalDatabase } from "./database.ts";
import { readVersion } from "./prod-storage.ts";
import { sectionEndByte } from "./prod-view.ts";
import { recordSectionIds } from "./requirement-doc.ts";
import { checked, counter, hash, id, object, positive, requirementStateWhy } from "./requirement-contracts.ts";
import type { RequirementRecord } from "./requirement-contracts.ts";
import { RequirementServiceError } from "./requirement-manage-contracts.ts";
import { RequirementOperations } from "./requirement-operations.ts";
import { RequirementStateStore } from "./requirement-state.ts";
import { RequirementStateError } from "./requirement-contracts.ts";
import { verifyRequirementWorkspace } from "./requirement-workspace.ts";
import { isTerminalState } from "./run-store.ts";
import type { RunRecord } from "./run-store.ts";
import { resolveRealRepoPath } from "./write-guard.ts";
import { writeFileAtomic } from "./store.ts";
import { readVerdictsIn } from "./verdicts.ts";
import { registeredApprovalManifestIn } from "./approval-manifest-store.ts";
import { implementScope, readPlanIn, terminationPending } from "./plan-manage.ts";
import type { TaskRecord, TaskStatus } from "./plan-manage.ts";
import { endRequirementExploreSessionsIn } from "./explore-session.ts";
import { readGit } from "./git-read.ts";
import { prototypeArchivePathFor } from "./requirement-identity.ts";
import { prototypeFilePath } from "./requirement-prototypes.ts";
import { prototypesAtRevision } from "./requirement-prototype-revisions.ts";

export const CLOSE_OPERATIONS = "close_operations";
export const DELIVERY_RECEIPTS = "delivery_receipts";
export const COMPLETION_REPORTS = "completion_reports";
const CHANGE_SETS = "change_sets";
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const CloseReason = Type.Union([Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("rejected")]);
export type CloseReason = Static<typeof CloseReason>;
const Basis = object({
  version: positive, epoch: positive, revision: counter, approvedHash: nullable(hash), checkRoundId: nullable(id),
  verificationIds: Type.Array(id), verdictIds: Type.Array(id), digest: hash,
});
export type CloseBasis = Static<typeof Basis>;
const Archive = object({ path: Type.String({ minLength: 1, maxLength: 1024 }), prodHash: hash, commit: Type.String({ minLength: 1 }),
  records: object({ implementation: Type.String({ minLength: 1 }), acceptance: Type.String({ minLength: 1 }) }), archiveHash: nullable(hash),
  prototypes: Type.Array(object({ path: Type.String({ minLength: 1, maxLength: 512 }), name: Type.String({ minLength: 1, maxLength: 40 }), version: positive, hash }), { maxItems: 50 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("archived"), Type.Literal("blocked")]), attempts: counter, lastError: nullable(Type.String({ maxLength: 1024 })) });
export const CloseOperation = object({
  format: Type.Literal("close-operation/v1"), requirementId: id, repoId: hash, operationId: id, receiptId: id, reason: CloseReason, basis: Basis,
  status: Type.Union([Type.Literal("closing"), Type.Literal("closed")]),
  steps: object({ agentsStopped: Type.Boolean(), closed: Type.Boolean() }),
  archive: nullable(Archive), createdAt: counter, updatedAt: counter,
});
export type CloseOperation = Static<typeof CloseOperation>;
export const DeliveryReceipt = object({
  format: Type.Literal("delivery-receipt/v1"), receiptId: id, requirementId: id, repoId: hash, workspaceId: hash, branch: Type.String({ minLength: 1 }), epoch: positive,
  revision: counter, approvedProdHash: nullable(hash), codeHead: Type.String({ minLength: 1 }), inputHash: hash,
  checkRoundId: nullable(id), verificationIds: Type.Array(id), verdictIds: Type.Array(id), pendingRevision: nullable(positive),
  deliverable: Type.Boolean(), blockers: Type.Array(Type.String({ maxLength: 256 })), suggestions: counter, createdAt: counter,
});
export type DeliveryReceipt = Static<typeof DeliveryReceipt>;
export const REPORT_COMMIT_LIMIT = 50;
export const CompletionReport = object({
  format: Type.Literal("completion-report/v1"), reportId: id, requirementId: id, repoId: hash, pmRunId: id, deliveryReceiptId: id, basis: Basis,
  commits: Type.Array(object({ sha: Type.String({ pattern: "^[0-9a-f]{40,64}$" }), subject: Type.String({ maxLength: 512 }) }), { maxItems: REPORT_COMMIT_LIMIT }),
  commitsTruncated: Type.Boolean(), note: Type.String({ minLength: 1, maxLength: 4000 }),
  status: Type.Union([Type.Literal("pending"), Type.Literal("superseded"), Type.Literal("accepted"), Type.Literal("rework")]),
  decisionId: nullable(id), notified: Type.Boolean(), createdAt: counter, decidedAt: nullable(counter),
});
export type CompletionReport = Static<typeof CompletionReport>;

export type CloseAction = "preflight" | "close" | "archive" | "delivery-check" | "status" | "report";
export interface CloseAuthorization { readonly action: CloseAction; readonly requirementId: string; readonly reason?: CloseReason; readonly receiptId?: string; readonly operationId?: string }
export interface RequirementCloseServiceOptions {
  repositoryRoot: string;
  dataRoot: string;
  repoId: string;
  /** 关闭授权回执须由宿主对照真实用户交互核验；模型参数不能构造 true。 */
  authorize: (request: Readonly<CloseAuthorization>) => boolean;
  /** 结束本需求 PM 与子代理会话；只由宿主提供，结束与否以运行记录为准。 */
  stopAgents?: (requirementId: string) => Promise<void>;
  now?: () => number;
}
const CLOSE_ADVICE = {
  tool_closed: COMMON_ADVICE.tool_closed,
  not_authorized: { why: "宿主没有授权这次关闭相关操作", next: "停止操作，不要重试；在回复里说明，由上级处理" },
  invalid_shape: COMMON_ADVICE.invalid_shape,
  not_found: { why: "找不到对应的关闭记录或待验收报告", next: "用 status 查看需求当前的关闭与报告状态" },
  not_closed: { why: "需求还没有以完成关闭，不能归档", next: "先以完成关闭需求，再归档" },
  archive_conflict: { why: "归档位置已有内容不同的文件", next: "请用户检查归档目录里的同名文件，处理后以原决定编号再次 close 续办" },
  archive_prototype_mismatch: { why: "原型源文件内容与批准时登记的指纹不符", next: "请用户检查原型文件有没有被手动改动，处理后以原决定编号再次 close 续办" },
  archive_unavailable: { why: "这个需求没有归档资格或归档内容不可用", next: "只有以完成关闭的需求才会归档；其他情况不需要归档" },
} as const satisfies Record<string, FailureAdvice>;
export type CloseErrorCode = keyof typeof CLOSE_ADVICE;
export class CloseError extends Error {
  readonly code: CloseErrorCode;
  readonly advice: FailureAdvice;
  constructor(code: CloseErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code); this.name = "CloseError"; this.code = code; this.advice = withDetail(CLOSE_ADVICE[code], detail);
  }
}

const CLOSE_ITEM_TEXT: Record<string, string> = {
  requirement_not_active: "需求不在活动状态，或缺少批准版本、工作区",
  pending_update: "有新批准的需求版本还没复核",
  formal_check_missing: "还没有做过正式检查轮",
  check_round_not_released: "检查轮还没结束，或还有检查在运行",
  check_round_input_changed: "检查轮开始后受保护的输入已变化，检查轮已失效",
  check_round_prod_mismatch: "检查轮依据的批准版本不是当前版本",
  formal_pass_missing: "检查轮里没有通过的正式检查",
  verification_running: "还有检查在运行",
  qa_verdict_missing: "还没有 QA 裁决",
  qa_blocking_findings: "QA 发现了阻塞问题",
  qa_unverified_findings: "QA 还有未验证的项",
  task_review_missing: "有任务还没经过审查",
  terminated_goal_in_scope: "被用户终止的任务，其目标仍在实施范围内",
  check_phase_active: "检查阶段还没结束",
  workers_active: "还有 worker 或 reviewer 运行未结束",
  writes_pending: "还有未完成的代码写入",
  writers_active: "还有子代理或代码写入在进行",
  basis_changed: "核对期间交付依据发生了变化",
  workspace_unavailable: "读不到需求工作区",
  delivery_content_mismatch: "工作区内容与正式检查时不一致",
  formal_evidence_not_applicable: "正式检查结果不适用于当前内容",
  role_agents_running: "还有子代理在运行",
  rework_not_addressed: "用户要求返工后交付依据没有变化",
  completion_report_not_accepted: "用户还没有验收通过完成报告",
  agents_running: "还有运行没停止",
  pm_lease_active: "PM 仍持有租约",
};
/** 关闭、交付核对与完成报告里的缺项说明；授权问题带上具体原因。 */
export function closeItemText(code: string, authorization?: string): string {
  if (code === "close_authorization_invalid") return `关闭依据的用户决定无效${authorization ? `：${authorization}` : ""}`;
  return CLOSE_ITEM_TEXT[code] ?? requirementStateWhy(code) ?? `未归类的阻塞项（${code}）`;
}
export const COMPLETION_MESSAGE = (requirementId: string) => `需求 ${requirementId} 已完成，PM 及相关子代理已结束。建议清空上下文后再开始新的需求，避免旧需求影响后续判断。`;
export const TERMINATION_MESSAGE = (requirementId: string, reason: "cancelled" | "rejected") =>
  `需求 ${requirementId} 已按 ${reason === "cancelled" ? "取消" : "拒绝"} 关闭，PM 及相关子代理已结束。建议清空上下文后再开始新的需求。`;

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function requirementIn(db: LocalDatabase, repoId: string, requirementId: string) {
  const row = db.read<RequirementRecord>("requirements", requirementId);
  if (!row || row.data.repoId !== repoId) throw new CloseError("not_found");
  return row;
}
function activeRunsIn(db: LocalDatabase, requirementId: string, kind?: RunRecord["kind"]): RunRecord[] {
  return db.list<RunRecord>("runs").map((row) => row.data)
    .filter((run) => run && run.requirement === requirementId && (kind === undefined || run.kind === kind) && !isTerminalState(run.state));
}
function runningVerificationsIn(db: LocalDatabase, repoId: string, requirementId: string): VerificationRun[] {
  return db.list<unknown>(VERIFICATION_RUNS).map((row) => checked(VerificationRun, row.data))
    .filter((run) => run.repoId === repoId && run.requirementId === requirementId && run.status === "running" && run.pid !== null && processIsAlive(run.pid));
}
function latestRoundIn(db: LocalDatabase, repoId: string, requirementId: string, epoch: number): CheckRound | null {
  const rounds = db.list<unknown>(CHECK_ROUNDS).map((row) => checked(CheckRound, row.data))
    .filter((round) => round.repoId === repoId && round.requirementId === requirementId && round.epoch === epoch).sort((a, b) => a.createdAt - b.createdAt);
  return rounds.at(-1) ?? null;
}
interface DeliveryFacts {
  record: { version: number; data: RequirementRecord }; round: CheckRound | null; verifications: VerificationRun[]; verdicts: ReturnType<typeof readVerdictsIn>;
  blockers: string[]; suggestions: number; writes: Array<[string, string, number]>;
}
/** 同步数据库依据：最新检查轮、其正式结果、独立裁决、待处理更新、未发布候选与未收尾写入。 */
function deliveryFactsIn(db: LocalDatabase, repoId: string, requirementId: string): DeliveryFacts {
  const record = requirementIn(db, repoId, requirementId);
  const blockers: string[] = [];
  if (record.data.lifecycle !== "active" || record.data.recovery !== "ready" || !record.data.approved || !record.data.workspace) blockers.push("requirement_not_active");
  if (record.data.pendingRevision !== null) blockers.push("pending_update");
  const round = latestRoundIn(db, repoId, requirementId, record.data.epoch);
  const verifications = round ? round.verifications.map((verificationId) => db.read<unknown>(VERIFICATION_RUNS, verificationId)?.data).filter((run) => run !== undefined).map((run) => checked(VerificationRun, run)) : [];
  const verdicts = round ? readVerdictsIn(db, repoId, requirementId).filter((verdict) => verdict.checkRoundId === round.checkRoundId && verdict.epoch === record.data.epoch) : [];
  if (!round) blockers.push("formal_check_missing");
  else {
    if (round.status !== "released" || round.active.length > 0) blockers.push("check_round_not_released");
    if (round.invalidation) blockers.push(`check_round_${round.invalidation.reason}`);
    if (round.baseline.revision !== record.data.revision || round.baseline.approved.hash !== record.data.approved?.hash) blockers.push("check_round_prod_mismatch");
    if (!verifications.some((run) => run.status === "passed")) blockers.push("formal_pass_missing");
    if (verifications.some((run) => run.status === "running")) blockers.push("verification_running");
    const qa = verdicts.filter((verdict) => verdict.role === "qa");
    if (qa.length === 0) blockers.push("qa_verdict_missing");
    else if (qa.some((verdict) => verdict.conclusion === "blocked")) blockers.push("qa_blocking_findings");
    else if (qa.some((verdict) => verdict.conclusion === "unverified")) blockers.push("qa_unverified_findings");
  }
  const reviews = taskReviewsIn(db, repoId, requirementId, record.data.epoch);
  if (reviews === null) blockers.push("task_review_missing");
  // 用户终止任务后、批准新的 prod 版本前，其目标仍在实施授权内时需求不能以完成关闭
  if (record.data.lifecycle === "active") {
    const scope = implementScope(registeredApprovalManifestIn(db, repoId, record.data.approvalManifest!.reference, record), record.data.docSpec?.sections ?? []);
    const terminated = readPlanIn(db, requirementId)?.tasks.filter((task) => terminationPending([task], record.data.revision)) ?? [];
    if (terminated.some((task) => task.goalUnitIds.some((unit) => scope.has(unit)))) blockers.push("terminated_goal_in_scope");
  }
  if (activeCheckRoundIn(db, repoId, requirementId)) blockers.push("check_phase_active");
  try { assertWritersQuiescentIn(db, repoId, requirementId); }
  catch (error) { blockers.push(error instanceof CheckRoundError ? error.code : error instanceof RequirementServiceError ? error.code : "writers_active"); }
  const evidence = [...verdicts, ...(reviews ?? [])];
  const suggestions = evidence.reduce((total, verdict) => total + verdict.findings.filter((finding) => finding.kind === "suggestion").length, 0);
  return { record, round, verifications, verdicts: evidence, blockers: [...new Set(blockers)], suggestions, writes: managedWritesIn(db, repoId, requirementId) };
}
/** 每个未取消的 worker 任务都须已完成，且有绑定其最后一次完成尝试、无阻塞无未验证项的任务级审查；缺任一项返回 null。 */
function taskReviewsIn(db: LocalDatabase, repoId: string, requirementId: string, epoch: number): ReturnType<typeof readVerdictsIn> | null {
  const workers = (readPlanIn(db, requirementId)?.tasks ?? []).filter((task) => task.role === "worker" && task.status !== "cancelled");
  const verdicts = readVerdictsIn(db, repoId, requirementId).filter((verdict) => verdict.role === "reviewer" && verdict.epoch === epoch && verdict.conclusion === "clear");
  const found: ReturnType<typeof readVerdictsIn> = [];
  for (const task of workers) {
    const attempt = task.attempts.findLast((candidate) => candidate.outcome === "completed");
    const review = attempt && verdicts.find((verdict) => verdict.review?.taskId === task.taskId && verdict.review.attemptRunId === attempt.runId);
    if (task.status !== "completed" || !review) return null;
    found.push(review);
  }
  return found;
}
function managedWritesIn(db: LocalDatabase, repoId: string, requirementId: string): Array<[string, string, number]> {
  return db.list<{ repoId?: string; requirementId?: string; status?: string; operationId?: string }>(CHANGE_SETS)
    .filter((row) => row.data.repoId === repoId && row.data.requirementId === requirementId)
    .map((row): [string, string, number] => [`${CHANGE_SETS}:${row.data.operationId ?? row.key}`, row.data.status ?? "", row.version]).sort();
}
const RUN_STATUS: Record<VerificationRun["status"], string> = { running: "运行中", passed: "通过", failed: "失败", timeout: "超时", cancelled: "已取消",
  not_run: "未运行", interrupted: "中断", invalidated: "作废" };
const CONCLUSION = { clear: "无阻塞、无未验证项", blocked: "有阻塞问题", unverified: "有未验证项" } as const;
const FINDING_KIND = { blocking: "阻塞", suggestion: "建议", unverified: "未验证" } as const;
const inlineCode = (text: string) => {
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  const flat = text.replace(/\s+/g, " "), pad = /^`|`$/.test(flat) ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
};
const quoted = (text: string) => text.split(/\r\n|\r|\n/).map((line) => `> ${line}`).join("\n");

/** 插在验收板块末尾的验收记录：只取最新检查轮的程序记录；模型撰写的文字一律进引用块，不能伪造程序生成的行。 */
function acceptanceRecord(facts: DeliveryFacts): string {
  const round = facts.round!;
  const lines = ["### 验收记录（关闭时由程序生成）", "", `- 检查轮：${round.checkRoundId}`, `- 代码提交：${round.baseline.codeHead}`,
    `- 批准版正文 hash：sha256:${round.baseline.approved.hash}`, "", "#### 正式测试", ""];
  for (const run of facts.verifications) {
    const elapsed = run.finishedAt === null ? null : run.finishedAt - run.startedAt;
    const seconds = elapsed === null ? "未结束" : elapsed < 1000 ? `${elapsed} 毫秒` : `${(elapsed / 1000).toFixed(1)} 秒`;
    const performance = run.performance.applicable ? "性能阈值（模型撰写）：" : `性能：不适用（模型撰写的理由：${run.performance.reason.replace(/\s+/g, " ")}）`;
    lines.push(`- 命令（模型撰写）：${inlineCode(run.command)}`, `  - 结果：${RUN_STATUS[run.status]}；退出码：${run.exitCode ?? "无"}；用时：${seconds}；开始：${new Date(run.startedAt).toISOString()}`,
      `  - ${performance}`);
    if (run.performance.applicable) lines.push(quoted(run.performance.thresholds).replace(/^/gm, "    "));
  }
  const qa = facts.verdicts.filter((verdict) => verdict.role === "qa");
  lines.push("", "#### QA 验收", "");
  for (const verdict of qa) {
    lines.push(`- QA 结论：${CONCLUSION[verdict.conclusion]}（${new Date(verdict.createdAt).toISOString()}）`, "", "QA 说明（模型撰写，仅供参考）：", "", quoted(verdict.summary), "",
      verdict.findings.length ? "QA 列出的问题（模型撰写）：" : "QA 列出的问题：无", "");
    for (const finding of verdict.findings) {
      lines.push(quoted(`[${FINDING_KIND[finding.kind]}] ${finding.targetRef}：${finding.trigger}；影响：${finding.impact}${finding.evidenceRef ? `；证据：${finding.evidenceRef}` : ""}`), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
const TASK_STATUS: Record<TaskStatus, string> = { pending: "待派出", running: "执行中", completed: "完成", failed: "失败", needs_update: "待更新", blocked: "受阻",
  cancelled: "已取消", awaiting_parent: "等待 PM 处置", awaiting_user: "等待用户裁决", awaiting_review: "待审查", reviewing: "审查中", awaiting_rework: "待返修" };

/** 插在实现板块末尾的实现记录：worker 任务取计划登记值，说明取用户验收通过的完成报告，PM 说明是模型文字，进引用块；不列提交号，交付时的 rebase 与 squash 会改掉它们，改写需求编号查法。 */
function implementationRecord(requirementId: string, tasks: readonly TaskRecord[], report: CompletionReport): string {
  const lines = ["### 实现记录（关闭时由程序生成）", "", "#### worker 任务", "", "任务名与可写范围是 PM 在计划中登记的值。", ""];
  const workers = tasks.filter((task) => task.role === "worker");
  if (!workers.length) lines.push("- 无");
  for (const task of workers) {
    lines.push(`- 任务 ${task.key}：${TASK_STATUS[task.status]}；需求章节：${task.goalUnitIds.join("、")}${task.constraintUnitIds.length ? `；约束章节：${task.constraintUnitIds.join("、")}` : ""}；` +
      `可写范围：${task.writePaths.length ? task.writePaths.map(inlineCode).join("、") : "无"}`);
  }
  lines.push("", "#### 提交", "", `在主分支运行 ${inlineCode(`git log --grep ${requirementId}`)} 可列出本需求的提交。`);
  lines.push("", "#### PM 说明（模型撰写，仅供参考）", "", quoted(report.note));
  return `${lines.join("\n").trimEnd()}\n`;
}
/** 批准版正文每个字节原样保留，只在规范快照标出的两个板块末尾各插入一段程序记录，前后补足空行；板块缺失返回 null。 */
function archiveBytes(prod: Uint8Array, records: { implementation: string; acceptance: string }, sectionIds: { implementation: string; acceptance: string }): Buffer | null {
  const bytes = Buffer.from(prod), text = bytes.toString("utf8");
  const inserts = (["implementation", "acceptance"] as const).map((kind) => ({ at: sectionEndByte(text, sectionIds[kind]), record: records[kind] }));
  if (inserts.some((insert) => insert.at === null)) return null;
  inserts.sort((a, b) => a.at! - b.at!);
  const parts: Buffer[] = [];
  let from = 0;
  for (const [index, insert] of inserts.entries()) {
    const before = bytes.subarray(from, insert.at!), after = bytes.subarray(insert.at!, inserts[index + 1]?.at ?? bytes.length);
    const lead = before.subarray(-2).toString() === "\n\n" ? "" : before.at(-1) === 0x0a ? "\n" : "\n\n";
    parts.push(before, Buffer.from(`${lead}${insert.record}${after.length ? "\n" : ""}`));
    from = insert.at!;
  }
  return Buffer.concat([...parts, bytes.subarray(from)]);
}

function basisOf(facts: DeliveryFacts): CloseBasis {
  const verificationIds = facts.verifications.map((run) => run.verificationId).sort();
  const verdictIds = facts.verdicts.map((verdict) => verdict.verdictId).sort();
  const digest = sha256(JSON.stringify([facts.record.version, facts.record.data.epoch, facts.record.data.revision, facts.record.data.approved, facts.round?.checkRoundId ?? null,
    facts.round?.status ?? null, facts.round?.invalidation ?? null, facts.verifications.map((run) => [run.verificationId, run.status, run.baseline]),
    facts.verdicts.map((verdict) => [verdict.verdictId, verdict.conclusion]), facts.writes]));
  return { version: facts.record.version, epoch: facts.record.data.epoch, revision: facts.record.data.revision, approvedHash: facts.record.data.approved?.hash ?? null,
    checkRoundId: facts.round?.checkRoundId ?? null, verificationIds, verdictIds, digest };
}

/** 当前关闭依据；完成报告绑定它，依据变化即报告失效。 */
export function currentCloseBasisIn(db: LocalDatabase, repoId: string, requirementId: string): CloseBasis {
  return basisOf(deliveryFactsIn(db, repoId, requirementId));
}
export function reportsIn(db: LocalDatabase, repoId: string, requirementId: string): Array<{ version: number; data: CompletionReport }> {
  return db.list<unknown>(COMPLETION_REPORTS).map((row) => ({ version: row.version, data: checked(CompletionReport, row.data) }))
    .filter((row) => row.data.repoId === repoId && row.data.requirementId === requirementId).sort((a, b) => a.data.createdAt - b.data.createdAt);
}
/** 待用户验收的报告：最新一份仍为 pending 且绑定的依据仍是当前依据。 */
export function pendingReportIn(db: LocalDatabase, repoId: string, requirementId: string): { version: number; data: CompletionReport } | null {
  const latest = reportsIn(db, repoId, requirementId).at(-1);
  if (!latest || latest.data.status !== "pending") return null;
  return latest.data.basis.digest === currentCloseBasisIn(db, repoId, requirementId).digest ? latest : null;
}
export function acceptedReportIn(db: LocalDatabase, repoId: string, requirementId: string, decisionId: string): CompletionReport | null {
  return reportsIn(db, repoId, requirementId).find((row) => row.data.status === "accepted" && row.data.decisionId === decisionId)?.data ?? null;
}
/** 登记用户对待验收报告的决定；调用方须已核对事项版本与用户决定。 */
export function decideReportIn(db: LocalDatabase, reportId: string, decision: { decisionId: string; choice: "accept" | "rework"; now: number }): CompletionReport {
  const row = db.read<unknown>(COMPLETION_REPORTS, reportId);
  const current = row ? checked(CompletionReport, row.data) : null;
  if (!row || !current || current.status !== "pending") throw new CloseError("not_found", "报告不在待验收状态");
  const next = checked(CompletionReport, { ...current, status: decision.choice === "accept" ? "accepted" : "rework", decisionId: decision.decisionId, decidedAt: decision.now });
  db.update(COMPLETION_REPORTS, reportId, row.version, next);
  return next;
}

const PreflightInput = object({ requirementId: id, reason: CloseReason, receiptId: id });
const CloseInput = object({ requirementId: id, reason: CloseReason, receiptId: id, operationId: id });
export interface ClosePreflight { eligible: boolean; missing: string[]; basis: CloseBasis | null; authorization?: string }
export type CloseResult =
  | { status: "rejected"; missing: string[]; authorization?: string }
  | { status: "closing"; operationId: string; pending: string[] }
  | { status: "closed"; operationId: string; reason: CloseReason; archive: { path: string; status: string } | null; message: string };

/**
 * 关闭协议：资格预检不改状态 → 事务内再核对并原子进入 closing → 结束相关代理 → 登记 closed 并向调用方返回无正文的结果与清空上下文建议 → 受限归档。
 * 文件读取与代理停止在事务外执行；预检通过后任何依据变化都使本次关闭不生效。
 */
export class RequirementCloseService {
  private readonly options: RequirementCloseServiceOptions;
  private readonly database: string;
  private readonly state: RequirementStateStore;
  private readonly operations: RequirementOperations;
  private readonly life: { disposed: boolean };
  private constructor(options: RequirementCloseServiceOptions, state: RequirementStateStore, life: { disposed: boolean }) {
    this.options = options; this.state = state; this.life = life; this.database = repositoryDatabase(options.dataRoot, options.repoId);
    this.operations = new RequirementOperations({ dataRoot: options.dataRoot, repoId: options.repoId });
  }
  static async open(options: RequirementCloseServiceOptions): Promise<RequirementCloseService> {
    checked(hash, options.repoId);
    const life = { disposed: false };
    const state = await RequirementStateStore.open({ repositoryRoot: options.repositoryRoot, dataRoot: options.dataRoot, repoId: options.repoId,
      authorize: (request) => !life.disposed && request.repoId === options.repoId && ["open", "read", "begin-close", "finish-close"].includes(request.action) });
    return new RequirementCloseService(options, state, life);
  }
  dispose(): void { this.life.disposed = true; }
  private now(): number { return checked(counter, this.options.now?.() ?? Date.now()); }
  private authorize(request: CloseAuthorization): void {
    if (this.life.disposed) throw new CloseError("tool_closed");
    let result: unknown;
    try { result = this.options.authorize(freeze(structuredClone(request))); }
    catch (error) { if (adviceOf(error)) throw error; throw new CloseError("not_authorized", (error as Error).message); }
    if (isPromise(result)) void Promise.prototype.then.call(result, () => undefined, () => undefined);
    if (result !== true) throw new CloseError("not_authorized");
  }
  private operation(db: LocalDatabase, requirementId: string) {
    const row = db.read<unknown>(CLOSE_OPERATIONS, requirementId);
    return row ? { version: row.version, data: checked(CloseOperation, row.data) } : null;
  }
  private saveOperation(db: LocalDatabase, current: { version: number; data: CloseOperation } | null, data: CloseOperation): void {
    const next = checked(CloseOperation, { ...data, updatedAt: this.now() });
    if (current) db.update(CLOSE_OPERATIONS, data.requirementId, current.version, next);
    else db.create(CLOSE_OPERATIONS, data.requirementId, next);
  }

  /** 交付凭据：当前内容指纹、正式证据、独立裁决与阻塞项，全程无 prod 正文。 */
  async deliveryCheck(requirementId: string): Promise<DeliveryReceipt> {
    return (await this.deliveryCheckWithBasis(requirementId)).receipt;
  }
  /** 凭据、关闭依据与角色运行判断出自同一事务，关闭再核对比对的就是签发凭据时的依据。 */
  private async deliveryCheckWithBasis(requirementId: string): Promise<{ receipt: DeliveryReceipt; basis: CloseBasis; roleRunsActive: boolean }> {
    checked(id, requirementId);
    this.authorize({ action: "delivery-check", requirementId });
    const first = withDatabase(this.database, (db) => deliveryFactsIn(db, this.options.repoId, requirementId));
    const workspace = first.record.data.workspace;
    if (workspace) await verifyRequirementWorkspace(this.options.dataRoot, workspace);
    let manifest: Awaited<ReturnType<typeof collectInputManifest>> | null = null;
    if (workspace) { try { manifest = await collectInputManifest(workspace.path); } catch { manifest = null; } }
    const applicable: string[] = [];
    for (const run of first.verifications) {
      if (run.status !== "passed") continue;
      const evidence = await formalEvidence({ dataRoot: this.options.dataRoot, repoId: this.options.repoId }, run.verificationId);
      if (evidence?.applicable) applicable.push(run.verificationId);
    }
    this.authorize({ action: "delivery-check", requirementId });
    return withDatabase(this.database, (db) => db.transaction(() => {
      const facts = deliveryFactsIn(db, this.options.repoId, requirementId);
      const blockers = [...facts.blockers];
      if (basisOf(facts).digest !== basisOf(first).digest) blockers.push("basis_changed");
      if (!manifest) blockers.push("workspace_unavailable");
      else if (facts.round && !manifestMatchesBaseline(manifest, facts.round.baseline)) blockers.push("delivery_content_mismatch");
      if (facts.round && applicable.length === 0) blockers.push("formal_evidence_not_applicable");
      const receipt = checked(DeliveryReceipt, { format: "delivery-receipt/v1", receiptId: uuidv7(), requirementId, repoId: this.options.repoId,
        workspaceId: facts.record.data.workspace?.workspaceId ?? "0".repeat(64), branch: facts.record.data.workspace?.branch ?? "refs/heads/unbound", epoch: facts.record.data.epoch,
        revision: facts.record.data.revision, approvedProdHash: facts.record.data.approved?.hash ?? null, codeHead: manifest?.codeHead ?? "unknown",
        inputHash: manifest?.inputHash ?? "0".repeat(64), checkRoundId: facts.round?.checkRoundId ?? null,
        verificationIds: applicable, verdictIds: facts.verdicts.map((verdict) => verdict.verdictId), pendingRevision: facts.record.data.pendingRevision,
        deliverable: blockers.length === 0, blockers: [...new Set(blockers)], suggestions: facts.suggestions, createdAt: this.now() });
      db.create(DELIVERY_RECEIPTS, receipt.receiptId, receipt, receipt.receiptId);
      return { receipt: freeze(receipt), basis: basisOf(facts), roleRunsActive: activeRunsIn(db, requirementId, "role").length > 0 };
    }));
  }

  /**
   * PM 的完成报告：交付核对无阻塞且无执行中的子代理才受理；事实部分由程序取自交付凭据与需求分支提交，PM 的说明只作参考。
   * 用户要求返工后，关闭依据未变（没有新的审查、检查轮或改动）时不受理新报告。
   */
  async report(input: { requirementId: string; pmRunId: string; note: string }): Promise<{ status: "submitted"; reportId: string } | { status: "rejected"; missing: string[] }> {
    checked(id, input.requirementId); checked(id, input.pmRunId);
    this.authorize({ action: "report", requirementId: input.requirementId });
    const { receipt, basis, roleRunsActive } = await this.deliveryCheckWithBasis(input.requirementId);
    const missing = [...receipt.blockers];
    if (roleRunsActive) missing.push("role_agents_running");
    const previous = withDatabase(this.database, (db) => reportsIn(db, this.options.repoId, input.requirementId).at(-1)?.data);
    if (previous?.status === "rework" && previous.basis.digest === basis.digest) missing.push("rework_not_addressed");
    if (missing.length > 0) return freeze({ status: "rejected" as const, missing: [...new Set(missing)] });
    const workspace = withDatabase(this.database, (db) => requirementIn(db, this.options.repoId, input.requirementId)).data.workspace!;
    let log: string;
    try { log = (await readGit(workspace.path, ["log", "--no-color", "--format=%H%x09%s", "-n", String(REPORT_COMMIT_LIMIT + 1), `${workspace.baseCommit}..HEAD`])).stdout; }
    catch { return freeze({ status: "rejected" as const, missing: ["workspace_unavailable"] }); }
    const lines = log.split("\n").filter(Boolean);
    const commits = lines.slice(0, REPORT_COMMIT_LIMIT).map((line) => { const tab = line.indexOf("\t"); return { sha: line.slice(0, tab), subject: line.slice(tab + 1).slice(0, 512) }; });
    this.authorize({ action: "report", requirementId: input.requirementId });
    return withDatabase(this.database, (db) => db.transaction(() => {
      if (currentCloseBasisIn(db, this.options.repoId, input.requirementId).digest !== basis.digest) return freeze({ status: "rejected" as const, missing: ["basis_changed"] });
      for (const row of reportsIn(db, this.options.repoId, input.requirementId)) {
        if (row.data.status === "pending") db.update(COMPLETION_REPORTS, row.data.reportId, row.version, checked(CompletionReport, { ...row.data, status: "superseded" }));
      }
      const report = checked(CompletionReport, { format: "completion-report/v1", reportId: uuidv7(), requirementId: input.requirementId, repoId: this.options.repoId,
        pmRunId: input.pmRunId, deliveryReceiptId: receipt.receiptId, basis, commits, commitsTruncated: lines.length > REPORT_COMMIT_LIMIT, note: input.note,
        status: "pending", decisionId: null, notified: false, createdAt: this.now(), decidedAt: null });
      db.create(COMPLETION_REPORTS, report.reportId, report, report.reportId);
      return freeze({ status: "submitted" as const, reportId: report.reportId });
    }));
  }

  /** 资格预检只报告缺项，不改状态、不提升 epoch、不撤权。 */
  async preflight(input: Static<typeof PreflightInput>): Promise<ClosePreflight> {
    let request: Static<typeof PreflightInput>;
    try { request = checked(PreflightInput, input); } catch (error) { throw new CloseError("invalid_shape", (error as Error).message); }
    const missing: string[] = [];
    let authorized = true, authorization: string | undefined;
    try { this.authorize({ action: "close", requirementId: request.requirementId, reason: request.reason, receiptId: request.receiptId }); }
    catch (error) { authorized = false; authorization = adviceOf(error)?.why ?? (error as Error).message; missing.push("close_authorization_invalid"); }
    const record = withDatabase(this.database, (db) => requirementIn(db, this.options.repoId, request.requirementId));
    if (record.data.close) {
      if (record.data.close.receiptId !== request.receiptId || record.data.close.reason !== request.reason) missing.push("close_intent_conflict");
      return { eligible: authorized && missing.length === 0, missing, basis: null, ...(authorization ? { authorization } : {}) };
    }
    if (record.data.recovery !== "ready") missing.push("recovery_required");
    if (record.data.lifecycle !== "active" && !(record.data.lifecycle === "draft" && request.reason !== "completed")) missing.push("lifecycle_denied");
    if (request.reason !== "completed") {
      const facts = withDatabase(this.database, (db) => deliveryFactsIn(db, this.options.repoId, request.requirementId));
      return { eligible: missing.length === 0, missing, basis: basisOf(facts), ...(authorization ? { authorization } : {}) };
    }
    const { receipt, basis, roleRunsActive } = await this.deliveryCheckWithBasis(request.requirementId);
    missing.push(...receipt.blockers);
    if (roleRunsActive) missing.push("role_agents_running");
    const accepted = withDatabase(this.database, (db) => acceptedReportIn(db, this.options.repoId, request.requirementId, request.receiptId));
    if (!accepted) missing.push("completion_report_not_accepted");
    else if (accepted.basis.digest !== basis.digest) missing.push("completion_report_stale");
    return { eligible: missing.length === 0, missing: [...new Set(missing)], basis, ...(authorization ? { authorization } : {}) };
  }

  async close(input: Static<typeof CloseInput>): Promise<CloseResult> {
    let request: Static<typeof CloseInput>;
    try { request = checked(CloseInput, input); } catch (error) { throw new CloseError("invalid_shape", (error as Error).message); }
    let authorization: string | undefined;
    try { this.authorize({ action: "close", requirementId: request.requirementId, reason: request.reason, receiptId: request.receiptId, operationId: request.operationId }); }
    catch (error) { authorization = adviceOf(error)?.why ?? (error as Error).message; }
    const existing = withDatabase(this.database, (db) => ({ operation: this.operation(db, request.requirementId), record: requirementIn(db, this.options.repoId, request.requirementId) }));
    if (authorization !== undefined) return freeze({ status: "rejected" as const, missing: ["close_authorization_invalid"], authorization });
    if (!existing.record.data.close) {
      const preflight = await this.preflight({ requirementId: request.requirementId, reason: request.reason, receiptId: request.receiptId });
      if (!preflight.eligible || !preflight.basis) return freeze({ status: "rejected" as const, missing: preflight.missing, ...(preflight.authorization ? { authorization: preflight.authorization } : {}) });
      const basis = preflight.basis;
      const intent = { operationId: request.operationId, reason: request.reason, receiptId: request.receiptId };
      const prototypes = request.reason === "completed"
        ? (await prototypesAtRevision(this.options, request.requirementId, basis.revision))
          .map((item) => ({ path: prototypeArchivePathFor(request.requirementId, item.name), name: item.name, version: item.version, hash: item.hash }))
        : [];
      try {
        this.state.beginClose({ requirementId: request.requirementId, version: basis.version, intent }, (db) => {
          const facts = deliveryFactsIn(db, this.options.repoId, request.requirementId);
          if (basisOf(facts).digest !== basis.digest) throw new RequirementStateError("close_basis_changed");
          if (activeCheckRoundIn(db, this.options.repoId, request.requirementId)) throw new RequirementStateError("check_phase_active");
          if (request.reason === "completed" && (facts.blockers.length > 0 || activeRunsIn(db, request.requirementId, "role").length > 0)) throw new RequirementStateError("completion_blocked");
          if (request.reason === "completed" && acceptedReportIn(db, this.options.repoId, request.requirementId, request.receiptId)?.basis.digest !== basis.digest) throw new RequirementStateError("completion_report_stale");
          const workspace = facts.record.data.workspace;
          const archivePath = request.reason === "completed" && workspace && facts.record.data.approved ? this.operations.archivePath(request.requirementId, facts.record.data.approved) : null;
          if (request.reason === "completed" && !archivePath) throw new RequirementStateError("archive_path_missing");
          const now = this.now();
          this.saveOperation(db, this.operation(db, request.requirementId), { format: "close-operation/v1", requirementId: request.requirementId, repoId: this.options.repoId,
            operationId: request.operationId, receiptId: request.receiptId, reason: request.reason, basis, status: "closing",
            steps: { agentsStopped: false, closed: false },
            archive: archivePath ? { path: archivePath, prodHash: facts.record.data.approved!.hash, commit: facts.record.data.approved!.commit, records: { implementation: implementationRecord(request.requirementId, readPlanIn(db, request.requirementId)?.tasks ?? [], acceptedReportIn(db, this.options.repoId, request.requirementId, request.receiptId)!),
              acceptance: acceptanceRecord(facts) },
              prototypes, archiveHash: null, status: "pending", attempts: 0, lastError: null } : null,
            createdAt: now, updatedAt: now });
        });
      } catch (error: unknown) {
        if (error instanceof RequirementStateError) return freeze({ status: "rejected" as const, missing: [error.code] });
        throw error;
      }
    } else if (existing.record.data.close.operationId !== request.operationId || existing.record.data.close.reason !== request.reason || existing.record.data.close.receiptId !== request.receiptId) {
      return freeze({ status: "rejected" as const, missing: ["close_intent_conflict"] });
    }
    return this.finish(request.requirementId);
  }

  /** 续办 closing：只重试未完成的收尾，不回 active、不改关闭原因、不重复副作用。 */
  private async finish(requirementId: string): Promise<CloseResult> {
    const operation = withDatabase(this.database, (db) => this.operation(db, requirementId));
    if (!operation) throw new CloseError("not_found");
    if (!operation.data.steps.agentsStopped) {
      try { await this.options.stopAgents?.(requirementId); } catch { /* 停止失败以运行记录为准，保持 closing。 */ }
    }
    const pending = withDatabase(this.database, (db) => db.transaction(() => {
      const current = this.operation(db, requirementId)!;
      const blockers: string[] = [];
      const runs = activeRunsIn(db, requirementId);
      if (runs.length > 0) blockers.push("agents_running");
      if (runningVerificationsIn(db, this.options.repoId, requirementId).length > 0) blockers.push("verification_running");
      const owner = db.read<{ lease?: unknown }>("pm_ownership", requirementId)?.data;
      if (owner?.lease) blockers.push("pm_lease_active");
      if (blockers.length === 0 && !current.data.steps.agentsStopped) {
        endRequirementExploreSessionsIn(db, this.options.repoId, requirementId, "requirement_closed");
        this.saveOperation(db, current, { ...current.data, steps: { ...current.data.steps, agentsStopped: true } });
      }
      return blockers;
    }));
    if (pending.length > 0) return freeze({ status: "closing" as const, operationId: operation.data.operationId, pending });
    const record = this.state.read(requirementId);
    if (record.data.lifecycle === "closing") {
      try { this.state.finishClose({ requirementId, version: record.version, operationId: operation.data.operationId }); }
      catch (error: unknown) { if (error instanceof RequirementStateError) return freeze({ status: "closing" as const, operationId: operation.data.operationId, pending: [error.code] }); throw error; }
    }
    withDatabase(this.database, (db) => db.transaction(() => {
      const current = this.operation(db, requirementId)!;
      if (current.data.status !== "closed") this.saveOperation(db, current, { ...current.data, status: "closed", steps: { ...current.data.steps, closed: true } });
    }));
    const final = withDatabase(this.database, (db) => this.operation(db, requirementId)!.data);
    return freeze({ status: "closed" as const, operationId: final.operationId, reason: final.reason,
      archive: final.archive ? { path: final.archive.path, status: final.archive.status } : null,
      message: final.reason === "completed" ? COMPLETION_MESSAGE(requirementId) : TERMINATION_MESSAGE(requirementId, final.reason) });
  }

  status(requirementId: string) {
    checked(id, requirementId);
    this.authorize({ action: "status", requirementId });
    const operation = withDatabase(this.database, (db) => this.operation(db, requirementId));
    if (!operation) return freeze({ status: "none" as const });
    const { data } = operation;
    const delivery = data.status === "closed" && data.reason === "completed" && data.basis.checkRoundId ? withDatabase(this.database, (db) => {
      const workspace = requirementIn(db, this.options.repoId, requirementId).data.workspace;
      const round = db.read<unknown>(CHECK_ROUNDS, data.basis.checkRoundId!);
      return workspace && round ? { worktree: workspace.path, branch: workspace.branch, codeHead: checked(CheckRound, round.data).baseline.codeHead } : null;
    }) : null;
    const archive = data.archive ? { path: data.archive.path, prodHash: data.archive.prodHash, archiveHash: data.archive.archiveHash, prototypes: data.archive.prototypes, status: data.archive.status,
      attempts: data.archive.attempts, lastError: data.archive.lastError } : null;
    return freeze({ status: data.status, operationId: data.operationId, reason: data.reason, steps: { ...data.steps }, archive, delivery });
  }

  /** 受限归档：把关闭前固化的最终 prod.md 字节原样写入登记路径，其后接关闭时登记的验收记录；同 hash 幂等，不同内容阻塞，不向调用方返回正文。 */
  async archive(requirementId: string): Promise<{ status: "archived" | "blocked" | "pending"; path: string; prodHash: string; archiveHash: string | null; attempts: number; lastError: string | null }> {
    checked(id, requirementId);
    this.authorize({ action: "archive", requirementId });
    const loaded = withDatabase(this.database, (db) => ({ operation: this.operation(db, requirementId), record: requirementIn(db, this.options.repoId, requirementId) }));
    const { operation, record } = loaded;
    if (!operation || !operation.data.archive) throw new CloseError("archive_unavailable", "非完成关闭无归档资格");
    if (record.data.lifecycle !== "closed" || operation.data.status !== "closed" || record.data.close?.reason !== "completed" || operation.data.reason !== "completed") throw new CloseError("not_closed");
    const archive = operation.data.archive;
    const view = () => freeze({ status: archive.status, path: archive.path, prodHash: archive.prodHash, archiveHash: archive.archiveHash, attempts: archive.attempts, lastError: archive.lastError });
    if (archive.status === "archived") return view();
    const save = (next: Partial<NonNullable<CloseOperation["archive"]>>) => withDatabase(this.database, (db) => db.transaction(() => {
      const current = this.operation(db, requirementId)!;
      this.saveOperation(db, current, { ...current.data, archive: { ...current.data.archive!, ...next } });
    }));
    try {
      const workspace = record.data.workspace;
      if (!workspace) throw new Error("workspace_missing");
      await verifyRequirementWorkspace(this.options.dataRoot, workspace);
      const identity = this.operations.repositoryIdentity(requirementId) ?? undefined;
      const bytes = (await readVersion({ dataRoot: this.options.dataRoot, repoId: this.options.repoId, requirementId, repositoryRoot: this.options.repositoryRoot,
        expectedRepositoryIdentity: identity, commit: archive.commit, expectedHash: `sha256:${archive.prodHash}`,
        authorize: (check) => check.requirementId === requirementId && check.action === "readVersion" && (check.prodHash === undefined || check.prodHash === `sha256:${archive.prodHash}`) })).bytes;
      if (sha256(Buffer.from(bytes)) !== archive.prodHash) throw new Error("final_prod_hash_mismatch");
      if (!record.data.docSpec) throw new Error("archive_sections_missing");
      const content = archiveBytes(bytes, archive.records, recordSectionIds(record.data.docSpec.sections));
      if (!content) throw new Error("archive_sections_missing");
      const archiveHash = sha256(content);
      const root = await realpath(workspace.path);
      const target = join(root, ...archive.path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      const real = await resolveRealRepoPath(root, target, false);
      if (real !== archive.path) throw new Error("archive_path_escape");
      const htmls: Array<{ target: string; content: Buffer; existing: Buffer | null }> = [];
      for (const item of archive.prototypes) {
        const content = await readFile(prototypeFilePath(this.options, { requirementId, name: item.name, version: item.version }));
        if (sha256(content) !== item.hash) {
          const detail = `原型 ${item.name} 第 ${item.version} 版`;
          save({ status: "blocked", attempts: archive.attempts + 1, lastError: `${detail}的源文件指纹不符` });
          throw new CloseError("archive_prototype_mismatch", detail);
        }
        const htmlTarget = join(root, ...item.path.split("/"));
        if (await resolveRealRepoPath(root, htmlTarget, false) !== item.path) throw new Error("archive_path_escape");
        let current: Buffer | null = null;
        try { const stats = await lstat(htmlTarget); if (!stats.isFile()) throw new Error("archive_target_not_file"); current = await readFile(htmlTarget); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (current && sha256(current) !== item.hash) { save({ status: "blocked", attempts: archive.attempts + 1, lastError: "archive_conflict" }); throw new CloseError("archive_conflict"); }
        htmls.push({ target: htmlTarget, content, existing: current });
      }
      let existing: Buffer | null = null;
      try { const stats = await lstat(target); if (!stats.isFile()) throw new Error("archive_target_not_file"); existing = await readFile(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing && sha256(existing) !== archiveHash) { save({ status: "blocked", attempts: archive.attempts + 1, lastError: "archive_conflict" }); throw new CloseError("archive_conflict"); }
      if (!existing) {
        await writeFileAtomic(target, content.toString("utf8"));
        if (sha256(await readFile(target)) !== archiveHash) throw new Error("archive_write_mismatch");
      }
      for (const html of htmls) {
        if (html.existing) continue;
        await writeFileAtomic(html.target, html.content.toString("utf8"));
        if (sha256(await readFile(html.target)) !== sha256(html.content)) throw new Error("archive_write_mismatch");
      }
      save({ status: "archived", archiveHash, attempts: archive.attempts + 1, lastError: null });
      return freeze({ status: "archived" as const, path: archive.path, prodHash: archive.prodHash, archiveHash, attempts: archive.attempts + 1, lastError: null });
    } catch (error) {
      if (error instanceof CloseError) throw error;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
      save({ status: "pending", attempts: archive.attempts + 1, lastError: message });
      return freeze({ status: "pending" as const, path: archive.path, prodHash: archive.prodHash, archiveHash: archive.archiveHash, attempts: archive.attempts + 1, lastError: message });
    }
  }
}
