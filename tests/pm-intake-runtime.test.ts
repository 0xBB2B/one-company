import { afterEach, expect, test, vi } from "vitest";
import { createSessionManagerForRun } from "../runtime/session-records.ts";
import { createPmIntakeProviders, evaluatePmIntakeGate, PM_INTAKE_TOOL } from "../runtime/pm-intake-runtime.ts";
import type { PmUnderstanding } from "../runtime/pm-intake-contracts.ts";
import { createPmIntakeFixture } from "./helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "./helpers/pm-intake-fixture.ts";

vi.setConfig({ testTimeout: 30_000 });
const clean: PmIntakeFixture[] = [];
afterEach(async () => { for (const fixture of clean.splice(0).reverse()) await fixture.cleanup(); });

type Content = Omit<PmUnderstanding, "format" | "binding">;

async function world() {
  const fixture = await createPmIntakeFixture();
  clean.push(fixture);
  const captured = fixture.captureCurrent();
  const material = await fixture.submissionProvider.loadCurrent({ binding: captured.binding, sourceDirectoryHash: captured.sourceDirectoryHash,
    maxBytes: 49_152, signal: new AbortController().signal });
  const { format: _format, binding: _binding, ...content } = material!.understanding;
  const session = createSessionManagerForRun({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, runId: fixture.lease.runId, cwd: fixture.root });
  let serial = 0;
  const current = { approvedRevision: captured.binding.approvedRevision, approvedProdHash: captured.binding.approvedProdHash,
    approvalManifestHash: captured.binding.approvalManifestHash };
  function submit(value: Content, isError = false, baseline: typeof current = current): string {
    const id = `call-${++serial}`;
    session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: PM_INTAKE_TOOL, arguments: { action: "ask", purpose: "pm-intake", understanding: value } }],
      api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
    session.appendMessage({ role: "toolResult", toolCallId: id, toolName: PM_INTAKE_TOOL, content: [{ type: "text", text: "ok" }], isError,
      details: { intakeBaseline: baseline }, timestamp: Date.now() });
    return id;
  }
  const providers = createPmIntakeProviders(fixture.dataRoot);
  const intake = fixture.makeIntake(providers);
  const gate = (action: "plan" | "implement" = "implement") => evaluatePmIntakeGate({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, lease: fixture.lease, action });
  return { fixture, content, submit, intake, gate, current };
}

test("M7-AC13：主代理经真实提供方读到 PM 会话里的提交，核对通过前门槛拒绝，通过后只放行已授权动作", async () => {
  const w = await world();
  expect(w.gate()).toEqual({ allowed: false, reasons: ["review_missing"] });
  const callId = w.submit(w.content);
  const view = await w.intake.openRequest(w.fixture.call, w.fixture.operationId());
  expect(view.submissionRef).toBe(`pm/${w.fixture.lease.runId}/${callId}`);
  expect(view.understanding.goals).toEqual(w.content.goals);
  expect(w.gate()).toMatchObject({ allowed: false, reasons: ["review_missing"] });
  await w.intake.recordReview(w.fixture.call, view.requestId, w.fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(w.gate("implement")).toMatchObject({ allowed: true });
  expect(w.gate("plan")).toMatchObject({ allowed: false, reasons: ["action_authorization_not_reported_current"] });
});

test("M7-AC14：未被工具受理的提交不计入；核对不通过、PM 改交理解或丢失基线后旧核对不能放行", async () => {
  const w = await world();
  w.submit(w.content);
  w.submit({ ...w.content, goals: [{ text: "未受理的改写", sourceRefs: w.content.goals[0]!.sourceRefs }] }, true);
  const view = await w.intake.openRequest(w.fixture.call, w.fixture.operationId());
  expect(view.understanding.goals).toEqual(w.content.goals);
  await w.intake.recordReview(w.fixture.call, view.requestId, w.fixture.operationId(), { result: "pm_correction_required", shortIssues: ["目标理解有误"] });
  expect(w.gate()).toMatchObject({ allowed: false, reasons: ["pm_correction_required"] });

  const v = await world();
  v.submit(v.content);
  const passed = await v.intake.openRequest(v.fixture.call, v.fixture.operationId());
  await v.intake.recordReview(v.fixture.call, passed.requestId, v.fixture.operationId(), { result: "passed", shortIssues: [] });
  expect(v.gate()).toMatchObject({ allowed: true });
  v.submit({ ...v.content, goals: [{ text: "PM 自行改交的新理解", sourceRefs: v.content.goals[0]!.sourceRefs }] });
  expect(v.gate()).toMatchObject({ allowed: false, reasons: ["understanding_baseline_mismatch"] });
});

test("M7-AC14：伪造的提交不能被当作 PM 的理解——只读取当前租约运行自己的会话", async () => {
  const w = await world();
  const providers = createPmIntakeProviders(w.fixture.dataRoot);
  const captured = w.fixture.captureCurrent();
  expect(await providers.submissionProvider.loadCurrent({ binding: captured.binding, sourceDirectoryHash: captured.sourceDirectoryHash,
    maxBytes: 49_152, signal: new AbortController().signal })).toBeNull();
  await expect(w.intake.openRequest(w.fixture.call, w.fixture.operationId())).rejects.toThrow();
});

test("M7-AC14：针对旧批准基线受理的理解不能被当作对当前基线的理解", async () => {
  const w = await world();
  w.submit(w.content, false, { ...w.current, approvedRevision: w.current.approvedRevision - 1 });
  w.submit(w.content, false, { ...w.current, approvedProdHash: "0".repeat(64) });
  await expect(w.intake.openRequest(w.fixture.call, w.fixture.operationId())).rejects.toThrow();
  w.submit(w.content);
  expect((await w.intake.openRequest(w.fixture.call, w.fixture.operationId())).understanding.goals).toEqual(w.content.goals);
});
