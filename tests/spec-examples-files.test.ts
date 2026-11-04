import { afterEach, describe, expect, test } from "vitest";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXAMPLE_LABELS,
  ExampleCopyError,
  copyExampleFiles,
  examplesDir,
  inspectExample,
  listExamples,
} from "../src/modules/settings/spec-examples.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXAMPLES_DIR = join(PACKAGE_ROOT, "examples");
const GOLANG_SKILLS = [
  "api-design",
  "auth-constraints",
  "authz-constraints",
  "config-constraints",
  "database-constraints",
  "golang-constraints",
  "golang-testing",
  "observability-constraints",
  "service-constraints",
  "version-policy",
];

const roots: string[] = [];

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-t-"));
  roots.push(root);
  return root;
}

function targetsOf(root: string) {
  return {
    skillsDir: join(root, "skills"),
    agentsDir: join(root, "agents"),
  };
}

async function placeFiles(root: string) {
  const targets = targetsOf(root);
  await cp(join(EXAMPLES_DIR, "golang", "skills"), targets.skillsDir, { recursive: true });
  await cp(join(EXAMPLES_DIR, "golang", "agents"), targets.agentsDir, { recursive: true });
  return targets;
}

const inspectGolang = (targets: ReturnType<typeof targetsOf>) =>
  inspectExample({ examplesDir: EXAMPLES_DIR, example: "golang", targets });

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(join(root, "skills"), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

describe("样例列表", () => {
  test("examplesDir 指向包内 examples 目录", () => {
    expect(examplesDir()).toBe(EXAMPLES_DIR);
  });

  test("listExamples 按目录名排序给出 golang 和 vue 及中文名", async () => {
    expect(await listExamples()).toEqual([
      { name: "golang", label: "Go 后端" },
      { name: "vue", label: "Vue 前端" },
    ]);
  });

  test("examples 下每个子目录都有中文名", async () => {
    const entries = await readdir(EXAMPLES_DIR, { withFileTypes: true });
    for (const entry of entries.filter((e) => e.isDirectory())) {
      expect(EXAMPLE_LABELS[entry.name], entry.name).toBeTruthy();
    }
  });
});

describe("inspectExample 状态判定", () => {
  test("空目标：10 个 skill、2 个定义全是 missing，整体未复制", async () => {
    const root = await makeRoot();
    const result = await inspectGolang(targetsOf(root));
    expect(result.skills.map((s) => s.name)).toEqual(GOLANG_SKILLS);
    expect(result.skills.every((s) => s.state === "missing")).toBe(true);
    expect(result.agents.map((a) => a.name).sort()).toEqual(["go-reviewer", "go-worker"]);
    expect(result.agents.every((a) => a.state === "missing")).toBe(true);
    expect(result.overall).toBe("未复制");
  });

  test("skills 和定义都一致：全是 same，整体已复制", async () => {
    const root = await makeRoot();
    const targets = await placeFiles(root);
    const result = await inspectGolang(targets);
    expect(result.skills.every((s) => s.state === "same" && s.files.every((f) => f.state === "same"))).toBe(true);
    expect(result.agents.every((a) => a.state === "same")).toBe(true);
    expect(result.overall).toBe("已复制");
  });

  test("定义的 path 是目标位置绝对路径", async () => {
    const root = await makeRoot();
    const targets = await placeFiles(root);
    const result = await inspectGolang(targets);
    const worker = result.agents.find((a) => a.name === "go-worker");
    expect(worker?.path).toBe(join(targets.agentsDir, "go-worker.md"));
  });

  test("skill 的文件 path 是目标位置绝对路径", async () => {
    const root = await makeRoot();
    const targets = await placeFiles(root);
    const result = await inspectGolang(targets);
    const api = result.skills.find((s) => s.name === "api-design");
    expect(api?.files.map((f) => f.path)).toContain(join(targets.skillsDir, "api-design", "SKILL.md"));
  });

  test("只复制了一部分文件：部分复制", async () => {
    const root = await makeRoot();
    const targets = await placeFiles(root);
    await rm(join(targets.agentsDir, "go-reviewer.md"));
    const result = await inspectGolang(targets);
    expect(result.agents.find((a) => a.name === "go-reviewer")?.state).toBe("missing");
    expect(result.overall).toBe("部分复制");
  });

  test("skill 目录里有的文件没复制：这个 skill 是 missing，整体部分复制", async () => {
    const root = await makeRoot();
    const targets = await placeFiles(root);
    await rm(join(targets.skillsDir, "api-design", "SKILL.md"));
    const result = await inspectGolang(targets);
    expect(result.skills.find((s) => s.name === "api-design")?.state).toBe("missing");
    expect(result.overall).toBe("部分复制");
  });

  test("改动一个 skill 的 SKILL.md：该 skill 为 changed，整体有改动", async () => {
    const root = await makeRoot();
    const targets = await placeFiles(root);
    const file = join(targets.skillsDir, "golang-testing", "SKILL.md");
    await writeFile(file, (await readFile(file, "utf8")) + "\n多一行\n");
    const result = await inspectGolang(targets);
    expect(result.skills.find((s) => s.name === "golang-testing")?.state).toBe("changed");
    expect(result.skills.filter((s) => s.state === "changed")).toHaveLength(1);
    expect(result.overall).toBe("有改动");
  });

  test("定义改动：该定义 changed，整体有改动", async () => {
    const root = await makeRoot();
    const targets = await placeFiles(root);
    await writeFile(join(targets.agentsDir, "go-worker.md"), "改过\n");
    const result = await inspectGolang(targets);
    expect(result.agents.find((a) => a.name === "go-worker")?.state).toBe("changed");
    expect(result.overall).toBe("有改动");
  });

  test("vue 样例的 skills 和定义", async () => {
    const root = await makeRoot();
    const result = await inspectExample({ examplesDir: EXAMPLES_DIR, example: "vue", targets: targetsOf(root) });
    expect(result.skills.map((s) => s.name)).toEqual(["frontend-constraints", "version-policy", "vue-constraints"]);
    expect(result.agents.map((a) => a.name).sort()).toEqual(["vue-reviewer", "vue-worker"]);
    expect(result.overall).toBe("未复制");
  });
});

describe("一个 skill 有多个文件", () => {
  async function makeExample(root: string) {
    const dir = join(root, "examples");
    await mkdir(join(dir, "demo", "skills", "multi", "refs"), { recursive: true });
    await mkdir(join(dir, "demo", "agents"), { recursive: true });
    await writeFile(join(dir, "demo", "skills", "multi", "SKILL.md"), "skill\n");
    await writeFile(join(dir, "demo", "skills", "multi", "refs", "a.md"), "a\n");
    await writeFile(join(dir, "demo", "agents", "demo-worker.md"), "worker\n");
    return dir;
  }

  test("一个文件被改过、另一个缺失：这个 skill 是 changed", async () => {
    const root = await makeRoot();
    const dir = await makeExample(root);
    const targets = targetsOf(join(root, "target"));
    await mkdir(join(targets.skillsDir, "multi"), { recursive: true });
    await writeFile(join(targets.skillsDir, "multi", "SKILL.md"), "改过\n");
    const inspection = await inspectExample({ examplesDir: dir, example: "demo", targets });
    expect(inspection.skills).toHaveLength(1);
    expect(inspection.skills[0]!.state).toBe("changed");
    expect(inspection.overall).toBe("有改动");
  });

  test("子目录里的文件按同一相对路径复制", async () => {
    const root = await makeRoot();
    const dir = await makeExample(root);
    const targets = targetsOf(join(root, "target"));
    const inspection = await inspectExample({ examplesDir: dir, example: "demo", targets });
    await copyExampleFiles({ examplesDir: dir, example: "demo", targets, inspection });
    expect(await readFile(join(targets.skillsDir, "multi", "refs", "a.md"), "utf8")).toBe("a\n");
  });
});

describe("copyExampleFiles", () => {
  test("判定之后目标位置被别处建了同名文件：不覆盖，抛 ExampleCopyError", async () => {
    const root = await makeRoot();
    const targets = targetsOf(root);
    const inspection = await inspectGolang(targets);
    await mkdir(targets.agentsDir, { recursive: true });
    await writeFile(join(targets.agentsDir, "go-worker.md"), "别处刚写的\n");
    const failure = await copyExampleFiles({ examplesDir: EXAMPLES_DIR, example: "golang", targets, inspection }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExampleCopyError);
    expect((failure as ExampleCopyError).code).toBe("EEXIST");
    expect(await readFile(join(targets.agentsDir, "go-worker.md"), "utf8")).toBe("别处刚写的\n");
  });

  test("空目标：写出全部文件，与样例逐字节相同，返回写入的绝对路径", async () => {
    const root = await makeRoot();
    const targets = targetsOf(root);
    const inspection = await inspectGolang(targets);
    const written = await copyExampleFiles({ examplesDir: EXAMPLES_DIR, example: "golang", targets, inspection });
    expect(written.every((p) => p.startsWith(root))).toBe(true);
    expect(written).toContain(join(targets.agentsDir, "go-worker.md"));
    expect(written).toContain(join(targets.skillsDir, "api-design", "SKILL.md"));
    for (const name of GOLANG_SKILLS) {
      const expected = await readFile(join(EXAMPLES_DIR, "golang", "skills", name, "SKILL.md"));
      expect(await readFile(join(targets.skillsDir, name, "SKILL.md"))).toEqual(expected);
    }
    for (const name of ["go-worker", "go-reviewer"]) {
      const expected = await readFile(join(EXAMPLES_DIR, "golang", "agents", `${name}.md`));
      expect(await readFile(join(targets.agentsDir, `${name}.md`))).toEqual(expected);
    }
    const after = await inspectGolang(targets);
    expect(after.skills.every((s) => s.state === "same")).toBe(true);
    expect(after.agents.every((a) => a.state === "same")).toBe(true);
  });

  test("只写 missing 的文件，same 和 changed 的内容与修改时间不变", async () => {
    const root = await makeRoot();
    const targets = await placeFiles(root);
    const changedFile = join(targets.agentsDir, "go-worker.md");
    const sameFile = join(targets.agentsDir, "go-reviewer.md");
    const missingFile = join(targets.skillsDir, "api-design", "SKILL.md");
    await writeFile(changedFile, "用户改过\n");
    await rm(missingFile);
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(changedFile, old, old);
    await utimes(sameFile, old, old);
    const inspection = await inspectGolang(targets);

    const written = await copyExampleFiles({ examplesDir: EXAMPLES_DIR, example: "golang", targets, inspection });

    expect(written).toEqual([missingFile]);
    expect(await readFile(missingFile)).toEqual(await readFile(join(EXAMPLES_DIR, "golang", "skills", "api-design", "SKILL.md")));
    expect(await readFile(changedFile, "utf8")).toBe("用户改过\n");
    expect((await stat(changedFile)).mtimeMs).toBe(old.getTime());
    expect((await stat(sameFile)).mtimeMs).toBe(old.getTime());
  });

  test("目标 skill 目录缺失时一并创建", async () => {
    const root = await makeRoot();
    const targets = await placeFiles(root);
    await rm(join(targets.skillsDir, "version-policy"), { recursive: true });
    const inspection = await inspectGolang(targets);
    const written = await copyExampleFiles({ examplesDir: EXAMPLES_DIR, example: "golang", targets, inspection });
    expect(written).toEqual([join(targets.skillsDir, "version-policy", "SKILL.md")]);
  });

  test("全部已存在时不写任何文件", async () => {
    const root = await makeRoot();
    const targets = await placeFiles(root);
    const inspection = await inspectGolang(targets);
    expect(await copyExampleFiles({ examplesDir: EXAMPLES_DIR, example: "golang", targets, inspection })).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)("写入失败时立刻停下，抛 ExampleCopyError，已写的保留", async () => {
    const root = await makeRoot();
    const targets = targetsOf(root);
    await mkdir(targets.skillsDir, { recursive: true });
    await chmod(targets.skillsDir, 0o555);
    const inspection = await inspectGolang(targets);

    const error = await copyExampleFiles({ examplesDir: EXAMPLES_DIR, example: "golang", targets, inspection }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ExampleCopyError);
    const failure = error as ExampleCopyError;
    expect(["EACCES", "EPERM"]).toContain(failure.code);
    expect(failure.dir.startsWith(targets.skillsDir)).toBe(true);
    const kept = await readdir(targets.agentsDir).catch(() => [] as string[]);
    expect(failure.written).toBe(kept.length);
    for (const name of kept) {
      expect(await readFile(join(targets.agentsDir, name))).toEqual(await readFile(join(EXAMPLES_DIR, "golang", "agents", name)));
    }
    expect(await readdir(targets.skillsDir)).toEqual([]);
  });
});

describe("复制时建目录出错", () => {
  test("skills 目录的位置是个普通文件：抛 ExampleCopyError，不抛其他错误，那个文件不动", async () => {
    const root = await makeRoot();
    const targets = targetsOf(root);
    const inspection = await inspectGolang(targets);
    await writeFile(targets.skillsDir, "别处的文件\n");
    const failure = await copyExampleFiles({ examplesDir: EXAMPLES_DIR, example: "golang", targets, inspection }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExampleCopyError);
    expect(await readFile(targets.skillsDir, "utf8")).toBe("别处的文件\n");
  });
});

describe("样例定义正文声明 auth-session 第 15 条不适用", () => {
  const bodyOf = async (example: string, name: string) => {
    const text = await readFile(join(EXAMPLES_DIR, example, "agents", `${name}.md`), "utf8");
    return text.replace(/^---\n[\s\S]*?\n---\n/, "");
  };

  test.each([
    ["golang", "go-worker"],
    ["golang", "go-reviewer"],
    ["vue", "vue-worker"],
    ["vue", "vue-reviewer"],
  ])("%s/%s 正文写明 auth-session 第 15 条不适用及 localStorage", async (example, name) => {
    const body = await bodyOf(example, name);
    expect(body).toContain("auth-session 第 15 条");
    expect(body).toContain("localStorage");
  });

  test.each(["vue-worker", "vue-reviewer"])("vue/%s 正文写明 refresh token 存在 localStorage", async (name) => {
    expect(await bodyOf("vue", name)).toContain("refresh token 存在 localStorage");
  });
});
