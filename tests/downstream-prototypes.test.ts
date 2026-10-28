import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { CHECK_ROUNDS } from "../src/modules/verification/check-round.ts";
import type { CheckRound } from "../src/modules/verification/check-round.ts";
import { TASKS } from "../src/modules/pm/plan-manage.ts";
import type { TaskSpec } from "../src/modules/pm/plan-manage.ts";
import { prototypeFilePath } from "../src/modules/requirement/requirement-prototypes.ts";
import { writePrototypeRevision } from "../src/modules/requirement/requirement-prototype-revisions.ts";
import type { RevisionPrototype } from "../src/modules/requirement/requirement-prototype-revisions.ts";
import type { ScriptedReply } from "./helpers/controlled-provider.ts";
import { createPmRunWorld, until } from "./helpers/run-manager-fixture.ts";

vi.setConfig({ testTimeout: 90_000 });
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const NA = { applicable: false as const, reason: "无性能影响" };
const spec = (key: string, patch: Partial<TaskSpec> = {}): TaskSpec => ({ key, role: "worker", goalUnitIds: ["goal.login"], constraintUnitIds: [], dependsOn: [],
  writePaths: ["src/"], blockedByQuestionIds: [], maxTurns: 3, objective: `实现 ${key}`, passCriteria: ["可观察通过"], scope: { in: [key], out: ["其他"] }, performance: NA, ...patch });
const pmAck: ScriptedReply = { type: "text", text: "PM 收到" };
const verdict = (summary: string): ScriptedReply => ({ type: "toolcall", name: "one_company_result_submit",
  input: { action: "verdict", result: { checkRoundId: null, verificationIds: [], summary, findings: [] } } });
const TITLE = (revision: number) => `需求第 ${revision} 版附带的原型（界面以它们为准）：`;

const settings = (version: number): RevisionPrototype => ({ name: "设置页", version, hash: `5e77195${version}`.padEnd(64, "a"), bytes: 100, userNote: null });
const terminal: RevisionPrototype = { name: "命令行输出", version: 1, hash: "c11001ab9f".padEnd(64, "b"), bytes: 80, userNote: null };

async function world() {
  const w = await createPmRunWorld(cleanups);
  const ref = { dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId };
  const database = repositoryDatabase(ref.dataRoot, ref.repoId);
  const requirementId = w.fixture.requirementId;
  const contentOf = (item: RevisionPrototype) => `<html>PROTO-${item.name}-v${item.version}</html>`;
  const pathOf = (item: RevisionPrototype) => prototypeFilePath(ref, { requirementId, name: item.name, version: item.version });
  const seed = async (revision: number, items: RevisionPrototype[]) => {
    withDatabase(database, (db) => writePrototypeRevision(db, { requirementId, revision, prototypes: items }));
    for (const item of items) { await mkdir(dirname(pathOf(item)), { recursive: true }); await writeFile(pathOf(item), contentOf(item)); }
  };
  const task = (key: string) => withDatabase(database, (db) => db.list<{ key: string; taskId: string; status: string }>(TASKS).map((row) => row.data).find((entry) => entry.key === key)!);
  const setPlan = async (tasks: TaskSpec[]) => { await w.plan.execute({ action: "propose", tasks }); await w.plan.execute({ action: "confirm", planVersion: 1 }); };
  const dispatch = (key: string, mode: { review?: { maxTurns: number } } = {}) => w.manager.dispatchTask({ pmRunId: w.pm.runId, taskId: task(key).taskId, retry: null, ...mode });
  const promptOf = (marker: string, exclude?: string): string => w.provider.requests
    .find((request: Context) => request.systemPrompt?.includes(marker) && !(exclude && request.systemPrompt.includes(exclude)))?.systemPrompt ?? "";
  const runWorker = async (key: string) => {
    w.provider.queue.push(verdict(`完成 ${key}`), pmAck);
    await dispatch(key);
    await until(() => task(key).status === "awaiting_review");
  };
  const runReviewer = async (key: string) => {
    w.provider.queue.push(verdict("符合目标"), pmAck);
    await dispatch(key, { review: { maxTurns: 2 } });
    await until(() => task(key).status === "completed");
  };
  const openRound = (baselineRevision: number) => {
    const record = w.fixture.state.read(requirementId).data;
    const round: CheckRound = { format: "check-round/v1", checkRoundId: uuidv7(), requirementId, repoId: w.fixture.repoId, workspaceId: record.workspace!.workspaceId,
      branch: record.workspace!.branch, epoch: record.epoch, fence: w.lease.fence, runId: w.lease.runId,
      baseline: { revision: baselineRevision, approved: record.approved!, codeHead: record.workspace!.baseCommit, inputHash: "d".repeat(64), inputCount: 0,
        environment: { node: process.version, platform: process.platform, arch: process.arch } },
      status: "open", invalidation: null, decision: null, verifications: [], active: [], createdAt: Date.now(), updatedAt: Date.now() };
    withDatabase(database, (db) => db.create(CHECK_ROUNDS, round.checkRoundId, round, round.checkRoundId));
  };
  const expectSection = (prompt: string, revision: number, items: RevisionPrototype[]) => {
    expect(prompt).toContain(TITLE(revision));
    for (const item of items) {
      const line = prompt.split("\n").find((entry) => entry.includes(item.name) && entry.includes(`第 ${item.version} 版`));
      expect(line, `${item.name} 的原型行`).toBeDefined();
      expect(line).toContain(pathOf(item));
      expect(line).toContain(item.hash.slice(0, 12));
    }
  };
  return { ...w, ref, requirementId, seed, task, setPlan, dispatch, promptOf, runWorker, runReviewer, openRound, expectSection, pathOf, contentOf };
}
const THREE = [spec("ui", { writePaths: ["src/ui/"] }), spec("rest", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] }),
  spec("qa", { role: "qa", writePaths: [], maxTurns: 6 })];

describe("派出的任务说明带上当时批准版本的原型", () => {
  test("worker 的任务说明列出第 1 版的两份原型的名称、版本、位置、指纹前 12 位和界面以它们为准", async () => {
    const w = await world();
    await w.seed(1, [settings(2), terminal]);
    await w.setPlan(THREE);
    await w.runWorker("ui");
    w.expectSection(w.promptOf("任务：ui（", "审查任务：ui（"), 1, [settings(2), terminal]);
  });

  test("reviewer 的任务说明列出第 1 版的两份原型", async () => {
    const w = await world();
    await w.seed(1, [settings(2), terminal]);
    await w.setPlan(THREE);
    await w.runWorker("ui");
    await w.runReviewer("ui");
    w.expectSection(w.promptOf("审查任务：ui（"), 1, [settings(2), terminal]);
  });

  test("检查轮里的 qa 用这一轮基线版本的原型，不用需求当前版本的", async () => {
    const w = await world();
    await w.seed(1, [settings(2), terminal]);
    await w.seed(2, [settings(3), terminal]);
    await w.setPlan(THREE);
    await w.runWorker("ui");
    await w.runReviewer("ui");
    w.openRound(2);
    w.provider.queue.push({ type: "text", text: "验收完" }, pmAck);
    await w.dispatch("qa");
    await until(() => w.promptOf("任务：qa（") !== "");
    const prompt = w.promptOf("任务：qa（");
    w.expectSection(prompt, 2, [settings(3), terminal]);
    expect(prompt).not.toContain(w.pathOf(settings(2)));
  });

  test("批准版本没有原型时 worker、reviewer、qa 的任务说明都没有原型段", async () => {
    const w = await world();
    await w.setPlan(THREE);
    await w.runWorker("ui");
    await w.runReviewer("ui");
    w.openRound(1);
    w.provider.queue.push({ type: "text", text: "验收完" }, pmAck);
    await w.dispatch("qa");
    await until(() => w.promptOf("任务：qa（") !== "");
    for (const prompt of [w.promptOf("任务：ui（", "审查任务：ui（"), w.promptOf("审查任务：ui（"), w.promptOf("任务：qa（")]) {
      expect(prompt).not.toBe("");
      expect(prompt).not.toContain("附带的原型");
    }
  });
});

describe("任务说明带上用户通过原型时的补充说明", () => {
  const withNote = (item: RevisionPrototype, userNote: string | null): RevisionPrototype => ({ ...item, userNote });
  const noteLine = (prompt: string, name: string) => {
    const lines = prompt.split("\n");
    return lines[lines.findIndex((line) => line.includes(name) && line.includes("第 ")) + 1];
  };

  test("worker 的原型清单里带说明的原型下面紧跟说明行，没有说明的下面没有", async () => {
    const w = await world();
    await w.seed(1, [withNote(settings(1), "用 B 方案（顶部分栏），A 和 C 不要"), terminal]);
    await w.setPlan(THREE);
    await w.runWorker("ui");
    const prompt = w.promptOf("任务：ui（", "审查任务：ui（");
    expect(noteLine(prompt, "设置页")).toBe("  用户通过时的说明：用 B 方案（顶部分栏），A 和 C 不要");
    expect(prompt.split("\n").filter((line) => line.includes("用户通过时的说明"))).toHaveLength(1);
  });

  test("第 1 版里设置页第 1 版带用 B、第 2 版换成设置页第 2 版带用 C 时，按各自版本派出的 worker 分别拿到各自的说明", async () => {
    const w = await world();
    await w.seed(1, [withNote(settings(1), "用 B"), terminal]);
    await w.setPlan([spec("a", { writePaths: ["src/a/"] }), spec("b", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })]);
    await w.runWorker("a");
    const first = w.promptOf("任务：a（", "审查任务：a（");
    expect(first).toContain("用户通过时的说明：用 B");

    w.provider.queue.push({ type: "text", text: "PM 收到新版本差异" }, { type: "text", text: "PM 空闲" });
    await w.fixture.approveRevision({ body: "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n# 重发验证码 {#goal.resend}\n可重发。\n" });
    await w.seed(2, [withNote(settings(2), "用 C"), terminal]);
    await until(() => w.owner().context.baseline?.revision === 2);
    await w.readDiffs(["revision 1 → 2"]);
    const version = () => withDatabase(repositoryDatabase(w.ref.dataRoot, w.ref.repoId), (db) => db.read<{ planVersion: number }>("plans", w.requirementId)!.data.planVersion);
    await w.plan.execute({ action: "assess-update", revision: 2, assessmentId: uuidv7(), tasks: ["a", "b"].map((key) => ({ taskId: w.task(key).taskId,
      version: 1, assessment: "unaffected", rationale: `${key} 不受影响` })), global: { assessment: "unaffected", rationale: "只换了设置页原型" } });
    await w.plan.execute({ action: "update", planVersion: version(), add: [spec("resend", { goalUnitIds: ["goal.resend"], writePaths: ["web/"] })] });
    await w.plan.execute({ action: "confirm", planVersion: version() });

    w.provider.queue.length = 0;
    w.provider.queue.push(verdict("完成 resend"), pmAck);
    await w.dispatch("resend");
    await until(() => w.task("resend").status === "awaiting_review");
    const second = w.promptOf("任务：resend（", "审查任务：resend（");
    expect(second).toContain("用户通过时的说明：用 C");
    expect(second).not.toContain("用 B");
    expect(first).not.toContain("用 C");
  });
});

describe("worker 与 reviewer 读原型文件", () => {
  const readOf = (path: string): ScriptedReply => ({ type: "toolcall", name: "read", input: { path } });

  test("worker 读得到两份原型文件的内容", async () => {
    const w = await world();
    await w.seed(1, [settings(2), terminal]);
    await w.setPlan(THREE);
    w.provider.queue.push(readOf(w.pathOf(settings(2))), readOf(w.pathOf(terminal)), verdict("完成 ui"), pmAck);
    await w.dispatch("ui");
    await until(() => w.task("ui").status === "awaiting_review");
    const requests = w.provider.requests.filter((request) => request.systemPrompt?.includes("任务：ui（") && !request.systemPrompt.includes("审查任务：ui（"));
    expect(JSON.stringify(requests[1]!.messages)).toContain(w.contentOf(settings(2)));
    expect(JSON.stringify(requests[2]!.messages)).toContain(w.contentOf(terminal));
  });

  test("reviewer 读得到两份原型文件的内容", async () => {
    const w = await world();
    await w.seed(1, [settings(2), terminal]);
    await w.setPlan(THREE);
    await w.runWorker("ui");
    w.provider.queue.push(readOf(w.pathOf(settings(2))), readOf(w.pathOf(terminal)), verdict("符合目标"), pmAck);
    await w.dispatch("ui", { review: { maxTurns: 4 } });
    await until(() => w.task("ui").status === "completed");
    const requests = w.provider.requests.filter((request) => request.systemPrompt?.includes("审查任务：ui（"));
    expect(JSON.stringify(requests[1]!.messages)).toContain(w.contentOf(settings(2)));
    expect(JSON.stringify(requests[2]!.messages)).toContain(w.contentOf(terminal));
  });
});

describe("qa 读原型文件", () => {
  test("有原型时 qa 只有 read 这一个宿主工具，能读原型文件，读工作区里别的文件被拒", async () => {
    const w = await world();
    await w.seed(1, [settings(2), terminal]);
    await w.setPlan(THREE);
    await w.runWorker("ui");
    await w.runReviewer("ui");
    const workspace = w.fixture.state.read(w.requirementId).data.workspace!.path;
    await writeFile(join(workspace, "other.txt"), "OTHER-FILE-MARKER");
    w.openRound(1);
    w.provider.queue.push({ type: "toolcall", name: "read", input: { path: w.pathOf(settings(2)) } }, { type: "toolcall", name: "read", input: { path: w.pathOf(terminal) } },
      { type: "toolcall", name: "read", input: { path: join(workspace, "other.txt") } }, { type: "text", text: "验收完" }, pmAck);
    await w.dispatch("qa");
    await until(() => w.provider.requests.filter((request) => request.systemPrompt?.includes("任务：qa（")).length >= 4);
    const qaRequests = w.provider.requests.filter((request) => request.systemPrompt?.includes("任务：qa（"));
    const hostTools = (qaRequests[0]!.tools ?? []).map((tool) => tool.name).filter((name) => !name.startsWith("one_company_"));
    expect(hostTools).toEqual(["read"]);
    const afterFirst = JSON.stringify(qaRequests[1]!.messages);
    expect(afterFirst).toContain(w.contentOf(settings(2)));
    expect(JSON.stringify(qaRequests[2]!.messages)).toContain(w.contentOf(terminal));
    const afterSecond = JSON.stringify(qaRequests[3]!.messages);
    expect(afterSecond).toContain("读取路径超出范围");
    expect(afterSecond).not.toContain("OTHER-FILE-MARKER");
  });
});

describe("批准新版本不改已派出的任务", () => {
  test("先按第 1 版派出的 worker 提示词是设置页 v2，批准第 2 版换成 v3 并复核后派出的 worker 是 v3", async () => {
    const w = await world();
    await w.seed(1, [settings(2), terminal]);
    await w.setPlan([spec("a", { writePaths: ["src/a/"] }), spec("b", { goalUnitIds: ["scenario.failure"], writePaths: ["lib/"] })]);
    await w.runWorker("a");
    const first = w.promptOf("任务：a（", "审查任务：a（");
    w.expectSection(first, 1, [settings(2), terminal]);

    w.provider.queue.push({ type: "text", text: "PM 收到新版本差异" }, { type: "text", text: "PM 空闲" });
    await w.fixture.approveRevision({ body: "# 手机号正常登录 {#goal.login}\n输入正确验证码后成功。\n# 验证码失败 {#scenario.failure}\n错误验证码显示失败。\n# 重发验证码 {#goal.resend}\n可重发。\n" });
    await w.seed(2, [settings(3), terminal]);
    await until(() => w.owner().context.baseline?.revision === 2);
    await w.readDiffs(["revision 1 → 2"]);
    const version = () => withDatabase(repositoryDatabase(w.ref.dataRoot, w.ref.repoId), (db) => db.read<{ planVersion: number }>("plans", w.requirementId)!.data.planVersion);
    await w.plan.execute({ action: "assess-update", revision: 2, assessmentId: uuidv7(), tasks: ["a", "b"].map((key) => ({ taskId: w.task(key).taskId,
      version: 1, assessment: "unaffected", rationale: `${key} 不受影响` })), global: { assessment: "unaffected", rationale: "只换了设置页原型" } });
    await w.plan.execute({ action: "update", planVersion: version(), add: [spec("resend", { goalUnitIds: ["goal.resend"], writePaths: ["web/"] })] });
    await w.plan.execute({ action: "confirm", planVersion: version() });

    w.provider.queue.length = 0;
    w.provider.queue.push(verdict("完成 resend"), pmAck);
    await w.dispatch("resend");
    await until(() => w.task("resend").status === "awaiting_review");
    const second = w.promptOf("任务：resend（", "审查任务：resend（");
    w.expectSection(second, 2, [settings(3), terminal]);
    expect(first).toContain(w.pathOf(settings(2)));
    expect(first).not.toContain(w.pathOf(settings(3)));
  });
});
