import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ensureConfiguredAuth } from "../runtime/requirement-role-reader.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("守护进程不在启动时刷新；角色读需求前按需刷新，认得 auth.json 里已配置凭据的提供方，未配置的仍判为缺凭据", async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-auth-"));
  roots.push(root);
  const model = { id: "probe-model", name: "probe", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: {
    probe: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-responses", models: [model] },
    other: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-responses", models: [model] } } }));
  await writeFile(join(root, "auth.json"), JSON.stringify({ probe: { type: "api_key", key: "probe-key" } }), { mode: 0o600 });
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"),
    modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  expect(runtime.hasConfiguredAuth("probe")).toBe(false);
  await expect(ensureConfiguredAuth(runtime, "probe")).resolves.toBe(true);
  await expect(ensureConfiguredAuth(runtime, "other")).resolves.toBe(false);
});
