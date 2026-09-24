import { createSessionManagerForRun } from "../../runtime/session-records.ts";
import { createPmIntakeProviders, PM_INTAKE_TOOL } from "../../runtime/pm-intake-runtime.ts";
import type { IntakeSubmissionBaseline } from "../../runtime/pm-intake-runtime.ts";
import type { PmUnderstanding } from "../../runtime/pm-intake-contracts.ts";
import type { PmIntakeFixture } from "./pm-intake-fixture.ts";

export type UnderstandingContent = Omit<PmUnderstanding, "format" | "binding">;

/** 在夹具 PM 运行的私有会话里写入被工具受理的接手理解，并返回主代理核对所用的真实提供方。 */
export async function pmIntakeReviewKit(fixture: PmIntakeFixture) {
  const captured = fixture.captureCurrent();
  const material = await fixture.submissionProvider.loadCurrent({ binding: captured.binding, sourceDirectoryHash: captured.sourceDirectoryHash,
    maxBytes: 49_152, signal: new AbortController().signal });
  const { format: _format, binding: _binding, ...content } = material!.understanding;
  const session = createSessionManagerForRun({ dataRoot: fixture.dataRoot, repoId: fixture.repoId, runId: fixture.lease.runId, cwd: fixture.root });
  const current: IntakeSubmissionBaseline = { approvedRevision: captured.binding.approvedRevision, approvedProdHash: captured.binding.approvedProdHash,
    approvalManifestHash: captured.binding.approvalManifestHash };
  let serial = 0;
  function submit(value: UnderstandingContent, isError = false, baseline: IntakeSubmissionBaseline = current): string {
    const id = `call-${++serial}`;
    session.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: PM_INTAKE_TOOL, arguments: { action: "ask", purpose: "pm-intake", understanding: value } }],
      api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() });
    session.appendMessage({ role: "toolResult", toolCallId: id, toolName: PM_INTAKE_TOOL, content: [{ type: "text", text: "ok" }], isError,
      details: { intakeBaseline: baseline }, timestamp: Date.now() });
    return id;
  }
  const intake = fixture.makeIntake(createPmIntakeProviders(fixture.dataRoot));
  async function pass(): Promise<void> {
    submit(content);
    const view = await intake.openRequest(fixture.call, fixture.operationId());
    await intake.recordReview(fixture.call, view.requestId, fixture.operationId(), { result: "passed", shortIssues: [] });
  }
  return { content, submit, intake, current, pass };
}
