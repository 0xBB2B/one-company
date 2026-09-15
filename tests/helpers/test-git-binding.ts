import { initializeHostGit } from "../../runtime/git-runtime.mjs";
import type { HostGitBinding } from "../../runtime/git-prerequisite.mjs";

/**
 * 仅供明确选择真实测试宿主的夹具调用。导入本模块不会初始化Git，
 * 因而不会掩盖生产入口在未初始化时必须拒绝的行为。
 */
export function initializeTestHostGit(excludedRoots: readonly string[]): HostGitBinding {
  return initializeHostGit(excludedRoots);
}

export function testHostGitExecutable(excludedRoots: readonly string[]): string {
  return initializeTestHostGit(excludedRoots).executablePath;
}
