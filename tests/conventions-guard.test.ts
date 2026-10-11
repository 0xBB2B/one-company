import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import conventionsGuardExtension from "../extensions/conventions-guard.ts";
import { classifyManagedWritePath, writePathAllowed } from "../runtime/core-permissions.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function guard() {
  const base = await realpath(await mkdtemp(join(temporaryRoot(), "conventions-guard-"))); roots.push(base);
  const repo = join(base, "repo"), other = join(base, "other");
  await mkdir(join(repo, "docs"), { recursive: true }); await mkdir(other);
  await symlink(repo, join(base, "link"));
  const pi = createFakePi();
  conventionsGuardExtension(pi.pi, { windowContext: () => ({ workspace: { repos: [{ path: repo, repoId: "a".repeat(64), commonDir: join(repo, ".git") }], skipped: [] } }) });
  const call = (toolName: string, path: string, cwd = repo) =>
    pi.handlersFor("tool_call")[0]!({ type: "tool_call", toolName, input: { path } }, { cwd } as never) as Promise<{ block: true; reason: string } | undefined>;
  return { base, repo, other, call };
}

test("M8D2-AC4：主窗口用 edit 或 write 写已接入仓库根目录的 AGENTS.md 被拒，并提示改用 conventions-update", async () => {
  const { base, repo, other, call } = await guard();
  for (const tool of ["edit", "write"]) {
    for (const [path, cwd] of [["AGENTS.md", repo], ["./AGENTS.md", repo], ["@AGENTS.md", repo], ["agents.md", repo], [join(repo, "AGENTS.md"), other],
      ["../repo/AGENTS.md", other], [join(base, "link", "AGENTS.md"), other]] as const) {
      const result = await call(tool, path, cwd);
      expect(result, `${tool} ${path}`).toMatchObject({ block: true });
      expect(result!.reason).toContain("one_company_project_manage conventions-update");
    }
  }
});

test("M8D2-AC4：读取 AGENTS.md、写别的文件、写子目录或别处的 AGENTS.md 都放行", async () => {
  const { repo, other, call } = await guard();
  expect(await call("read", "AGENTS.md")).toBeUndefined();
  expect(await call("write", "README.md")).toBeUndefined();
  expect(await call("write", "docs/AGENTS.md")).toBeUndefined();
  expect(await call("edit", join(other, "AGENTS.md"))).toBeUndefined();
  expect(await call("edit", "AGENTS.md", other)).toBeUndefined();
  expect(await call("write", join(repo, "docs", "AGENTS.md"), other)).toBeUndefined();
});

test("M8D2-AC4：子代理的受控写入与 PM 的提交仍把仓库根目录的 AGENTS.md 归为不可写", () => {
  expect(classifyManagedWritePath("AGENTS.md")).toBe("project_conventions");
  expect(writePathAllowed("AGENTS.md")).toBe(false);
});
