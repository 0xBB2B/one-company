import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "./git-run.ts";
import { temporaryRoot } from "./temporary-root.ts";

const MANAGED_ENV = ["PATH", "HOME", "GLAB_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "GITLAB_HOST", "GITLAB_URI", "GL_HOST", "FAKE_GH_HOSTS", "FAKE_GH_LOG"];

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_LOG"
case ",$FAKE_GH_HOSTS," in *",$4,"*) exit 0;; esac
exit 1
`;

export async function installFakeGh() {
  const saved: Record<string, string | undefined> = {};
  for (const key of MANAGED_ENV) saved[key] = process.env[key];
  const base = await mkdtemp(join(temporaryRoot(), "fake-gh-"));
  const bin = join(base, "bin"), home = join(base, "home");
  await mkdir(bin);
  await mkdir(home);
  await writeFile(join(bin, "gh"), FAKE_GH);
  await chmod(join(bin, "gh"), 0o755);
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env.HOME = home;
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FAKE_GH_LOG = join(base, "gh.log");
  return {
    ghLoggedIn(hosts: string[]) { process.env.FAKE_GH_HOSTS = hosts.join(","); },
    async glabLoggedIn(hosts: string[]) {
      const dir = join(base, "glab");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "config.yml"), `git_protocol: ssh\nhosts:\n${hosts.map((h) => `  ${h}:\n    token: placeholder\n`).join("")}`);
      process.env.GLAB_CONFIG_DIR = dir;
    },
    async restore() {
      for (const key of MANAGED_ENV) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      await rm(base, { recursive: true, force: true });
    },
  };
}

export async function initRepoWithOrigin(dir: string, origin: string | null): Promise<void> {
  await mkdir(dir, { recursive: true });
  await runGit(["init", "-q"], dir);
  if (origin !== null) await runGit(["remote", "add", "origin", origin], dir);
}
