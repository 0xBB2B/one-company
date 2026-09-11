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
  test("包名为 @0xbb2b/pi-company", async () => {
    const pkg = await readPackageJson();
    expect(pkg.name).toBe("@0xbb2b/pi-company");
  });

  test("pi.prompts 为空数组", async () => {
    const pkg = await readPackageJson();
    expect(pkg.pi?.prompts).toEqual([]);
  });

  test("files 含 agents、daemon、extensions、runtime、rules、skills", async () => {
    const pkg = await readPackageJson();
    for (const entry of ["agents", "daemon", "extensions", "runtime", "rules", "skills"]) {
      expect(pkg.files).toContain(entry);
    }
  });

  test("dependencies 含 typebox", async () => {
    const pkg = await readPackageJson();
    expect(Object.keys(pkg.dependencies ?? {})).toContain("typebox");
  });

  test("peerDependencies 恰为三项且值均为 \"*\"", async () => {
    const pkg = await readPackageJson();
    expect(pkg.peerDependencies).toEqual({
      "@earendil-works/pi-coding-agent": "*",
      "@earendil-works/pi-ai": "*",
      "@earendil-works/pi-tui": "*",
    });
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
  ];

  for (const relativePath of removedFiles) {
    test(`${relativePath} 不存在`, async () => {
      expect(await pathExists(join(PACKAGE_ROOT, relativePath))).toBe(false);
    });
  }
});

describe("旧测试文件不存在", () => {
  const removedTests = [
    "tests/decision-record.test.ts",
    "tests/helpers/requirement-fixture.ts",
    "tests/subagents-preflight.test.ts",
    "tests/acceptance-direct-json.test.ts",
    "tests/git-push-direct-json.test.ts",
    "tests/git-push-auto-repair.test.ts",
    "tests/review-failure-handling.test.ts",
    "tests/spec-flow-auto-repair.test.ts",
    "tests/task-file-line-limit-authoring.test.ts",
    "tests/task-file-line-limit-planning-check.test.ts",
  ];

  for (const relativePath of removedTests) {
    test(`${relativePath} 不存在`, async () => {
      expect(await pathExists(join(PACKAGE_ROOT, relativePath))).toBe(false);
    });
  }
});

test(".gitignore 含 .pi-company/.cache/ 一行", async () => {
  const content = await readFile(join(PACKAGE_ROOT, ".gitignore"), "utf8");
  expect(content.split("\n").map((line) => line.trim())).toContain(".pi-company/.cache/");
});
