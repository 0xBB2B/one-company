import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { distrustProject, readProjectTrust, trustFilePath, trustProject } from "../src/core/host/project-trust.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function agentDir() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-t-"))); roots.push(root);
  return root;
}

test("授信记录读写：没有记录为 unset，信任后 trusted，不信任后 denied，文件写坏为 unreadable 并带原因", async () => {
  const dir = await agentDir(), repo = join(dir, "repo");
  expect(trustFilePath(dir)).toBe(join(dir, "trust.json"));
  expect(readProjectTrust(dir, repo)).toEqual({ trust: "unset" });
  trustProject(dir, repo);
  expect(readProjectTrust(dir, repo)).toEqual({ trust: "trusted" });
  distrustProject(dir, repo);
  expect(readProjectTrust(dir, repo)).toEqual({ trust: "denied" });
  await writeFile(trustFilePath(dir), '{"a": true,}');
  const read = readProjectTrust(dir, repo);
  expect(read.trust).toBe("unreadable");
  expect(read.reason).toContain("Failed to read trust store");
});

test("src 下除 core/host/project-trust.ts 外没有文件直接使用 ProjectTrustStore", async () => {
  const src = join(import.meta.dirname, "..", "src");
  const files = (await readdir(src, { recursive: true })).filter((name) => name.endsWith(".ts"));
  const offenders: string[] = [];
  for (const file of files) if ((await readFile(join(src, file), "utf8")).includes("ProjectTrustStore")) offenders.push(file);
  expect(offenders).toEqual([join("core", "host", "project-trust.ts")]);
});
