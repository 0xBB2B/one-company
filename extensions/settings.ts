import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { chooseWindow, mutedLines } from "../runtime/question-window.ts";
import type { WindowChoice } from "../runtime/question-window.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGit } from "../runtime/git-read.ts";
import { AgentCatalogView, INTERNAL_LABEL, tilde } from "../runtime/agent-catalog-ui.ts";
import type { AgentCatalogTheme, CatalogNotice, CatalogPageState, CopyRequest } from "../runtime/agent-catalog-ui.ts";
import { AgentCopyError, copyAgentDefinition } from "../runtime/agent-copy.ts";
import { defaultRoleDir, isAgentRole, loadRoleCatalog, projectRoleDir, sameNameOnly, userRoleDir } from "../runtime/roles.ts";
import type { FrontmatterParser } from "../runtime/roles.ts";

function parseFrontmatterValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((item) => item.trim());
  }
  return raw;
}

const parseFrontmatter: FrontmatterParser = (content) => {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: content };
  const header = content.slice(3, end).trim();
  const bodyStart = content.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "" : content.slice(bodyStart + 1);
  const frontmatter: Record<string, unknown> = {};
  for (const line of header.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    frontmatter[key] = parseFrontmatterValue(line.slice(separatorIndex + 1).trim());
  }
  return { frontmatter, body };
};

function resolveAgentDir(env: NodeJS.ProcessEnv): string {
  const override = env.PI_CODING_AGENT_DIR;
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error(`PI_CODING_AGENT_DIR 必须是绝对路径: ${override}`);
    return override;
  }
  const home = env.HOME;
  if (!home) throw new Error("未设置 PI_CODING_AGENT_DIR 时必须设置 HOME");
  return join(home, ".pi", "agent");
}

async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await readGit(cwd, ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return cwd;
  }
}

export type SettingsExtensionContext = Pick<ExtensionContext, "hasUI" | "cwd" | "ui"> & { mode?: string; isProjectTrusted?: () => boolean };

/** /one:agents：只读查看内置、用户、项目三层的角色定义；C 复制为新定义，编辑请直接改对应目录下的 md。 */
export async function openSettingsPage(ctx: SettingsExtensionContext): Promise<void> {
  const projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
  const agentDir = resolveAgentDir(process.env);
  const dirs = { defaultDir: defaultRoleDir(), userDir: userRoleDir(agentDir), projectDir: projectRoleDir(await resolveRepoRoot(ctx.cwd)) };
  const layers = [{ label: "内置层", dir: dirs.defaultDir }, { label: "用户层", dir: dirs.userDir }, { label: "项目层", dir: dirs.projectDir }];
  const fileOf = (dir: string, name: string) => join(dir, `${name}.md`);
  const nameTaken = (name: string) => layers.find((layer) => existsSync(fileOf(layer.dir, name)))?.label;
  const untrustedProjectCount = projectTrusted ? 0 : await readdir(dirs.projectDir).then((files) => files.filter((file) => file.endsWith(".md")).length, () => 0);
  let state: CatalogPageState | undefined;
  for (;;) {
    const catalog = await loadRoleCatalog({ ...dirs, parseFrontmatter, projectTrusted });
    const picked = await ctx.ui.custom<{ request: CopyRequest; state: CatalogPageState } | undefined>((tui, theme, _keybindings, done) => {
      const view: AgentCatalogView = new AgentCatalogView({ catalog, theme: theme as unknown as AgentCatalogTheme, projectTrusted, untrustedProjectCount, nameTaken,
        ...(state ? { state } : {}), onCopy: (request) => done({ request, state: view.state() }), onClose: () => done(undefined) });
      return { render: (width: number) => view.render(width), invalidate: () => view.invalidate(),
        handleInput: (data: string) => { view.handleInput(data); tui.requestRender(); } };
    });
    if (!picked) return;
    const { entry, name } = picked.request;
    const internal = !isAgentRole(entry.definition!.role);
    const back = (notice: CatalogNotice, selectName = entry.name, fresh?: string) => { state = { ...picked.state, selectName, notice, ...(fresh ? { fresh } : {}) }; };
    const target = (dir: string) => ({ path: fileOf(dir, name), taken: existsSync(fileOf(dir, name)) });
    const user = target(dirs.userDir), project = target(dirs.projectDir);
    const choices: WindowChoice[] = [
      { label: "用户层", ...(user.taken ? { disabled: `已有 ${tilde(user.path)}` } : { description: tilde(user.path) }) },
      { label: "项目层", ...(!projectTrusted ? { disabled: "项目未受信任，暂不能复制到这里" } : project.taken ? { disabled: `已有 ${tilde(project.path)}` } : { description: tilde(project.path) }) },
    ];
    if (choices.every((choice) => choice.disabled)) {
      back({ tone: "muted", text: project.taken ? `用户层和项目层都已经有 ${name}，直接编辑对应文件即可` : `用户层已经有 ${name}，直接编辑这个文件即可；项目未受信任，不能复制到项目层` });
      continue;
    }
    const layer = await chooseWindow(ctx, { title: `复制${internal ? INTERNAL_LABEL[entry.name] : ` ${entry.name} `}到哪一层？`,
      lines: sameNameOnly(entry.definition!.role) ? [] : mutedLines([`新名称：${name}`]), choices });
    if (!layer) { back({ tone: "muted", text: "已取消复制" }); continue; }
    try {
      const copied = await copyAgentDefinition({ entry, newName: name, targetDir: layer === "用户层" ? dirs.userDir : dirs.projectDir, layerDirs: layers.map((item) => item.dir) });
      back({ tone: "ok", text: `✓ 已复制到 ${tilde(copied)}，${internal ? "改 model 和 thinking 两行即可" : "请直接编辑这个文件"}` }, name, name);
    } catch (error) {
      if (!(error instanceof AgentCopyError)) throw error;
      back({ tone: "muted", text: error.message });
    }
  }
}
