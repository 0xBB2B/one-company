import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import conventionsGuardExtension from "../src/modules/verification/conventions-guard-extension.ts";
import { classifyManagedWritePath, writePathAllowed } from "../src/core/policy/core-permissions.ts";
import { designSpecContext } from "../src/modules/verification/project-conventions.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function repoRoot() {
  const base = await realpath(await mkdtemp(join(temporaryRoot(), "design-spec-"))); roots.push(base);
  await mkdir(join(base, "repo", "docs"), { recursive: true });
  return { base, repo: join(base, "repo") };
}

test("仓库根目录有 DESIGN.md 时给出以来源说明开头、接全文的一块文字", async () => {
  const { repo } = await repoRoot();
  await writeFile(join(repo, "DESIGN.md"), "# 风格\n- 主题：明亮\n\n## 颜色\n- 主色：#112233\n");
  expect(await designSpecContext({ repositoryRoot: repo })).toBe("界面设计规范（来源：仓库根目录 DESIGN.md；界面改动必须遵守）：\n# 风格\n- 主题：明亮\n\n## 颜色\n- 主色：#112233");
});

test("没有 DESIGN.md、内容为空或只有空白时返回 null", async () => {
  const { repo } = await repoRoot();
  expect(await designSpecContext({ repositoryRoot: repo })).toBeNull();
  await writeFile(join(repo, "DESIGN.md"), " \n\n");
  expect(await designSpecContext({ repositoryRoot: repo })).toBeNull();
});

test("子目录里的 DESIGN.md 不算", async () => {
  const { repo } = await repoRoot();
  await writeFile(join(repo, "docs", "DESIGN.md"), "# 风格\n");
  expect(await designSpecContext({ repositoryRoot: repo })).toBeNull();
});

async function guard() {
  const { base, repo } = await repoRoot();
  const other = join(base, "other"); await mkdir(other);
  await symlink(repo, join(base, "link"));
  const pi = createFakePi();
  conventionsGuardExtension(pi.pi, { windowContext: () => ({ workspace: { repos: [{ path: repo, repoId: "a".repeat(64), commonDir: join(repo, ".git") }], skipped: [] } }) });
  const call = (toolName: string, path: string, cwd = repo) =>
    pi.handlersFor("tool_call")[0]!({ type: "tool_call", toolName, input: { path } }, { cwd } as never) as Promise<{ block: true; reason: string } | undefined>;
  return { base, repo, other, call };
}

test("主窗口用 edit 或 write 写已接入仓库根目录的 DESIGN.md 被拒，不分大小写，原因一致", async () => {
  const { base, repo, other, call } = await guard();
  for (const tool of ["edit", "write"]) {
    for (const [path, cwd] of [["DESIGN.md", repo], ["design.md", repo], ["./DESIGN.md", repo], ["@DESIGN.md", repo], [join(repo, "DESIGN.md"), other], [join(base, "link", "design.md"), other]] as const) {
      const result = await call(tool, path, cwd);
      expect(result, `${tool} ${path}`).toMatchObject({ block: true });
      expect(result!.reason).toContain("DESIGN.md 只能随原型通过写入：派原型设计师出一版原型，用户通过后由程序写入");
    }
  }
});

test("根目录已有 DESIGN.md、AGENTS.md 时，用长得像 s 的 ſ 拼的文件名写它们也被拒", async () => {
  const { repo, call } = await guard();
  await writeFile(join(repo, "DESIGN.md"), "# 规范\n");
  await writeFile(join(repo, "AGENTS.md"), "# 规矩\n");
  for (const tool of ["edit", "write"]) {
    expect(await call(tool, "de\u017Fign.md"), `${tool} DESIGN`).toMatchObject({ block: true });
    expect(await call(tool, "agent\u017F.md"), `${tool} AGENTS`).toMatchObject({ block: true });
  }
});

test("读取 DESIGN.md、写子目录或未接入仓库里的 DESIGN.md 都放行", async () => {
  const { other, call } = await guard();
  expect(await call("read", "DESIGN.md")).toBeUndefined();
  expect(await call("write", "docs/DESIGN.md")).toBeUndefined();
  expect(await call("edit", join(other, "DESIGN.md"))).toBeUndefined();
  expect(await call("edit", "DESIGN.md", other)).toBeUndefined();
});

test("仓库根目录的 DESIGN.md 归为 design_spec 且不可写，子目录里的归为 code", () => {
  for (const path of ["DESIGN.md", "design.md", "./DESIGN.md"]) {
    expect(classifyManagedWritePath(path), path).toBe("design_spec");
    expect(writePathAllowed(path), path).toBe(false);
  }
  expect(classifyManagedWritePath("docs/DESIGN.md")).toBe("code");
  expect(writePathAllowed("docs/DESIGN.md")).toBe(true);
});
