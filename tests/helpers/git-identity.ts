import { runGit } from "./git-run.ts";

const IDENTITY_ENV = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];

export async function setLocalIdentity(root: string): Promise<void> {
  await runGit(["config", "user.name", "one-company-test"], root);
  await runGit(["config", "user.email", "one-company-test@example.com"], root);
}

/** 让被测代码里的 git 在 fn 期间找不到任何用户名和邮箱来源。 */
export async function withoutGitIdentity<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of [...IDENTITY_ENV, "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved.set(key, process.env[key]);
  for (const key of IDENTITY_ENV) delete process.env[key];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  await runGit(["config", "--unset-all", "user.name"], root).catch(() => "");
  await runGit(["config", "--unset-all", "user.email"], root).catch(() => "");
  await runGit(["config", "user.useConfigOnly", "true"], root);
  try { return await fn(); }
  finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await setLocalIdentity(root);
    await runGit(["config", "--unset", "user.useConfigOnly"], root);
  }
}
