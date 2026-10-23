import { afterEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExampleCopyError, copyExampleFiles, inspectExample } from "../src/modules/settings/spec-examples.ts";

const EXAMPLES_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "examples");

const failing = vi.hoisted(() => ({ path: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: vi.fn(async (...args: Parameters<typeof actual.writeFile>) => {
      if (args[0] === failing.path) {
        await actual.writeFile(args[0], "半截", args[2]);
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
      return actual.writeFile(...args);
    }),
  };
});

const roots: string[] = [];

afterEach(async () => {
  failing.path = "";
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function prepare() {
  const root = await mkdtemp(join(tmpdir(), "pi-t-"));
  roots.push(root);
  const targets = { skillsDir: join(root, "skills"), agentsDir: join(root, "agents"), conventionsFile: join(root, "AGENTS.md") };
  const inspection = await inspectExample({ examplesDir: EXAMPLES_DIR, example: "golang", targets });
  return { targets, inspection };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

describe("复制写到一半失败", () => {
  test("磁盘写满：抛 ExampleCopyError，写了一半的文件从目标位置删掉，之前写好的保留", async () => {
    const { targets, inspection } = await prepare();
    const broken = join(targets.skillsDir, "api-design", "SKILL.md");
    failing.path = broken;
    const failure = await copyExampleFiles({ examplesDir: EXAMPLES_DIR, example: "golang", targets, inspection }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExampleCopyError);
    expect((failure as ExampleCopyError).code).toBe("ENOSPC");
    expect(await exists(broken)).toBe(false);
    expect(await exists(join(targets.agentsDir, "go-worker.md"))).toBe(true);
  });

  test("写满失败后再次判定：写坏的文件算未复制，不会被当成被改过", async () => {
    const { targets, inspection } = await prepare();
    const broken = join(targets.skillsDir, "api-design", "SKILL.md");
    failing.path = broken;
    await copyExampleFiles({ examplesDir: EXAMPLES_DIR, example: "golang", targets, inspection }).catch(() => {});
    failing.path = "";
    const again = await inspectExample({ examplesDir: EXAMPLES_DIR, example: "golang", targets });
    const file = again.skills.flatMap((skill) => skill.files).find((f) => f.path === broken);
    expect(file?.state).toBe("missing");
  });

  test("目标位置已有别处写的同名文件：EEXIST 时不删、内容不变，之前写好的保留", async () => {
    const { targets, inspection } = await prepare();
    const other = join(targets.skillsDir, "api-design", "SKILL.md");
    await mkdir(dirname(other), { recursive: true });
    await writeFile(other, "别处刚写的\n");
    const failure = await copyExampleFiles({ examplesDir: EXAMPLES_DIR, example: "golang", targets, inspection }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExampleCopyError);
    expect((failure as ExampleCopyError).code).toBe("EEXIST");
    expect(await readFile(other, "utf8")).toBe("别处刚写的\n");
    expect(await exists(join(targets.agentsDir, "go-worker.md"))).toBe(true);
  });
});
