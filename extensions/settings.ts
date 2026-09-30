import { chooseWindow } from "../runtime/question-window.ts";
import { isAbsolute, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGit } from "../runtime/git-read.ts";
import { AgentCatalogView } from "../runtime/agent-catalog-ui.ts";
import type { AgentCatalogTheme } from "../runtime/agent-catalog-ui.ts";
import { AgentCopyError, copyAgentDefinition } from "../runtime/agent-copy.ts";
import { defaultRoleDir, loadRoleCatalog, projectRoleDir, userRoleDir } from "../runtime/roles.ts";
import type { FrontmatterParser, RoleCatalogEntry } from "../runtime/roles.ts";

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
  for (;;) {
    const catalog = await loadRoleCatalog({ ...dirs, parseFrontmatter, projectTrusted });
    const picked = await ctx.ui.custom<RoleCatalogEntry | undefined>((tui, theme, _keybindings, done) => {
      const view = new AgentCatalogView({ catalog, theme: theme as unknown as AgentCatalogTheme, onCopy: (entry) => done(entry), onClose: () => done(undefined) });
      return { render: (width: number) => view.render(width), invalidate: () => view.invalidate(),
        handleInput: (data: string) => { view.handleInput(data); tui.requestRender(); } };
    });
    if (!picked) return;
    const newName = (await ctx.ui.input(`复制 ${picked.name} 为新定义：输入名称`, picked.definition?.role === "pm" ? "pm" : `${picked.name}-copy`))?.trim();
    if (!newName) continue;
    const layer = await chooseWindow(ctx, { title: "复制到", lines: [], choices: [{ label: "用户层", description: dirs.userDir },
      ...(projectTrusted ? [{ label: "项目层", description: dirs.projectDir }] : [])] });
    if (!layer) continue;
    try {
      const target = await copyAgentDefinition({ entry: picked, newName, targetDir: layer === "用户层" ? dirs.userDir : dirs.projectDir,
        layerDirs: [dirs.defaultDir, dirs.userDir, dirs.projectDir] });
      ctx.ui.notify(`已复制到 ${target}，请直接编辑该文件`);
    } catch (error) {
      if (!(error instanceof AgentCopyError)) throw error;
      ctx.ui.notify(error.message, "error");
    }
  }
}
