export type GitPrerequisiteErrorCode =
  | "git_invalid_configuration"
  | "git_not_found"
  | "git_unsafe"
  | "git_binding_untrusted"
  | "git_changed"
  | "git_version_failed"
  | "git_version_invalid"
  | "git_version_timeout"
  | "git_version_output_limit";

export class GitPrerequisiteError extends Error {
  readonly code: GitPrerequisiteErrorCode;
}

export interface GitFileIdentity {
  readonly path: string;
  readonly type: "file" | "symlink" | "directory";
  readonly dev: string;
  readonly ino: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  /** 仅文件/链接记录ctime，普通目录通过路径、inode、owner和权限核验。 */
  readonly ctimeNs?: string;
}

export interface GitTargetIdentity extends GitFileIdentity {
  readonly type: "file";
  readonly sha256: string;
}

/**
 * 仅由 resolveHostGit 在当前进程建立的宿主绑定。
 * JSON 或环境变量反序列化出的同形对象不会被 assertGitCurrent 接受。
 */
export interface HostGitBinding {
  readonly entryPath: string;
  readonly executablePath: string;
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  /** 建立绑定时按真实文件系统语义解析的排除目录。 */
  readonly excludedRoots: readonly string[];
  /** 保留原始输入，后续复核重新解析目录别名；原排除范围同时保留。 */
  readonly excludedRootInputs: readonly string[];
  readonly entry: GitFileIdentity;
  readonly target: GitTargetIdentity;
  /** PATH 目录解析后的真实目录；运行时会与目录链接一起重新核对。 */
  readonly canonicalEntryDirectory: string;
  /** PATH 目录及最终目标目录的真实祖先身份。 */
  readonly directories: readonly GitFileIdentity[];
  /** PATH/目标目录解析途中遇到的符号链接身份。 */
  readonly directoryLinks: readonly GitFileIdentity[];
  /** Git文件本身逐跳解析遇到的链接，含中间文件链接。 */
  readonly fileLinks: readonly GitFileIdentity[];
}

export interface ResolveHostGitOptions {
  /** 可信宿主启动 PATH；不应来自模型、项目配置或工具参数。 */
  readonly path?: string;
  /** 可信调用方提供的业务 worktree/dataRoot 绝对路径。 */
  readonly excludedRoots?: readonly string[];
}

export interface GitVersionCheck {
  readonly version: string;
  readonly executablePath: string;
  readonly binding: HostGitBinding;
}

export function parseMacOsAdminGroup(contents: string): number;
export function readMacOsAdminGroup(readGroupFile?: () => string): number;
export function resolveHostGit(options?: ResolveHostGitOptions): HostGitBinding;
export function checkGitVersion(binding: HostGitBinding): GitVersionCheck;
export function assertGitCurrent(
  binding: HostGitBinding,
  excludedRoots?: readonly string[],
): HostGitBinding;
