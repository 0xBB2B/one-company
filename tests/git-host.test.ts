import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDeliveryMode, ghLoggedIn, glabLoggedIn, originHost, providerForHost } from "../src/core/exec/git-host.ts";
import { runGit } from "./helpers/git-run.ts";

const MANAGED_ENV = ["PATH", "HOME", "GLAB_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN", "GITLAB_HOST", "GITLAB_URI", "GL_HOST", "FAKE_GH_HOSTS", "FAKE_GH_LOG"];
const saved: Record<string, string | undefined> = {};
const cleanups: string[] = [];
let base = "";
let bin = "";

const FAKE_GH = `#!/bin/sh
echo "$*" >> "$FAKE_GH_LOG"
case ",$FAKE_GH_HOSTS," in *",$4,"*) exit 0;; esac
exit 1
`;

beforeEach(async () => {
  for (const key of MANAGED_ENV) saved[key] = process.env[key];
  base = await realpath(await mkdtemp(join(tmpdir(), "git-host-")));
  cleanups.push(base);
  bin = join(base, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), FAKE_GH);
  await chmod(join(bin, "gh"), 0o755);
  const home = join(base, "home");
  await mkdir(home);
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env.HOME = home;
  process.env.PATH = `${bin}:${saved.PATH}`;
  process.env.FAKE_GH_LOG = join(base, "gh.log");
});

afterEach(async () => {
  for (const key of MANAGED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repoWithOrigin(origin: string | null): Promise<string> {
  const repo = await mkdtemp(join(base, "repo-"));
  await runGit(["init", "-q"], repo);
  if (origin !== null) await runGit(["remote", "add", "origin", origin], repo);
  return repo;
}

async function writeGlabConfig(dir: string, hosts: string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.yml"), `git_protocol: ssh\nhosts:\n${hosts.map((h) => `  ${h}:\n    token: placeholder\n`).join("")}`);
}

describe("originHost", () => {
  test("scp 写法 git@github.com:acme/shop.git 得到 github.com", async () => {
    expect(await originHost(await repoWithOrigin("git@github.com:acme/shop.git"))).toBe("github.com");
  });

  test("ssh 写法带端口时去掉端口", async () => {
    expect(await originHost(await repoWithOrigin("ssh://git@code.example.com:2222/acme/shop.git"))).toBe("code.example.com");
  });

  test("https 写法的主机名转小写", async () => {
    expect(await originHost(await repoWithOrigin("https://GitLab.Example.com/acme/shop.git"))).toBe("gitlab.example.com");
  });

  test("没有 origin 返回 null", async () => {
    expect(await originHost(await repoWithOrigin(null))).toBeNull();
  });

  test("ssh:// 前缀加 scp 冒号的错误写法解析不了时返回 null 不抛错", async () => {
    expect(await originHost(await repoWithOrigin("ssh://git@github.com:acme/shop.git"))).toBeNull();
  });

  test("origin 是本地路径返回 null", async () => {
    expect(await originHost(await repoWithOrigin(join(base, "somewhere", "bare.git")))).toBeNull();
  });
});

describe("ghLoggedIn", () => {
  test("假 gh 只认 github.com 时，github.com 登录过、其他主机没有", async () => {
    process.env.FAKE_GH_HOSTS = "github.com";
    expect(await ghLoggedIn("github.com")).toBe(true);
    expect(await ghLoggedIn("code.example.com")).toBe(false);
  });

  test("调用 gh 的参数是 auth token --hostname <主机>", async () => {
    process.env.FAKE_GH_HOSTS = "github.com";
    await ghLoggedIn("code.example.com");
    expect((await readFile(process.env.FAKE_GH_LOG!, "utf8")).trim()).toBe("auth token --hostname code.example.com");
  });

  test("PATH 里没有 gh 时返回 false 不抛错", async () => {
    process.env.PATH = join(base, "empty-bin");
    expect(await ghLoggedIn("github.com")).toBe(false);
  });
});

describe("glabLoggedIn", () => {
  test("GLAB_CONFIG_DIR 的 config.yml 里 hosts 下有该主机时登录过", async () => {
    await writeGlabConfig(join(base, "glab"), ["code.example.com"]);
    process.env.GLAB_CONFIG_DIR = join(base, "glab");
    expect(await glabLoggedIn("code.example.com")).toBe(true);
  });

  test("hosts 下没有该主机时没登录", async () => {
    await writeGlabConfig(join(base, "glab"), ["gitlab.com"]);
    process.env.GLAB_CONFIG_DIR = join(base, "glab");
    expect(await glabLoggedIn("code.example.com")).toBe(false);
  });

  test("主机条目的 token 为空时没登录（glab 首次运行生成的默认条目）", async () => {
    const dir = join(base, "glab-empty");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "config.yml"), "hosts:\n    gitlab.com:\n        api_host: gitlab.com\n        # Your GitLab access token.\n        token:\n        api_protocol: https\n    code.example.com:\n        token: glpat-x\n");
    process.env.GLAB_CONFIG_DIR = dir;
    expect(await glabLoggedIn("gitlab.com")).toBe(false);
    expect(await glabLoggedIn("code.example.com")).toBe(true);
  });

  test("config.yml 读不了（是个目录）时当作没登录，不抛错", async () => {
    const dir = join(base, "glab-broken");
    await mkdir(join(dir, "config.yml"), { recursive: true });
    process.env.GLAB_CONFIG_DIR = dir;
    expect(await glabLoggedIn("code.example.com")).toBe(false);
  });

  test("配置文件不存在时没登录", async () => {
    process.env.GLAB_CONFIG_DIR = join(base, "nothing-here");
    expect(await glabLoggedIn("code.example.com")).toBe(false);
  });

  test("GLAB_CONFIG_DIR 的文件存在时优先于 ~/.config/glab-cli", async () => {
    await writeGlabConfig(join(base, "glab"), ["gitlab.com"]);
    await writeGlabConfig(join(process.env.HOME!, ".config", "glab-cli"), ["code.example.com"]);
    process.env.GLAB_CONFIG_DIR = join(base, "glab");
    expect(await glabLoggedIn("code.example.com")).toBe(false);
  });

  test("GLAB_CONFIG_DIR 下没有文件时取 ~/.config/glab-cli/config.yml", async () => {
    await writeGlabConfig(join(process.env.HOME!, ".config", "glab-cli"), ["code.example.com"]);
    process.env.GLAB_CONFIG_DIR = join(base, "nothing-here");
    expect(await glabLoggedIn("code.example.com")).toBe(true);
  });

  test("以上都没有时取 XDG_CONFIG_HOME/glab-cli/config.yml", async () => {
    await writeGlabConfig(join(base, "xdg", "glab-cli"), ["code.example.com"]);
    process.env.XDG_CONFIG_HOME = join(base, "xdg");
    expect(await glabLoggedIn("code.example.com")).toBe(true);
  });

  test("只设 GITLAB_TOKEN 时 gitlab.com 登录过、code.example.com 没有", async () => {
    process.env.GITLAB_TOKEN = "placeholder";
    expect(await glabLoggedIn("gitlab.com")).toBe(true);
    expect(await glabLoggedIn("code.example.com")).toBe(false);
  });

  test("设了 GITLAB_HOST（URL）后环境变量令牌属于该主机", async () => {
    process.env.GITLAB_TOKEN = "placeholder";
    process.env.GITLAB_HOST = "https://code.example.com";
    expect(await glabLoggedIn("code.example.com")).toBe(true);
    expect(await glabLoggedIn("gitlab.com")).toBe(false);
  });

  test("GITLAB_ACCESS_TOKEN 与 OAUTH_TOKEN 同样算登录过", async () => {
    process.env.GITLAB_ACCESS_TOKEN = "placeholder";
    expect(await glabLoggedIn("gitlab.com")).toBe(true);
    delete process.env.GITLAB_ACCESS_TOKEN;
    process.env.OAUTH_TOKEN = "placeholder";
    expect(await glabLoggedIn("gitlab.com")).toBe(true);
  });

  test("GITLAB_HOST 未设时回退 GITLAB_URI", async () => {
    process.env.GITLAB_TOKEN = "placeholder";
    process.env.GITLAB_URI = "https://code.example.com";
    expect(await glabLoggedIn("code.example.com")).toBe(true);
    expect(await glabLoggedIn("gitlab.com")).toBe(false);
  });

  test("GITLAB_HOST 与 GITLAB_URI 都未设时回退 GL_HOST", async () => {
    process.env.GITLAB_TOKEN = "placeholder";
    process.env.GL_HOST = "code.example.com";
    expect(await glabLoggedIn("code.example.com")).toBe(true);
  });
});

describe("providerForHost", () => {
  test("gh 登录过得到 gh，即使 glab 也登录过", async () => {
    process.env.FAKE_GH_HOSTS = "code.example.com";
    await writeGlabConfig(join(base, "glab"), ["code.example.com"]);
    process.env.GLAB_CONFIG_DIR = join(base, "glab");
    expect(await providerForHost("code.example.com")).toBe("gh");
  });

  test("只有 glab 登录过得到 glab", async () => {
    await writeGlabConfig(join(base, "glab"), ["code.example.com"]);
    process.env.GLAB_CONFIG_DIR = join(base, "glab");
    expect(await providerForHost("code.example.com")).toBe("glab");
  });

  test("都没登录得到 null", async () => {
    expect(await providerForHost("code.example.com")).toBeNull();
  });
});

describe("detectDeliveryMode", () => {
  test("gh 登录过 origin 主机 → remote + gh", async () => {
    process.env.FAKE_GH_HOSTS = "code.example.com";
    const repo = await repoWithOrigin("https://code.example.com/acme/shop.git");
    expect(await detectDeliveryMode(repo)).toEqual({ mode: "remote", host: "code.example.com", provider: "gh" });
  });

  test("只有 glab 登录过 → remote + glab", async () => {
    await writeGlabConfig(join(base, "glab"), ["code.example.com"]);
    process.env.GLAB_CONFIG_DIR = join(base, "glab");
    const repo = await repoWithOrigin("https://code.example.com/acme/shop.git");
    expect(await detectDeliveryMode(repo)).toEqual({ mode: "remote", host: "code.example.com", provider: "glab" });
  });

  test("都没登录 → local，provider 为 null", async () => {
    const repo = await repoWithOrigin("https://code.example.com/acme/shop.git");
    expect(await detectDeliveryMode(repo)).toEqual({ mode: "local", host: "code.example.com", provider: null });
  });

  test("没有 origin → local，host 为 null", async () => {
    process.env.FAKE_GH_HOSTS = "code.example.com";
    const repo = await repoWithOrigin(null);
    expect(await detectDeliveryMode(repo)).toEqual({ mode: "local", host: null, provider: null });
  });
});
