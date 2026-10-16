import { describe, expect, test } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

async function readPackageJson(): Promise<Record<string, any>> {
  const raw = await readFile(join(PACKAGE_ROOT, "package.json"), "utf8");
  return JSON.parse(raw);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("package.json 声明契约", () => {
  test("包名为 @0xbb2b/one-company", async () => {
    const pkg = await readPackageJson();
    expect(pkg.name).toBe("@0xbb2b/one-company");
  });

  test("pi.prompts 为空数组", async () => {
    const pkg = await readPackageJson();
    expect(pkg.pi?.prompts).toEqual([]);
  });

  test("files 含 agents、src、rules、role-rules、shared", async () => {
    const pkg = await readPackageJson();
    for (const entry of ["agents", "src", "rules", "role-rules", "shared"]) {
      expect(pkg.files).toContain(entry);
    }
  });

  test("dependencies 不含任何宿主提供的包", async () => {
    const pkg = await readPackageJson();
    const hostPackages = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@sinclair/typebox", "typebox"];
    for (const name of hostPackages) expect(pkg.dependencies ?? {}).not.toHaveProperty(name);
  });

  test("peerDependencies 恰为四项且值均为 \"*\"", async () => {
    const pkg = await readPackageJson();
    expect(pkg.peerDependencies).toEqual({
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-tui": "*",
      typebox: "*",
    });
  });

  test("devDependencies.typebox 与 pi 1.2.0 自带版本一致", async () => {
    const pkg = await readPackageJson();
    expect(pkg.devDependencies?.typebox).toBe("1.3.27");
  });

  test("engines.node 为 >=22.19.0", async () => {
    const pkg = await readPackageJson();
    expect(pkg.engines?.node).toBe(">=22.19.0");
  });
});

describe("被替代文件不存在", () => {
  const removedFiles = [
    "extensions/agents-bridge.ts",
    "extensions/subagents-preflight.ts",
    "prompts/spec-new.md",
    "prompts/spec-resume.md",
    "prompts/spec-revise.md",
    "prompts/spec-sync.md",
    "agents/acceptance-reviewer.md",
    "agents/impl-engineer.md",
    "agents/pre-reviewer.md",
    "agents/review-engineer.md",
    "agents/test-engineer.md",
    "skills/spec-docs/scripts/decision-ledger.ts",
    "extensions/write-protection.ts",
    "extensions/workflow.ts",
    "extensions/decision-record.ts",
    "extensions/relay.ts",
    "runtime/range-protection.ts",
    "runtime/git-commit-tool.ts",
    "runtime/delivery.ts",
    "runtime/result.ts",
    "runtime/transcript-view.ts",
    "runtime/workflow-state.ts",
    "runtime/workflow-tool.ts",
    "runtime/decisions.ts",
    "runtime/decision-record-tool.ts",
    "rules/01-task-routing.md",
    "rules/04-decision-record.md",
    "rules/05-review-failure-handling.md",
    "rules/06-dispatch-boundary.md",
    "skills/spec-flow",
    "skills/spec-revise",
    "skills/spec-sync",
    "skills/spec-docs",
    "skills/git-push",
    "skills/git-commit",
  ];

  for (const relativePath of removedFiles) {
    test(`${relativePath} 不存在`, async () => {
      expect(await pathExists(join(PACKAGE_ROOT, relativePath))).toBe(false);
    });
  }
});
