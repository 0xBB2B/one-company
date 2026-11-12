type Result = Record<string, any>;

const keep = (source: Result, keys: string[]): Result =>
  Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));

export const draftResultView = (result: Result) => keep(result, ["requirementId", "version", "operationId", "revision", "status"]);

export function readResultView(result: Result) {
  const view = keep(result, ["requirementId", "title", "version", "text", "restoreFailure", "fromRevision", "toRevision"]);
  const { nextCursor, blocking } = result.coverage;
  view.coverage = { nextCursor, ...(blocking.length ? { blocking } : {}) };
  return view;
}

export function metadataResultView(result: Result) {
  const view = keep(result, ["requirementId", "version", "revision", "savedOperationId", "lifecycle", "recovery", "restoreFailure"]);
  if (result.approvalScope) view.approvalScope = { summary: keep(result.approvalScope.summary, ["pending", "blocked"]) };
  return view;
}

export const confirmResultView = (result: Result) =>
  keep(result, ["requirementId", "version", "prdActivated", "implementAuthorization", "next", "blockedBy", "blockedReason"]);

export const askResultView = (result: Result) => keep(result, ["requirementId", "version", "status", "answer"]);

export const panelItemResultView = (result: Result) => ({
  ...keep(result, ["status", "answer"]),
  decision: result.decision === null ? null : keep(result.decision, ["itemId", "itemVersion"]),
  ...keep(result, ["next"]),
});

export const adjudicateResultView = (result: Result) =>
  keep(result, ["decisionId", "status", "choice", "next", "notRecordedNext", "notRecorded"]);

export function requirementManageView(action: string, result: Result): unknown {
  switch (action) {
    case "create": case "updateDraft": return draftResultView(result);
    case "read": case "diff": case "next": return readResultView(result);
    case "metadata": return metadataResultView(result);
    case "confirmUpdate": return confirmResultView(result);
    default: return result;
  }
}
