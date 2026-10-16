import { describe, expect, test } from "vitest";
import { Value } from "typebox/value";
import { HostAuthorizationManager } from "../src/modules/requirement/host-authorization.ts";
import { REQUIREMENT_MANAGE_PARAMETERS, createRequirementManageTool } from "../src/modules/interaction/requirement-manage-tool.ts";
import { uuidv7 } from "../src/core/storage/database.ts";

describe("requirement_manage严格公开参数", () => {
  const base = { action: "create", repoId: "a".repeat(64), requestId: uuidv7(), operationId: uuidv7(), summary: "手机号登录，保留邮箱登录", title: "标题", body: "正文" };
  test("actor/role/cwd/receipt/hash/capability与外部用户转述均不成为输入字段", () => {
    expect(Value.Check(REQUIREMENT_MANAGE_PARAMETERS, { request: base })).toBe(true);
    expect(Value.Check(REQUIREMENT_MANAGE_PARAMETERS, base)).toBe(false);
    for (const key of ["actor", "role", "cwd", "receiptId", "intentHash", "commit", "manifest", "capability", "answer", "message", "text"]) {
      expect(Value.Check(REQUIREMENT_MANAGE_PARAMETERS, { request: { ...base, [key]: "forged" } }), key).toBe(false);
      expect(Value.Check(REQUIREMENT_MANAGE_PARAMETERS, { request: base, [key]: "forged" }), key).toBe(false);
    }
  });
  test("confirmUpdate执行期只接saved操作等元数据，严格拒绝旧正文确认载荷", async () => {
    const tool = createRequirementManageTool({ interaction: { execute: () => { throw new Error("must-not-run"); } } as never });
    const confirm = { action: "confirmUpdate", repoId: base.repoId, requirementId: uuidv7(), operationId: uuidv7(), version: 2 };
    await expect(tool.execute("test", { request: { ...confirm, title: "旧标题", body: "旧正文" } } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "invalid_shape" });
    await expect(tool.execute("test", { request: { ...confirm, savedOperationId: uuidv7(), title: "偷换" } } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "invalid_shape" });
    await expect(tool.execute("test", { ...confirm, savedOperationId: uuidv7() } as never, undefined, undefined, {} as never)).rejects.toMatchObject({ code: "invalid_shape" });
  });
  test("参数不合格时报错只给字段名，便于模型改正，不回显值", async () => {
    const tool = createRequirementManageTool({ interaction: { execute: () => { throw new Error("must-not-run"); } } as never });
    const { body: _body, ...withoutBody } = base;
    const error = await tool.execute("test", { request: { ...withoutBody, requirementId: uuidv7(), sectionId: "x" } } as never, undefined, undefined, {} as never).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "invalid_shape" });
    expect((error as Error).message).toContain("多余字段：requirementId、sectionId；缺少字段：body；本动作允许字段：action、repoId、requestId、operationId、summary、title、body");
    expect((error as Error).message).not.toContain("标题");
    const unknown = await tool.execute("test", { request: { action: "approve", repoId: base.repoId } } as never, undefined, undefined, {} as never).catch((caught: unknown) => caught);
    expect((unknown as Error).message).toContain("可用 action：create、updateDraft、confirmUpdate、read、diff、next、metadata");
  });
  test("M8D-AC2：宿主身份只接受已接入的仓库，没有窗口绑定需求的入口，切换撤权且无UI旧回执API", () => {
    const auth = new HostAuthorizationManager({ dataRoot: "/unused-no-database" });
    let revokes = 0;
    auth.onRevoke(() => revokes++);
    auth.startWindow({ kind: "main", windowId: "window", sessionId: "session", repoIds: [base.repoId] });
    expect(() => auth.assertRepository(base.repoId, "session")).not.toThrow();
    expect(() => auth.assertRepository("b".repeat(64), "session")).toThrow(/foreign_repo/);
    for (const removed of ["bindRequirement", "assertRequirement", "binding", "prepareSelections", "bindSelection"]) expect(removed in auth).toBe(false);
    expect(() => auth.assertCurrentSession("forged")).toThrow(/untrusted_host/);
    expect("recordConfirmation" in auth).toBe(false);
    expect("captureInput" in auth).toBe(false);
    auth.shutdown();
    expect(revokes).toBe(2);
    expect(() => auth.assertCurrentSession("session")).toThrow();
  });
});
