import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { temporaryRoot } from "../helpers/temporary-root.ts";

test("真实 SDK 从单一扩展入口加载全部命令、工具与生命周期处理器", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "sdk-loading-"));
  try {
    const entry = fileURLToPath(new URL("../../extensions/index.ts", import.meta.url));
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [entry], noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const extension = loaded.extensions[0]!;
    const tools = [...extension.tools.keys()];
    for (const name of ["pi_company_requirement_manage", "pi_company_workflow", "decision_record", "pi_company_dispatch", "pi_company_review", "pi_company_git_commit", "bash"]) expect(tools).toContain(name);
    expect([...extension.commands.keys()]).toContain("pi-company:ps");
    for (const name of ["session_start", "session_shutdown", "tool_call", "user_bash"]) expect(extension.handlers.has(name)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);
