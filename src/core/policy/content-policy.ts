import { posix } from "node:path";

export const PRD_ARCHIVE_PARTS = ["docs", "prd"] as const;
export const PRD_ARCHIVE_DIRECTORY = PRD_ARCHIVE_PARTS.join("/");

// Git 同时排除目录条目和其中任意深度的路径；这些固定规则不会被调用方的附加排除项替换。
export const PRD_ARCHIVE_GIT_PATHSPECS = [
  `:(exclude,literal)${PRD_ARCHIVE_DIRECTORY}`,
  `:(exclude,glob)${PRD_ARCHIVE_DIRECTORY}/**`,
] as const;

export function isPrdArchivePath(repoRelativePath: string): boolean {
  const normalized = posix.normalize(repoRelativePath.replace(/^\.\/+/, ""));
  return normalized === PRD_ARCHIVE_DIRECTORY || normalized.startsWith(`${PRD_ARCHIVE_DIRECTORY}/`);
}
