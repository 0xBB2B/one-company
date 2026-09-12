import { posix, resolve } from "node:path";

export const PROD_ARCHIVE_DIRECTORY = "docs/prod";

// Git 同时排除目录条目和其中任意深度的路径；这些固定规则不会被调用方的附加排除项替换。
export const PROD_ARCHIVE_GIT_PATHSPECS = [
  `:(exclude,literal)${PROD_ARCHIVE_DIRECTORY}`,
  `:(exclude,glob)${PROD_ARCHIVE_DIRECTORY}/**`,
] as const;

export function isProdArchivePath(repoRelativePath: string): boolean {
  const normalized = posix.normalize(repoRelativePath.replace(/^\.\/+/, ""));
  return normalized === PROD_ARCHIVE_DIRECTORY || normalized.startsWith(`${PROD_ARCHIVE_DIRECTORY}/`);
}

export function prodArchiveRoot(repoRoot: string): string {
  return resolve(repoRoot, "docs", "prod");
}
