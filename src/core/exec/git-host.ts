import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitIn } from "./target-branch.ts";

const execFileAsync = promisify(execFile);

export type DeliveryMode = "remote" | "local";
export type GitProvider = "gh" | "glab";

export async function originHost(cwd: string): Promise<string | null> {
  const url = await gitIn(cwd, ["remote", "get-url", "origin"]).then((r) => r.stdout.trim(), () => "");
  if (url.includes("://")) {
    try { return new URL(url).hostname.toLowerCase() || null; } catch { return null; }
  }
  return /^(?:[^@/:]+@)?([^@/:]+):/.exec(url)?.[1]?.toLowerCase() ?? null;
}

export async function ghLoggedIn(host: string): Promise<boolean> {
  try {
    await execFileAsync("gh", ["auth", "token", "--hostname", host], {
      timeout: 10_000,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    return true;
  } catch {
    return false;
  }
}

function glabConfigPath(): string | null {
  const env = process.env;
  const home = homedir();
  const xdgHome = env.XDG_CONFIG_HOME
    ?? (process.platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config"));
  const dirs = [
    env.GLAB_CONFIG_DIR,
    join(home, ".config", "glab-cli"),
    join(xdgHome, "glab-cli"),
    ...(env.XDG_CONFIG_DIRS || "/etc/xdg").split(":").map((d) => join(d, "glab-cli")),
  ];
  for (const dir of dirs) {
    if (dir && existsSync(join(dir, "config.yml"))) return join(dir, "config.yml");
  }
  return null;
}

function glabConfigHosts(): string[] {
  const path = glabConfigPath();
  if (!path) return [];
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return []; }
  const hosts: string[] = [];
  let inHosts = false;
  let indent = -1;
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) { inHosts = /^hosts:\s*(#.*)?$/.test(line); current = null; continue; }
    if (!inHosts) continue;
    if (indent < 0) indent = lead;
    if (lead === indent) {
      current = /^\s*(["']?)([^"':\s]+)\1\s*:/.exec(line)?.[2]?.toLowerCase() ?? null;
      continue;
    }
    if (current && lead > indent && /^\s*token:\s*[^\s#]/.test(line)) hosts.push(current);
  }
  return hosts;
}

function hostnameOf(value: string): string {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

export async function glabLoggedIn(host: string): Promise<boolean> {
  if (glabConfigHosts().includes(host)) return true;
  const env = process.env;
  if (!(env.GITLAB_TOKEN || env.GITLAB_ACCESS_TOKEN || env.OAUTH_TOKEN)) return false;
  return hostnameOf(env.GITLAB_HOST || env.GITLAB_URI || env.GL_HOST || "gitlab.com") === host;
}

export async function providerForHost(host: string): Promise<GitProvider | null> {
  if (await ghLoggedIn(host)) return "gh";
  if (await glabLoggedIn(host)) return "glab";
  return null;
}

export async function detectDeliveryMode(cwd: string): Promise<{ mode: DeliveryMode; host: string | null; provider: GitProvider | null }> {
  const host = await originHost(cwd);
  const provider = host === null ? null : await providerForHost(host);
  return { mode: provider ? "remote" : "local", host, provider };
}
