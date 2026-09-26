import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { setupModelRuntime } from "../daemon/lifecycle.ts";

const previous = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];
afterEach(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("守护进程的模型运行时认得 auth.json 里已配置凭据的提供方，PM 等角色读需求时不会被当成缺凭据", async () => {
  const root = await mkdtemp(join(tmpdir(), "daemon-model-"));
  roots.push(root);
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { probe: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-responses",
    models: [{ id: "probe-model", name: "probe", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  await writeFile(join(root, "auth.json"), JSON.stringify({ probe: { type: "api_key", key: "probe-key" } }), { mode: 0o600 });
  process.env.PI_CODING_AGENT_DIR = root;
  const { runtime } = await setupModelRuntime(undefined);
  expect(runtime.getModel("probe", "probe-model")).toBeDefined();
  expect(runtime.hasConfiguredAuth("probe")).toBe(true);
});
