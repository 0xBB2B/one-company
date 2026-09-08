import { execFile } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { detectMcpAdapter, listMcpServers } from "../runtime/mcp.ts";
import { defaultRoleDir, loadRoleCatalog, projectRoleDir, userRoleDir } from "../runtime/roles.ts";
import {
  clearRoleField,
  loadRoleSettings,
  saveRoleSettings,
  settingsPaths,
} from "../runtime/settings.ts";
import { createSettingsComponent, createSettingsSession } from "../runtime/settings-ui.ts";
import type { FrontmatterParser } from "../runtime/roles.ts";
import type {
  SettingsComponent,
  SettingsField,
  SettingsModelsContext,
  SettingsScope,
  SettingsTheme,
} from "../runtime/settings-ui.ts";

const execFileAsync = promisify(execFile);
const THINKING_LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env: { ...process.env, LC_ALL: "C" },
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return cwd;
  }
}

function deriveThinkingLevels(model: { reasoning: boolean; thinkingLevelMap?: Record<string, unknown> }): string[] {
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap ?? {};
  return THINKING_LEVEL_ORDER.filter((level) => map[level] !== null);
}

interface ModelLike {
  provider: string;
  id: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, unknown>;
}

function buildModelsContext(ctx: {
  modelRegistry?: { getAvailable(): ModelLike[] };
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  scopedModels?: readonly { model: ModelLike }[];
}): SettingsModelsContext {
  const registry = ctx.modelRegistry;
  if (!registry) return { available: [], sessionModel: "", sessionThinking: "off" };
  let models = registry.getAvailable();
  if (ctx.scopedModels && ctx.scopedModels.length > 0) {
    const allowed = new Set(ctx.scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`));
    models = models.filter((model) => allowed.has(`${model.provider}/${model.id}`));
  }
  const available = models.map((model) => ({
    provider: model.provider,
    id: model.id,
    thinkingLevels: deriveThinkingLevels(model),
  }));
  return {
    available,
    sessionModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
    sessionThinking: ctx.thinkingLevel ?? "off",
  };
}

function detectMcpServers(agentDir: string): string[] {
  try {
    const result = detectMcpAdapter({
      sourcePaths: [dirname(fileURLToPath(import.meta.url))],
      argv: process.argv,
      agentDir,
    });
    if (!result.installed) return [];
    const listed = listMcpServers(result.configPath);
    return listed.ok ? listed.servers.filter((server) => !server.disabled).map((server) => server.name) : [];
  } catch {
    return [];
  }
}

function buildTheme(ctx: { ui: { theme?: { fg(kind: string, text: string): string; bg(kind: string, text: string): string } } }): SettingsTheme | undefined {
  const hostTheme = ctx.ui.theme;
  if (!hostTheme) return undefined;
  return {
    fg: (kind: string, text: string) => hostTheme.fg(kind, text),
    bg: (kind: string, text: string) => hostTheme.bg(kind, text),
  };
}

export interface SettingsExtensionContext {
  hasUI: boolean;
  mode?: string;
  cwd: string;
  isProjectTrusted?: () => boolean;
  modelRegistry?: { getAvailable(): ModelLike[] };
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  scopedModels?: readonly { model: ModelLike }[];
  ui: {
    notify(message: string, level?: string): void;
    setEditorComponent(factory: unknown): void;
    theme?: { fg(kind: string, text: string): string; bg(kind: string, text: string): string };
  };
}

export async function openSettingsPage(ctx: SettingsExtensionContext): Promise<void> {
  try {
    const projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
    const agentDir = resolveAgentDir(process.env);
    const repoRoot = await resolveRepoRoot(ctx.cwd);

    const catalog = await loadRoleCatalog({
      defaultDir: defaultRoleDir(),
      userDir: userRoleDir(agentDir),
      projectDir: projectRoleDir(repoRoot),
      parseFrontmatter,
      projectTrusted,
    });

    const paths = settingsPaths({ agentDir, repoRoot, projectTrusted });
    const loaded = await loadRoleSettings(paths, { roleNames: catalog.roles.map((role) => role.name) });

    const models = buildModelsContext(ctx);
    const detected = detectMcpServers(agentDir);

    const baselines: { global: string | null; project: string | null } = {
      global: loaded.global.raw,
      project: loaded.project?.raw ?? null,
    };

    const save = async (scope: SettingsScope, role: string, field: SettingsField, value: unknown): Promise<void> => {
      const path = scope === "project" ? paths.project : paths.global;
      if (!path) throw new Error("项目层设置不可写入：项目未受信任");
      const isDefaultValue = field !== "mcp" && value === "inherit";
      const raw = isDefaultValue
        ? await clearRoleField(path, { role, field, baseline: baselines[scope] })
        : await saveRoleSettings(path, { role, patch: { [field]: value }, baseline: baselines[scope] });
      baselines[scope] = raw;
    };

    const session = createSettingsSession({
      catalog: { roles: catalog.roles.map((role) => ({ name: role.name })) },
      settings: {
        global: { roles: loaded.global.roles },
        project: loaded.project ? { roles: loaded.project.roles } : null,
      },
      scope: "global",
      models,
      mcp: { detected },
      save,
    });

    let component: SettingsComponent | undefined;
    ctx.ui.setEditorComponent((tui: { terminal: { rows: number }; requestRender?: () => void }) => {
      if (!component) {
        component = createSettingsComponent(session, {
          theme: buildTheme(ctx),
          onClose: () => ctx.ui.setEditorComponent(undefined),
          rows: () => tui.terminal.rows,
          requestRender: () => tui.requestRender?.(),
        });
      }
      return component;
    });
  } catch (error) {
    ctx.ui.notify((error as Error).message);
  }
}

export default function settingsExtension(pi: {
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: SettingsExtensionContext) => Promise<void> }): void;
}): void {
  pi.registerCommand("pi-company:setting", {
    description: "打开角色配置设置页",
    handler: async (_args, ctx) => {
      const nonInteractive = !ctx.hasUI || ctx.mode !== "tui";
      if (nonInteractive) {
        ctx.ui.notify("需要交互终端才能打开设置页");
        return;
      }
      await openSettingsPage(ctx);
    },
  });
}
