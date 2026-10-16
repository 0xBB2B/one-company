import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PRD_ARCHIVE_DIRECTORY, PRD_ARCHIVE_PARTS } from "../../core/policy/content-policy.ts";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const WINDOWS_UNSAFE_FILENAME_CHARACTERS = /[<>:"/\\|?*]/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const MAX_FILENAME_BYTES = 255;

export interface CreatedPrdDocument {
  bytes: Uint8Array;
  prdHash: string;
  archivePath: string;
}

export interface ParsedPrdDocument {
  requirementId: string;
  title: string;
  body: string;
}

export interface PrdArchiveInspection {
  paths: string[];
  conflict: boolean;
}

export class RequirementIdentityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RequirementIdentityError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new RequirementIdentityError(code, message);
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") fail("invalid_type", `${name} 必须是字符串`);
}

function assertUnicodeScalarText(value: string, name: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail("invalid_unicode", `${name} 含孤立代理码点`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail("invalid_unicode", `${name} 含孤立代理码点`);
    }
  }
}

function assertRequirementId(requirementId: unknown): asserts requirementId is string {
  assertString(requirementId, "requirementId");
  assertUnicodeScalarText(requirementId, "requirementId");
  if (!UUID_V7_PATTERN.test(requirementId)) {
    fail("invalid_requirement_id", "requirementId 必须是完整的小写 UUIDv7");
  }
}

export function unsafeFilenameKind(name: string): "path" | "control" | null {
  if (name === "." || name === ".." || WINDOWS_UNSAFE_FILENAME_CHARACTERS.test(name)) return "path";
  return CONTROL_CHARACTER.test(name) ? "control" : null;
}

function filenameFor(requirementId: string, title: string): string {
  if (title.length === 0) fail("invalid_archive_title", "归档描述不能为空");
  assertUnicodeScalarText(title, "title");
  const unsafe = unsafeFilenameKind(title);
  if (unsafe === "path") fail("invalid_archive_title", "归档描述含路径分隔符、穿越片段或不支持的文件名字符");
  if (unsafe === "control") fail("invalid_archive_title", "归档描述含控制字符");

  const filename = `${requirementId}.${title}.md`;
  if (Buffer.byteLength(filename, "utf8") > MAX_FILENAME_BYTES) {
    fail("archive_filename_too_long", `归档文件名的 UTF-8 编码不能超过 ${MAX_FILENAME_BYTES} 字节`);
  }
  return filename;
}

export function archivePathFor(requirementId: string, title: string): string {
  assertRequirementId(requirementId);
  assertString(title, "title");
  return `${PRD_ARCHIVE_DIRECTORY}/${filenameFor(requirementId, title)}`;
}

export function prototypeArchivePathFor(requirementId: string, name: string): string {
  return archivePathFor(requirementId, name).replace(/\.md$/, ".html");
}

export function createPrdDocument(requirementId: string, title: string, body: string): CreatedPrdDocument {
  assertRequirementId(requirementId);
  assertString(title, "title");
  assertString(body, "body");
  assertUnicodeScalarText(title, "title");
  assertUnicodeScalarText(body, "body");

  const archivePath = archivePathFor(requirementId, title);
  const source = `---\nrequirementId: ${requirementId}\ntitle: ${JSON.stringify(title)}\n---\n${body}`;
  const bytes = new TextEncoder().encode(source);
  return {
    bytes,
    prdHash: createHash("sha256").update(bytes).digest("hex"),
    archivePath,
  };
}

export function parsePrdDocument(bytes: Uint8Array, expectedRequirementId: string): ParsedPrdDocument {
  assertRequirementId(expectedRequirementId);
  if (!(bytes instanceof Uint8Array)) fail("invalid_type", "bytes 必须是 Uint8Array");

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("invalid_utf8", "PRD 文档不是合法 UTF-8");
  }
  assertUnicodeScalarText(source, "PRD 文档");

  const firstPrefix = "---\nrequirementId: ";
  if (!source.startsWith(firstPrefix)) fail("invalid_prd_format", "PRD 文档 frontmatter 格式无效");
  const requirementEnd = source.indexOf("\n", firstPrefix.length);
  if (requirementEnd < 0) fail("invalid_prd_format", "PRD 文档缺少 title 元数据");
  const requirementId = source.slice(firstPrefix.length, requirementEnd);
  assertRequirementId(requirementId);
  if (requirementId !== expectedRequirementId) {
    fail("requirement_identity_mismatch", "PRD 文档身份与预期 requirementId 不一致");
  }

  const titlePrefix = "title: ";
  const titleStart = requirementEnd + 1;
  if (!source.startsWith(titlePrefix, titleStart)) fail("invalid_prd_format", "PRD 文档 title 元数据格式无效");
  const titleEnd = source.indexOf("\n", titleStart + titlePrefix.length);
  if (titleEnd < 0 || source.slice(titleEnd, titleEnd + 5) !== "\n---\n") {
    fail("invalid_prd_format", "PRD 文档 frontmatter 结束标记无效");
  }

  const encodedTitle = source.slice(titleStart + titlePrefix.length, titleEnd);
  let title: unknown;
  try {
    title = JSON.parse(encodedTitle);
  } catch {
    fail("invalid_prd_format", "PRD 文档 title 不是合法 JSON 字符串");
  }
  if (typeof title !== "string" || JSON.stringify(title) !== encodedTitle) {
    fail("invalid_prd_format", "PRD 文档 title 必须使用固定的 JSON 双引号编码");
  }
  assertUnicodeScalarText(title, "title");
  archivePathFor(requirementId, title);

  const body = source.slice(titleEnd + 5);
  assertUnicodeScalarText(body, "body");
  return { requirementId, title, body };
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sameObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function requiredDirectory(path: string, label: string, allowMissing: boolean): Promise<Stats | undefined> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (allowMissing && missing(error)) return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("unsafe_archive_directory", `${label} 必须是真实目录，不能是链接或其他文件类型`);
  }
  return stats;
}

async function assertDirectoryUnchanged(path: string, before: Stats, label: string): Promise<void> {
  const after = await requiredDirectory(path, label, false);
  if (!after || !sameObject(before, after)) fail("archive_directory_changed", `${label} 在枚举期间发生变化`);
}

export async function inspectPrdArchives(
  workspaceRoot: string,
  requirementId: string,
): Promise<PrdArchiveInspection> {
  assertRequirementId(requirementId);
  assertString(workspaceRoot, "workspaceRoot");
  if (!isAbsolute(workspaceRoot)) fail("invalid_workspace_root", "workspaceRoot 必须是绝对路径");

  const requestedRoot = resolve(workspaceRoot);
  const rootStats = await requiredDirectory(requestedRoot, "workspaceRoot", false);
  if (!rootStats) fail("invalid_workspace_root", "workspaceRoot 不存在");
  const root = await realpath(requestedRoot);

  const docsPath = join(root, PRD_ARCHIVE_PARTS[0]);
  const docsStats = await requiredDirectory(docsPath, "docs", true);
  if (!docsStats) return { paths: [], conflict: false };
  const actualDocs = await realpath(docsPath);
  if (actualDocs !== docsPath || !pathWithin(root, actualDocs)) {
    fail("archive_directory_escape", "docs 目录链接或越过 workspaceRoot");
  }

  const prdPath = join(docsPath, PRD_ARCHIVE_PARTS[1]);
  const prdStats = await requiredDirectory(prdPath, PRD_ARCHIVE_DIRECTORY, true);
  if (!prdStats) return { paths: [], conflict: false };
  const actualPrd = await realpath(prdPath);
  if (actualPrd !== prdPath || !pathWithin(root, actualPrd)) {
    fail("archive_directory_escape", `${PRD_ARCHIVE_DIRECTORY} 目录链接或越过 workspaceRoot`);
  }

  const entries = await readdir(prdPath, { withFileTypes: true });
  const prefix = `${requirementId}.`;
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    if (entry.name.endsWith(".html") && entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) {
      fail("invalid_archive_entry", "完整 requirementId 对应的归档名格式无效");
    }
    const title = entry.name.slice(prefix.length, -".md".length);
    const archivePath = archivePathFor(requirementId, title);
    if (archivePath !== `${PRD_ARCHIVE_DIRECTORY}/${entry.name}`) {
      fail("invalid_archive_entry", "归档路径格式冲突");
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      fail("unsafe_archive_entry", "对应归档必须是真实普通文件");
    }
    const entryStats = await lstat(join(prdPath, entry.name));
    if (entryStats.isSymbolicLink() || !entryStats.isFile()) {
      fail("unsafe_archive_entry", "对应归档必须是真实普通文件");
    }
    paths.push(archivePath);
  }

  await assertDirectoryUnchanged(prdPath, prdStats, PRD_ARCHIVE_DIRECTORY);
  await assertDirectoryUnchanged(docsPath, docsStats, "docs");
  await assertDirectoryUnchanged(requestedRoot, rootStats, "workspaceRoot");
  paths.sort();
  return { paths, conflict: paths.length > 1 };
}
