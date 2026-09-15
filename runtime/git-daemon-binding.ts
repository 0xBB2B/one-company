import {
  currentHostGit,
  exportGitExpectation,
  parseGitExpectation,
} from "./git-runtime.mjs";

export const GIT_EXPECTATION_MAX_BYTES = 64 * 1024;

export type GitExpectation = ReturnType<typeof parseGitExpectation>;

export class GitDaemonBindingError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitDaemonBindingError";
    this.code = code;
  }
}

function bindingError(code: string, message: string, cause?: unknown): never {
  throw new GitDaemonBindingError(code, message, cause === undefined ? undefined : { cause });
}

function checkedText(value: unknown): string {
  if (typeof value !== "string") bindingError("git_expectation_invalid", "Git 期望必须是完整 JSON 文本");
  const size = Buffer.byteLength(value, "utf8");
  if (size === 0 || size > GIT_EXPECTATION_MAX_BYTES) {
    bindingError("git_expectation_invalid", `Git 期望文本大小无效: ${size} 字节`);
  }
  return value;
}

export function decodeGitExpectation(textValue: unknown): GitExpectation {
  const text = checkedText(textValue);
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    bindingError("git_expectation_invalid", "Git 期望不是有效 JSON", error);
  }
  try {
    return parseGitExpectation(decoded);
  } catch (error) {
    throw error;
  }
}

export function encodeGitExpectation(value: unknown): string {
  const parsed = parseGitExpectation(value);
  let text: string;
  try {
    text = JSON.stringify(parsed);
  } catch (error) {
    bindingError("git_expectation_invalid", "Git 期望无法编码", error);
  }
  return checkedText(text);
}

export function gitExpectationRoots(expectation: GitExpectation): string[] {
  return [...new Set([...expectation.excludedRootInputs, ...expectation.excludedRoots])];
}

export function assertExpectationRetainsRoots(expectation: GitExpectation, requiredRoots: readonly string[]): void {
  const retained = new Set(gitExpectationRoots(expectation));
  for (const root of requiredRoots) {
    if (!retained.has(root)) {
      bindingError("git_expectation_mismatch", `Git 期望缺少已请求根: ${root}`);
    }
  }
}

export function currentGitBinding(roots: readonly string[]): void {
  currentHostGit([...roots]);
}

export function createGitExpectationText(roots: readonly string[]): string {
  currentHostGit([...roots]);
  return encodeGitExpectation(exportGitExpectation([...roots]));
}

export interface VerifiedPeerGitBinding {
  readonly peer: GitExpectation;
  readonly merged: GitExpectation;
  readonly mergedText: string;
  readonly roots: readonly string[];
}

export function verifyPeerGitBinding(
  peerText: unknown,
  ownRoots: readonly string[],
  requiredPeerRoots: readonly string[] = [],
): VerifiedPeerGitBinding {
  const peer = decodeGitExpectation(peerText);
  currentHostGit([...ownRoots]);
  const own = parseGitExpectation(exportGitExpectation([...ownRoots]));
  if (own.identityKey !== peer.identityKey) {
    bindingError("git_expectation_mismatch", "Git 固定身份与对端不一致");
  }
  assertExpectationRetainsRoots(peer, requiredPeerRoots);
  const roots = [...new Set([...gitExpectationRoots(peer), ...ownRoots])];
  currentHostGit(roots);
  const merged = parseGitExpectation(exportGitExpectation(roots));
  const mergedText = encodeGitExpectation(merged);
  return Object.freeze({ peer, merged, mergedText, roots: Object.freeze([...roots]) });
}

export function isGitBindingFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("git_") || code === "untrusted_git");
}
