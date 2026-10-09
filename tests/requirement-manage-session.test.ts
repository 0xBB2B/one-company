import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import requirementManageExtension from "../extensions/requirement-manage.ts";
import { HostAuthorizationManager } from "../runtime/host-authorization.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("M9：窗口启动时守护进程还没连上（首连降级为后台重连），需求工具照样登记本会话，连上之后不必重开窗口", async () => {
  const root = await mkdtemp(join(tmpdir(), "requirement-session-")); roots.push(root);
  const authorization = new HostAuthorizationManager({ dataRoot: root });
  const client = { state: () => ({ status: "unreachable" as const }), subscribe: () => () => {} };
  const window = { windowId: "window-1", sessionId: "session-1", workspace: { repos: [{ repoId: "a".repeat(64), path: root }] }, clients: { forRepo: () => client } };
  const fake = createFakePi();
  requirementManageExtension(fake.pi as never, { authorization, dataRoot: root, windowReady: async () => window as never, windowContext: () => window as never });
  await fake.trigger("session_start", {}, { sessionManager: { getSessionId: () => "session-1" } });
  expect(authorization.assertCurrentSession("session-1")).toMatchObject({ sessionId: "session-1" });
});
