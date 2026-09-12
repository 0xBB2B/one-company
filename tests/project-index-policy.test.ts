import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
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
import { temporaryRoot } from "./helpers/temporary-root.ts";

const archiveIoProbe = vi.hoisted(() => ({
  enabled: false,
  openedArchiveFiles: [] as string[],
  bodyReadCalls: 0,
}));
const ancestorSwapProbe = vi.hoisted(() => ({
  armed: false,
  triggerFile: "",
  ancestor: "",
  movedAncestor: "",
  outside: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
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
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const result = await actual.realpath(...args);
      if (ancestorSwapProbe.armed && String(args[0]) === ancestorSwapProbe.triggerFile) {
        ancestorSwapProbe.armed = false;
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
  archiveIoProbe.enabled = false;
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
  expect(result).toEqual({ status: "unstable", path: "src/a.ts", reason: "unstable" });
  expect(JSON.stringify(result)).not.toContain(outsideSecret.trim());
  expect(archiveIoProbe.bodyReadCalls).toBe(0);
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
