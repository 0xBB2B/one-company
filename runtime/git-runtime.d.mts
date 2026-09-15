import type { GitFileIdentity, GitTargetIdentity, HostGitBinding } from "./git-prerequisite.mjs";

export type GitRuntimeErrorCode =
  | "git_runtime_uninitialized"
  | "git_runtime_invalid"
  | "git_expectation_invalid"
  | "git_expectation_mismatch";

export class GitRuntimeError extends Error {
  readonly code: GitRuntimeErrorCode;
}

type GitEntryIdentity = GitFileIdentity & { readonly type: "file" | "symlink"; readonly ctimeNs: string };
type GitDirectoryIdentity = GitFileIdentity & { readonly type: "directory"; readonly ctimeNs?: never };
type GitLinkIdentity = GitFileIdentity & { readonly type: "symlink"; readonly ctimeNs: string };

export interface GitExpectation {
  readonly schemaVersion: 1;
  /** 固定Git身份的规范化SHA-256；不包含各进程可不同的排除根，也不构成业务授权。 */
  readonly identityKey: string;
  readonly entryPath: string;
  readonly executablePath: string;
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  /** 严格按原始字符串保留的排除来源；达到总计256项时拒绝追加，不截断。 */
  readonly excludedRootInputs: readonly string[];
  /** 绑定时按文件系统解析的排除根，与原始来源合计最多256项。 */
  readonly excludedRoots: readonly string[];
  readonly entry: GitEntryIdentity;
  readonly target: GitTargetIdentity & { readonly ctimeNs: string };
  readonly canonicalEntryDirectory: string;
  readonly directories: readonly GitDirectoryIdentity[];
  readonly directoryLinks: readonly GitLinkIdentity[];
  readonly fileLinks: readonly GitLinkIdentity[];
}

/**
 * 校验调用方已经解码的普通JSON数据；本函数不负责解析外层JSON文本。
 * 只读取固定白名单中的可枚举数据属性，并拒绝访问器、自定义原型及额外键。
 * 这是数据 schema 边界，不承诺隔离同进程 Proxy 自身的元操作陷阱。
 */
export function parseGitExpectation(value: unknown): GitExpectation;
export function initializeHostGit(excludedRoots: readonly string[]): HostGitBinding;
export function currentHostGit(excludedRoots?: readonly string[]): HostGitBinding;
export function exportGitExpectation(excludedRoots?: readonly string[]): GitExpectation;
/** 仅供受信启动接缝；期望元数据本身不是认证或业务授权。 */
export function initializeInheritedGit(expected: unknown, ownRoots: readonly string[]): HostGitBinding;
