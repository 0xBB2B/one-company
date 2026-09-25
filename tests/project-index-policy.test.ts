import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { chmodSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { temporaryRoot } from "./helpers/temporary-root.ts";

const archiveIoProbe = vi.hoisted(() => ({
  enabled: false,
  openedArchiveFiles: [] as string[],
  bodyReadCalls: 0,
}));
const gitIoProbe = vi.hoisted(() => ({
  enabled: false,
  opens: [] as string[],
  enumerations: [] as string[],
}));
const markerProbe = vi.hoisted(() => ({
  enabled: false,
  calls: [] as Array<{ path: string; options: unknown }>,
  asyncCalls: 0,
  before: undefined as ((path: string, call: number) => void) | undefined,
}));
const metadataProbe = vi.hoisted(() => ({
  enabled: false,
  calls: [] as Array<{ api: string; path: string; options: unknown }>,
  before: undefined as ((api: string, path: string) => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      const path = String(args[0]);
      if (metadataProbe.enabled) {
        metadataProbe.calls.push({ api: "lstatSync", path, options: args[1] });
        metadataProbe.before?.("lstatSync", path);
      }
      if (markerProbe.enabled && /\/\.git$/i.test(path)) {
        markerProbe.calls.push({ path, options: args[1] });
        markerProbe.before?.(path, markerProbe.calls.length);
      }
      return Reflect.apply(actual.lstatSync, actual, args);
    },
    realpathSync: (...args: Parameters<typeof actual.realpathSync>) => {
      const path = String(args[0]);
      if (metadataProbe.enabled) {
        metadataProbe.calls.push({ api: "realpathSync", path, options: args[1] });
        metadataProbe.before?.("realpathSync", path);
      }
      const result = Reflect.apply(actual.realpathSync, actual, args);
      if (ancestorSwapProbe.armed && path === ancestorSwapProbe.triggerFile) {
        ancestorSwapProbe.armed = false;
        ancestorSwapProbe.triggeredBy = "realpathSync";
        actual.renameSync(ancestorSwapProbe.ancestor, ancestorSwapProbe.movedAncestor);
        actual.symlinkSync(ancestorSwapProbe.outside, ancestorSwapProbe.ancestor, "dir");
      }
      return result;
    },
  };
});
const ancestorSwapProbe = vi.hoisted(() => ({
  armed: false,
  triggerFile: "",
  triggeredBy: "",
  ancestor: "",
  movedAncestor: "",
  outside: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (metadataProbe.enabled) {
        metadataProbe.calls.push({ api: "lstat", path: String(args[0]), options: args[1] });
        metadataProbe.before?.("lstat", String(args[0]));
      }
      if (markerProbe.enabled && /\/\.git$/i.test(String(args[0]))) markerProbe.asyncCalls++;
      return Reflect.apply(actual.lstat, actual, args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      if (gitIoProbe.enabled && path.split("/").some((part) => part.toLowerCase() === ".git")) gitIoProbe.opens.push(path);
      if (archiveIoProbe.enabled && /\/docs\/prod\//i.test(path)) archiveIoProbe.openedArchiveFiles.push(path);
      const handle = await actual.open(...args);
      if (!archiveIoProbe.enabled) return handle;
      return new Proxy(handle, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (property === "read") {
            return async (...readArgs: unknown[]) => {
              archiveIoProbe.bodyReadCalls += 1;
              return Reflect.apply(value as (...args: unknown[]) => unknown, target, readArgs);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      const path = String(args[0]);
      if (gitIoProbe.enabled && path.split("/").some((part) => part.toLowerCase() === ".git")) gitIoProbe.enumerations.push(path);
      return actual.opendir(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      if (metadataProbe.enabled) {
        metadataProbe.calls.push({ api: "realpath", path: String(args[0]), options: args[1] });
        metadataProbe.before?.("realpath", String(args[0]));
      }
      const result = await actual.realpath(...args);
      if (ancestorSwapProbe.armed && String(args[0]) === ancestorSwapProbe.triggerFile) {
        ancestorSwapProbe.armed = false;
        ancestorSwapProbe.triggeredBy = "realpath";
        await actual.rename(ancestorSwapProbe.ancestor, ancestorSwapProbe.movedAncestor);
        await actual.symlink(ancestorSwapProbe.outside, ancestorSwapProbe.ancestor, "dir");
      }
      return result;
    },
  };
});

const {
  DEFAULT_INDEX_LIMITS,
  ProjectIndexPolicyError,
  classifyIndexWatchEvent,
  readIndexFile,
  scanIndexWorkspace,
} = await import("../runtime/project-index-policy.ts");

const REQUIREMENT_ID = "0197b7b0-6a20-7c51-8a32-b9465fb72d10";
const roots: string[] = [];
const servers: Server[] = [];

async function privateDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(temporaryRoot(), prefix));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

async function fixture(): Promise<{ root: string; dataRoot: string }> {
  return {
    root: await privateDirectory("project-index-workspace-"),
    dataRoot: await privateDirectory("project-index-data-"),
  };
}

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

function skippedReason(result: Awaited<ReturnType<typeof scanIndexWorkspace>>, path: string): string | undefined {
  return result.skipped.find((entry) => entry.path === path)?.reason;
}

afterEach(async () => {
  metadataProbe.enabled = false;
  metadataProbe.calls.length = 0;
  metadataProbe.before = undefined;
  ancestorSwapProbe.triggeredBy = "";
  markerProbe.enabled = false;
  markerProbe.calls.length = 0;
  markerProbe.asyncCalls = 0;
  markerProbe.before = undefined;
  archiveIoProbe.enabled = false;
  gitIoProbe.enabled = false;
  gitIoProbe.opens.length = 0;
  gitIoProbe.enumerations.length = 0;
  archiveIoProbe.openedArchiveFiles.length = 0;
  archiveIoProbe.bodyReadCalls = 0;
  ancestorSwapProbe.armed = false;
  ancestorSwapProbe.triggerFile = "";
  ancestorSwapProbe.ancestor = "";
  ancestorSwapProbe.movedAncestor = "";
  ancestorSwapProbe.outside = "";
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

test("M2-AC1/5/7：混合文件确定分类，大小写 prod 只列直接路径且正文零打开", async () => {
  const { root, dataRoot } = await fixture();
  await put(root, "src/主程序.ts", "export const answer = 42;\r\n");
  await put(root, "src/view.tsx", "export const View = () => <main />;\n");
  await put(root, "web/client.js", "export function run() {}\n");
  await put(root, "web/client.jsx", "export const node = <div />;\n");
  await put(root, "cmd/main.go", "package main\nfunc main() {}\n");
  await put(root, "docs/spec/schema.json", "{ invalid schema is still a current source");
  await put(root, "docs/spec/player.rules.json", "{}\r\n");
  await put(root, "README.md", "项目说明\n");
  await put(root, "package.json", "{}\n");
  await put(root, "tools/check.py", "print('file-level only')\n");

  const archiveDirectory = join(root, "DoCs", "PrOd");
  await mkdir(archiveDirectory, { recursive: true });
  const archiveRelative = relative(root, await realpath(archiveDirectory)).split(sep).join("/");
  await writeFile(join(archiveDirectory, `${REQUIREMENT_ID}.完成需求.md`), "PROD_SECRET_NEVER_OPEN");
  await writeFile(join(archiveDirectory, `${REQUIREMENT_ID}.恶意\n名称.bin`), "ANOTHER_SECRET");
  await writeFile(join(archiveDirectory, "not-a-uuid.md"), "INVALID_SECRET");
  await mkdir(join(archiveDirectory, "nested"));
  await writeFile(join(archiveDirectory, "nested", "hidden.md"), "NESTED_SECRET");

  await put(root, "node_modules/pkg/index.js", "dependency secret");
  await put(root, "DIST/generated.js", "generated secret");
  await put(root, ".env.production", "TOKEN=secret");
  await put(root, "credentials.json", "secret");
  await put(root, "state/index.db", "sqlite bytes");
  await put(root, "state/index.db-wal", "wal bytes");
  await put(root, "logs/run.log", "log bytes");

  archiveIoProbe.enabled = true;
  const result = await scanIndexWorkspace({ root, dataRoot });
  archiveIoProbe.enabled = false;

  expect(result.root).toBe(root);
  expect(result.files).toEqual([
    { path: "README.md", kind: "document", language: null, size: Buffer.byteLength("项目说明\n") },
    { path: "cmd/main.go", kind: "code", language: "go", size: Buffer.byteLength("package main\nfunc main() {}\n") },
    { path: "docs/spec/player.rules.json", kind: "spec", language: null, size: 4 },
    { path: "docs/spec/schema.json", kind: "schema", language: null, size: Buffer.byteLength("{ invalid schema is still a current source") },
    { path: "package.json", kind: "config", language: null, size: 3 },
    { path: "src/view.tsx", kind: "code", language: "tsx", size: Buffer.byteLength("export const View = () => <main />;\n") },
    { path: "src/主程序.ts", kind: "code", language: "ts", size: Buffer.byteLength("export const answer = 42;\r\n") },
    { path: "tools/check.py", kind: "unsupported", language: null, size: Buffer.byteLength("print('file-level only')\n") },
    { path: "web/client.js", kind: "code", language: "js", size: Buffer.byteLength("export function run() {}\n") },
    { path: "web/client.jsx", kind: "code", language: "jsx", size: Buffer.byteLength("export const node = <div />;\n") },
  ]);
  expect(result.archives).toEqual([
    { path: `${archiveRelative}/${REQUIREMENT_ID}.完成需求.md`, requirementId: REQUIREMENT_ID },
    { path: `${archiveRelative}/${REQUIREMENT_ID}.恶意\n名称.bin`, requirementId: REQUIREMENT_ID },
    { path: `${archiveRelative}/nested`, requirementId: null },
    { path: `${archiveRelative}/not-a-uuid.md`, requirementId: null },
  ]);
  expect(archiveIoProbe.openedArchiveFiles).toEqual([]);
  expect(archiveIoProbe.bodyReadCalls).toBe(0);
  expect(skippedReason(result, archiveRelative)).toBe("prod_archive");
  expect(skippedReason(result, "node_modules")).toBe("excluded_directory");
  expect(skippedReason(result, "DIST")).toBe("excluded_directory");
  expect(skippedReason(result, ".env.production")).toBe("sensitive");
  expect(skippedReason(result, "credentials.json")).toBe("sensitive");
  expect(skippedReason(result, "state/index.db")).toBe("database");
  expect(skippedReason(result, "state/index.db-wal")).toBe("database");
  expect(skippedReason(result, "logs")).toBe("excluded_directory");
  expect(result.files.some((file) => file.path.toLowerCase().startsWith("docs/prod/"))).toBe(false);
});

test.each([".git", ".giT", ".gIt", ".gIT", ".Git", ".GiT", ".GIt", ".GIT"].flatMap((name) =>
  (["file", "directory"] as const).map((kind) => ({ name, kind })),
))("M3-AC1/3：$name $kind 在正文打开和 Git 内部枚举前排除", async ({ name, kind }) => {
  const { root, dataRoot } = await fixture();
  await put(root, "main.ts", "export function main() {}\n");
  if (kind === "file") await put(root, name, "gitdir: /not-an-index-input/GIT_POINTER_SENTINEL\n");
  else await put(root, `${name}/config`, "GIT_INTERNAL_SENTINEL");

  gitIoProbe.enabled = true;
  const result = await scanIndexWorkspace({ root, dataRoot });
  expect(result.files.map((file) => file.path)).toEqual(["main.ts"]);
  expect(skippedReason(result, name)).toBe(kind === "file" ? "excluded_file" : "excluded_directory");
  expect(result.watchDirectories).toEqual(["."]);
  expect(classifyIndexWatchEvent(name)).toBe("ignored");
  expect(classifyIndexWatchEvent(`${name}/config`)).toBe("ignored");
  for (const file of [name, { path: name, size: 1 }]) {
    expect(await readIndexFile(root, file, { readUnsupported: true })).toEqual({ status: "skipped", path: name, reason: "excluded_file" });
  }
  expect(await readIndexFile(root, `${name}/config`, { readUnsupported: true })).toEqual({
    status: "skipped", path: `${name}/config`, reason: "excluded_directory",
  });
  expect(gitIoProbe.opens).toEqual([]);
  expect(gitIoProbe.enumerations).toEqual([]);
});

test("M2-AC5：没有 docs/spec、本机需求记录或数据库时仍可只建代码文件清单", async () => {
  const { root, dataRoot } = await fixture();
  await put(root, "main.ts", "export {};\n");

  const result = await scanIndexWorkspace({ root, dataRoot });

  expect(result.files).toEqual([{ path: "main.ts", kind: "code", language: "ts", size: 11 }]);
  expect(result.archives).toEqual([]);
  expect(await readdir(dataRoot)).toEqual([]);
  expect(result.partial).toBe(false);
  expect(result.budget.stoppedReason).toBe("complete");
});

test("被 Git 忽略的文件与目录不进入索引，标 git_ignored；不在仓库内时照常扫描", async () => {
  const { root, dataRoot } = await fixture();
  await put(root, "main.ts", "export {};\n");
  await put(root, ".gitignore", "generated/\n*.local.ts\n");
  await put(root, "generated/out.ts", "export {};\n");
  await put(root, "secret.local.ts", "export {};\n");
  expect((await scanIndexWorkspace({ root, dataRoot })).files.map((file) => file.path)).toContain("generated/out.ts");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const result = await scanIndexWorkspace({ root, dataRoot });
  expect(result.files.map((file) => file.path)).not.toContain("generated/out.ts");
  expect(result.files.map((file) => file.path)).not.toContain("secret.local.ts");
  expect(result.files.map((file) => file.path)).toContain("main.ts");
  expect(skippedReason(result, "generated")).toBe("git_ignored");
  expect(skippedReason(result, "secret.local.ts")).toBe("git_ignored");
});

test("M2-AC1：链接、硬链接、特殊文件和嵌套仓库不被跟随或读取", async () => {
  const { root, dataRoot } = await fixture();
  const outside = await privateDirectory("project-index-outside-");
  await put(outside, "outside.ts", "export const secret = true;\n");
  await symlink(join(outside, "outside.ts"), join(root, "linked.ts"));
  await symlink(outside, join(root, "linked-dir"), "dir");
  await link(join(outside, "outside.ts"), join(root, "hard-linked.ts"));
  await put(root, "unreadable.ts", "no read permission");
  await chmod(join(root, "unreadable.ts"), 0o000);
  await put(root, "nested-repo/.GiT/config", "do not inspect");
  await put(root, "nested-repo/source.ts", "export const nested = true;\n");

  const socketPath = join(root, "service.socket");
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));

  const result = await scanIndexWorkspace({ root, dataRoot });
  await chmod(join(root, "unreadable.ts"), 0o600);

  expect(skippedReason(result, "linked.ts")).toBe("symbolic_link");
  expect(skippedReason(result, "linked-dir")).toBe("symbolic_link");
  expect(skippedReason(result, "hard-linked.ts")).toBe("hard_link");
  expect(skippedReason(result, "unreadable.ts")).toBe("unreadable");
  expect(skippedReason(result, "service.socket")).toBe("special_file");
  expect(skippedReason(result, "nested-repo")).toBe("nested_repository");
  expect(await readIndexFile(root, "nested-repo/source.ts")).toEqual({
    status: "skipped",
    path: "nested-repo/source.ts",
    reason: "nested_repository",
  });
  expect(result.files).toEqual([]);
});

test("M2-AC1/4：文件、总文本、条目和深度预算耗尽时明确 partial，不假报完整", async () => {
  const fileBudget = await fixture();
  await put(fileBudget.root, "a.ts", "12345");
  await put(fileBudget.root, "b.ts", "67890");
  await put(fileBudget.root, "large.ts", "x".repeat(9));
  const limited = await scanIndexWorkspace({
    ...fileBudget,
    limits: { maxFileBytes: 8, maxTotalTextBytes: 7 },
  });
  expect(limited.files.map((file) => file.path)).toEqual(["a.ts"]);
  expect(skippedReason(limited, "b.ts")).toBe("total_text_limit");
  expect(skippedReason(limited, "large.ts")).toBe("file_too_large");
  expect(limited.partial).toBe(true);
  expect(limited.budget.exhausted).toEqual(["file_bytes", "total_text_bytes"]);

  const unknownBudget = await fixture();
  await put(unknownBudget.root, "a.py", "12345");
  await put(unknownBudget.root, "b.ts", "67890");
  const unknownLimited = await scanIndexWorkspace({ ...unknownBudget, limits: { maxTotalTextBytes: 7 } });
  expect(unknownLimited.files).toEqual([{ path: "a.py", kind: "unsupported", language: null, size: 5 }]);
  expect(skippedReason(unknownLimited, "b.ts")).toBe("total_text_limit");
  expect(unknownLimited.budget.used.textBytes).toBe(5);

  const entryBudget = await fixture();
  await put(entryBudget.root, "a.ts", "a");
  await put(entryBudget.root, "b.ts", "b");
  await put(entryBudget.root, "c.ts", "c");
  const entryLimited = await scanIndexWorkspace({ ...entryBudget, limits: { maxEntries: 2 } });
  expect(entryLimited.files).toEqual([]);
  expect(entryLimited.partial).toBe(true);
  expect(entryLimited.budget.stoppedReason).toBe("entry_limit");
  expect(skippedReason(entryLimited, ".")).toBe("entry_limit");

  const depthBudget = await fixture();
  await put(depthBudget.root, "one/two/deep.ts", "deep");
  const depthLimited = await scanIndexWorkspace({ ...depthBudget, limits: { maxDepth: 1 } });
  expect(depthLimited.files).toEqual([]);
  expect(skippedReason(depthLimited, "one/two")).toBe("depth_limit");
  expect(depthLimited.partial).toBe(true);
  expect(depthLimited.budget.exhausted).toEqual(["depth"]);
});

test("M2-AC4：取消在确定的循环边界生效并保留已完成的部分结果", async () => {
  const { root, dataRoot } = await fixture();
  await put(root, "a.ts", "a");
  await put(root, "b.ts", "b");
  const controller = new AbortController();

  const result = await scanIndexWorkspace({
    root,
    dataRoot,
    signal: controller.signal,
    onProgress(progress) {
      if (progress.path === "a.ts") controller.abort();
    },
  });

  expect(result.files.map((file) => file.path)).toEqual(["a.ts"]);
  expect(result.partial).toBe(true);
  expect(result.budget.stoppedReason).toBe("cancelled");
  expect(result.skipped.some((entry) => entry.reason === "cancelled")).toBe(true);
});

test("M2-AC1/7：正文读取保留 Unicode/CRLF 和字节 hash，并拒绝归档、二进制、非法 UTF-8 与超限", async () => {
  const { root, dataRoot } = await fixture();
  const source = "第一行😀\r\n第二行\r\n";
  const pythonSource = "print('file-level hash only')\n";
  await put(root, "unicode.txt", source);
  await put(root, "binary.txt", Uint8Array.from([0x61, 0x00, 0x62]));
  await put(root, "invalid.txt", Uint8Array.from([0xc3, 0x28]));
  await put(root, "large.txt", "123456");
  await put(root, "script.py", pythonSource);
  await put(root, "binary.py", Uint8Array.from([0x70, 0x79, 0x00]));
  await put(root, `docs/prod/${REQUIREMENT_ID}.secret.md`, "NEVER_READ_THIS_PROD");
  const scan = await scanIndexWorkspace({ root, dataRoot });
  const unicode = scan.files.find((file) => file.path === "unicode.txt")!;

  const read = await readIndexFile(root, unicode);
  expect(read).toEqual({
    status: "success",
    path: "unicode.txt",
    content: source,
    size: Buffer.byteLength(source),
    sha256: createHash("sha256").update(Buffer.from(source)).digest("hex"),
  });
  expect(await readIndexFile(root, "binary.txt")).toEqual({ status: "skipped", path: "binary.txt", reason: "binary" });
  expect(await readIndexFile(root, "invalid.txt")).toEqual({ status: "skipped", path: "invalid.txt", reason: "invalid_utf8" });
  expect(await readIndexFile(root, "large.txt", { maxBytes: 5 })).toEqual({ status: "skipped", path: "large.txt", reason: "file_too_large" });
  expect(await readIndexFile(root, "script.py")).toEqual({ status: "skipped", path: "script.py", reason: "unsupported" });
  expect(await readIndexFile(root, "script.py", { readUnsupported: true })).toEqual({
    status: "success",
    path: "script.py",
    content: pythonSource,
    size: Buffer.byteLength(pythonSource),
    sha256: createHash("sha256").update(Buffer.from(pythonSource)).digest("hex"),
  });
  expect(await readIndexFile(root, "binary.py", { readUnsupported: true })).toEqual({
    status: "skipped",
    path: "binary.py",
    reason: "binary",
  });
  expect(scan.files.find((file) => file.path === "script.py")?.kind).toBe("unsupported");

  archiveIoProbe.enabled = true;
  const archiveRead = await readIndexFile(root, `docs/prod/${REQUIREMENT_ID}.secret.md`);
  archiveIoProbe.enabled = false;
  expect(archiveRead).toEqual({
    status: "skipped",
    path: `docs/prod/${REQUIREMENT_ID}.secret.md`,
    reason: "prod_archive",
  });
  expect(archiveIoProbe.openedArchiveFiles).toEqual([]);
});

test("M2-AC4：扫描后文件变化返回 unstable，读取取消返回固定状态", async () => {
  const { root, dataRoot } = await fixture();
  await put(root, "changing.ts", "old");
  const scan = await scanIndexWorkspace({ root, dataRoot });
  const indexed = scan.files.find((file) => file.path === "changing.ts")!;
  await writeFile(join(root, "changing.ts"), "new content with another size");

  expect(await readIndexFile(root, indexed)).toEqual({ status: "unstable", path: "changing.ts", reason: "unstable" });

  const controller = new AbortController();
  controller.abort();
  expect(await readIndexFile(root, "changing.ts", { signal: controller.signal })).toEqual({
    status: "skipped",
    path: "changing.ts",
    reason: "cancelled",
  });
});

test("M2-AC1/4：文件 realpath 后祖先被换成外部链接时不读取或返回外部正文", async () => {
  const { root, dataRoot } = await fixture();
  const outside = await privateDirectory("project-index-race-outside-");
  const insideSource = "export const origin = 'inside';\n";
  const outsideSecret = "OUTSIDE_CONTENT_MUST_NOT_ENTER_RESULT\n";
  await put(root, "src/a.ts", insideSource);
  await put(outside, "a.ts", outsideSecret);
  const scan = await scanIndexWorkspace({ root, dataRoot });
  const indexed = scan.files.find((file) => file.path === "src/a.ts")!;

  ancestorSwapProbe.armed = true;
  ancestorSwapProbe.triggerFile = join(root, "src", "a.ts");
  ancestorSwapProbe.ancestor = join(root, "src");
  ancestorSwapProbe.movedAncestor = join(root, "src-before-swap");
  ancestorSwapProbe.outside = outside;
  archiveIoProbe.enabled = true;
  const result = await readIndexFile(root, indexed);
  archiveIoProbe.enabled = false;

  expect(ancestorSwapProbe.armed).toBe(false);
  expect(ancestorSwapProbe.triggeredBy).toBe("realpathSync");
  expect(result).toEqual({ status: "unstable", path: "src/a.ts", reason: "unstable" });
  expect(JSON.stringify(result)).not.toContain(outsideSecret.trim());
  expect(archiveIoProbe.bodyReadCalls).toBe(0);
});

const MARKER_NAMES = [".git", ".giT", ".gIt", ".gIT", ".Git", ".GiT", ".GIt", ".GIT"];

test.each(MARKER_NAMES.flatMap((name) =>
  (["file", "directory", "dangling-link"] as const).map((kind) => ({ name, kind })),
))("M3-PERF-FS-01：嵌套 $name $kind 在正文读取前拒绝", async ({ name, kind }) => {
  const { root, dataRoot } = await fixture();
  await put(root, "src/main.ts", "NESTED_BODY_MUST_NOT_READ");
  const marker = join(root, "src", name);
  if (kind === "file") await writeFile(marker, "gitdir: /outside");
  else if (kind === "directory") await mkdir(marker);
  else await symlink(join(root, "absent-target"), marker);
  archiveIoProbe.enabled = true;
  gitIoProbe.enabled = true;
  const scan = await scanIndexWorkspace({ root, dataRoot });
  expect(skippedReason(scan, "src")).toBe("nested_repository");
  expect(await readIndexFile(root, "src/main.ts")).toEqual({ status: "skipped", path: "src/main.ts", reason: "nested_repository" });
  expect(archiveIoProbe.bodyReadCalls).toBe(0);
  expect(gitIoProbe.opens).toEqual([]);
  expect(gitIoProbe.enumerations).toEqual([]);
});

test("M3-PERF-FS-01：每个祖先读取边界完整探测八个名称，不跨边界或调用缓存缺失", async () => {
  const { root } = await fixture();
  await put(root, "src/main.ts", "export const value = 1;\n");
  markerProbe.enabled = true;
  expect((await readIndexFile(root, "src/main.ts")).status).toBe("success");
  // 捕获祖先一次，九次读取边界复核；文件内容读取、根与祖先身份检查仍执行。
  expect(markerProbe.calls).toEqual(Array.from({ length: 10 }, () => MARKER_NAMES.map((name) => ({
    path: join(root, "src", name), options: { throwIfNoEntry: false },
  }))).flat());
  expect(markerProbe.asyncCalls).toBe(0);
  await writeFile(join(root, "src/.GIT"), "gitdir: /outside");
  expect(await readIndexFile(root, "src/main.ts")).toMatchObject({ status: "skipped", reason: "nested_repository" });
});

test.each(Array.from({ length: 9 }, (_, index) => index + 2))(
  "M3-PERF-FS-01：第 %i 次祖先检查出现 Git marker 时不得返回正文", async (boundary) => {
    const { root } = await fixture();
    await put(root, "src/main.ts", "RACE_CONTENT_MUST_NOT_RETURN");
    markerProbe.enabled = true;
    markerProbe.before = (_path, call) => {
      if (call === (boundary - 1) * 8 + 1) writeFileSync(join(root, "src/.git"), "gitdir: /outside");
    };
    const result = await readIndexFile(root, "src/main.ts");
    expect(result).toEqual({ status: "unstable", path: "src/main.ts", reason: "unstable" });
    expect(markerProbe.calls).toHaveLength(boundary * 8 - 7);
    expect(JSON.stringify(result)).not.toContain("RACE_CONTENT_MUST_NOT_RETURN");
  },
);

test.each(["EACCES", "EPERM", "EMFILE", "ENFILE", "ENOTDIR", "EIO"])(
  "M3-PERF-FS-01：Git 探测 %s 不是正常缺失，不继续放行或泄漏错误正文", async (code) => {
    const { root } = await fixture();
    await put(root, "src/main.ts", "BODY_MUST_NOT_READ");
    markerProbe.enabled = true;
    markerProbe.before = (_path, call) => {
      if (call === 4) throw Object.assign(new Error("PRIVATE_ERROR_DETAIL"), { code });
    };
    archiveIoProbe.enabled = true;
    expect(await readIndexFile(root, "src/main.ts")).toEqual({
      status: "skipped", path: "src/main.ts", reason: ["EACCES", "EPERM", "EMFILE", "ENFILE"].includes(code) ? "unreadable" : "unstable",
    });
    expect(markerProbe.calls).toHaveLength(4);
    expect(archiveIoProbe.bodyReadCalls).toBe(0);
  },
);

test("M3-PERF-FS-01：真实目录撤权后 Git 探测不能把 EACCES 当缺失", async () => {
  const { root } = await fixture();
  await put(root, "src/main.ts", "PRIVATE_BODY");
  markerProbe.enabled = true;
  markerProbe.before = (_path, call) => { if (call === 1) chmodSync(join(root, "src"), 0o000); };
  try {
    expect(await readIndexFile(root, "src/main.ts")).toEqual({ status: "skipped", path: "src/main.ts", reason: "unreadable" });
    expect(markerProbe.calls).toHaveLength(1);
  } finally { await chmod(join(root, "src"), 0o700); }
});

test.each(["directory", "link"] as const)("M3-PERF-FS-01：第八次探测前祖先被替换成 %s 时身份核验拒绝", async (kind) => {
  const { root } = await fixture();
  await put(root, "src/main.ts", "ORIGINAL_CONTENT");
  const outside = await privateDirectory("project-index-replacement-");
  await put(outside, "main.ts", "REPLACEMENT_CONTENT_MUST_NOT_READ");
  markerProbe.enabled = true;
  markerProbe.before = (_path, call) => {
    if (call !== 8) return;
    renameSync(join(root, "src"), join(root, "moved"));
    if (kind === "link") symlinkSync(outside, join(root, "src"), "dir");
    else {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/main.ts"), "REPLACEMENT_CONTENT_MUST_NOT_READ");
    }
  };
  archiveIoProbe.enabled = true;
  expect(await readIndexFile(root, "src/main.ts")).toEqual({ status: "unstable", path: "src/main.ts", reason: "unstable" });
  expect(archiveIoProbe.bodyReadCalls).toBe(0);
});

test("M3-PERF-FS-01：元数据探测期间收到取消在原正文读取边界生效", async () => {
  const { root } = await fixture();
  await put(root, "src/main.ts", "CANCELLED_BODY");
  const controller = new AbortController();
  markerProbe.enabled = true;
  markerProbe.before = (_path, call) => { if (call === 1) controller.abort(); };
  archiveIoProbe.enabled = true;
  expect(await readIndexFile(root, "src/main.ts", { signal: controller.signal })).toEqual({
    status: "skipped", path: "src/main.ts", reason: "cancelled",
  });
  expect(archiveIoProbe.bodyReadCalls).toBe(0);
});

test("M3-PERF-FS-01：读取元数据同步且调用数不减少，扫描仍经过异步元数据探针", async () => {
  const { root, dataRoot } = await fixture();
  await put(root, "src/main.ts", "export const value = 1;\n");
  metadataProbe.enabled = true;
  expect((await scanIndexWorkspace({ root, dataRoot })).files).toHaveLength(1);
  expect(metadataProbe.calls.some((call) => call.api === "lstat")).toBe(true);
  expect(metadataProbe.calls.some((call) => call.api === "realpath")).toBe(true);
  expect(metadataProbe.calls.some((call) => call.api.endsWith("Sync")
    && [join(root, "src"), join(root, "src/main.ts")].includes(call.path))).toBe(false);
  metadataProbe.calls.length = 0;
  archiveIoProbe.enabled = true;
  expect((await readIndexFile(root, "src/main.ts")).status).toBe("success");
  expect(archiveIoProbe.bodyReadCalls).toBe(2);
  expect(metadataProbe.calls.filter((call) => call.api === "lstat" || call.api === "realpath")).toEqual([]);
  expect(metadataProbe.calls.filter((call) => call.api === "lstatSync" && !/\/\.git$/i.test(call.path))).toHaveLength(26);
  expect(metadataProbe.calls.filter((call) => call.api === "realpathSync")).toHaveLength(21);
  expect(metadataProbe.calls.filter((call) => call.api === "lstatSync" && call.path === join(root, "src/main.ts")))
    .toEqual(Array.from({ length: 4 }, () => ({ api: "lstatSync", path: join(root, "src/main.ts"), options: { bigint: true } })));
});

test.each(Array.from({ length: 9 }, (_, index) => index + 1).flatMap((boundary) =>
  (["directory", "link", "marker"] as const).map((kind) => ({ boundary, kind })),
))("M3-PERF-FS-01：九次元数据边界 $boundary / $kind 替换仍拒绝", async ({ boundary, kind }) => {
  const { root } = await fixture();
  const ancestor = join(root, "src");
  await put(root, "src/main.ts", "INSIDE_BODY_MUST_NOT_RETURN");
  const outside = await privateDirectory("project-index-boundary-");
  await put(outside, "main.ts", "OUTSIDE_BODY_MUST_NOT_RETURN");
  let visits = 0;
  metadataProbe.enabled = true;
  metadataProbe.before = (api, path) => {
    if (api !== "lstatSync" || path !== ancestor || ++visits !== boundary + 2) return;
    if (kind === "marker") writeFileSync(join(ancestor, ".git"), "gitdir: /outside");
    else {
      renameSync(ancestor, join(root, "moved"));
      if (kind === "link") symlinkSync(outside, ancestor, "dir");
      else { mkdirSync(ancestor); writeFileSync(join(ancestor, "main.ts"), "OUTSIDE_BODY_MUST_NOT_RETURN"); }
    }
  };
  archiveIoProbe.enabled = true;
  expect(await readIndexFile(root, "src/main.ts")).toEqual({ status: "unstable", path: "src/main.ts", reason: "unstable" });
  expect(visits).toBe(boundary + 2);
  if (boundary <= 5) expect(archiveIoProbe.bodyReadCalls).toBe(0);
});

test.each(["lstatSync", "realpathSync"].flatMap((api) => ["capture", "verify"].flatMap((phase) =>
  ["EACCES", "EPERM", "EMFILE", "ENFILE", "ENOENT", "EIO"].map((code) => ({ api, phase, code })),
)))("M3-PERF-FS-01：$api / $phase / $code 保留拒绝分类", async ({ api, phase, code }) => {
  const { root } = await fixture();
  await put(root, "src/main.ts", "ERROR_BODY_MUST_NOT_READ");
  let visits = 0;
  metadataProbe.enabled = true;
  metadataProbe.before = (actualApi, path) => {
    if (actualApi !== api || path !== join(root, "src")) return;
    const trigger = phase === "capture" ? 1 : api === "lstatSync" ? 3 : 2;
    if (++visits === trigger) throw Object.assign(new Error("PRIVATE_ERROR_DETAIL"), { code });
  };
  archiveIoProbe.enabled = true;
  expect(await readIndexFile(root, "src/main.ts")).toEqual({
    status: phase === "capture" ? "skipped" : "unstable", path: "src/main.ts",
    reason: phase === "capture" && ["EACCES", "EPERM", "EMFILE", "ENFILE"].includes(code) ? "unreadable" : "unstable",
  });
  expect(visits).toBeGreaterThan(0);
  expect(archiveIoProbe.bodyReadCalls).toBe(0);
});

test.each(["lstat", "realpath"])("M3-PERF-FS-01：异步扫描 %s 故障探针仍有效", async (api) => {
  const { root, dataRoot } = await fixture();
  await put(root, "src/main.ts", "SCAN_BODY_MUST_NOT_READ");
  let injected = false;
  metadataProbe.enabled = true;
  metadataProbe.before = (actualApi, path) => {
    if (actualApi === api && path === join(root, "src")) { injected = true; throw Object.assign(new Error("private"), { code: "EACCES" }); }
  };
  archiveIoProbe.enabled = true;
  const result = await scanIndexWorkspace({ root, dataRoot });
  expect(injected).toBe(true);
  expect(result.files).toEqual([]);
  expect(skippedReason(result, "src")).toBe("unreadable");
  expect(archiveIoProbe.bodyReadCalls).toBe(0);
});

test("M3-PERF-FS-01：64层祖先逐次核验且65层仍拒绝", async () => {
  const { root } = await fixture();
  const path = `${Array.from({ length: 64 }, (_, index) => `d${index}`).join("/")}/main.ts`;
  await put(root, path, "export {};\n");
  markerProbe.enabled = true;
  expect((await readIndexFile(root, path)).status).toBe("success");
  expect(markerProbe.calls).toHaveLength(64 * 10 * 8);
  await expect(readIndexFile(root, `extra/${path}`)).rejects.toMatchObject({ code: "invalid_path" });
});

test("M2-AC1：dataRoot 必须与 worktree 分离，项目内数据根与链接入口均不能扫描", async () => {
  const { root, dataRoot } = await fixture();
  await mkdir(join(root, "local-data"));
  await expect(scanIndexWorkspace({ root, dataRoot: join(root, "local-data") })).rejects.toMatchObject({
    name: "ProjectIndexPolicyError",
    code: "data_root_overlap",
  });

  await put(dataRoot, "private.ts", "secret");
  await symlink(dataRoot, join(root, "data-link"), "dir");
  await expect(scanIndexWorkspace({ root, dataRoot: join(root, "data-link") })).rejects.toMatchObject({
    code: "data_root_overlap",
  });
  const scan = await scanIndexWorkspace({ root, dataRoot });
  expect(skippedReason(scan, "data-link")).toBe("symbolic_link");
  expect(scan.files).toEqual([]);
});

test("安全预算只允许缩小，路径读取不能穿越或改用非 POSIX 表达", async () => {
  const { root, dataRoot } = await fixture();
  await put(root, "main.ts", "export {};\n");

  await expect(scanIndexWorkspace({
    root,
    dataRoot,
    limits: { maxEntries: DEFAULT_INDEX_LIMITS.maxEntries + 1 },
  })).rejects.toBeInstanceOf(ProjectIndexPolicyError);
  await expect(readIndexFile(root, "../outside.ts")).rejects.toMatchObject({ code: "invalid_path" });
  await expect(readIndexFile(root, "dir\\file.ts")).rejects.toMatchObject({ code: "invalid_path" });
  await expect(readIndexFile(root, "main.ts", { maxBytes: DEFAULT_INDEX_LIMITS.maxFileBytes + 1 })).rejects.toMatchObject({
    code: "invalid_limits",
  });
});
