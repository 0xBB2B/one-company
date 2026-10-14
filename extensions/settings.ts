import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chooseWindow, mutedLines } from "../runtime/question-window.ts";
import type { WindowChoice } from "../runtime/question-window.ts";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dataRoot } from "../runtime/data-root.ts";
import { readGit } from "../runtime/git-read.ts";
import { AgentCatalogView, tilde } from "../runtime/agent-catalog-ui.ts";
import type { AgentCatalogTheme, CatalogNotice, CatalogPageState, CopyRequest } from "../runtime/agent-catalog-ui.ts";
import { AgentCopyError, copyAgentDefinition } from "../runtime/agent-copy.ts";
import { describeSetting } from "../runtime/agent-settings-ui.ts";
import type { ClearSettingRequest, SaveSettingRequest, SettingsLayerName } from "../runtime/agent-settings-ui.ts";
import { clearAgentSetting, projectSettingsPath, readAgentSettings, saveAgentSetting, SETTINGS_ROLES, userSettingsPath } from "../runtime/agent-settings.ts";
import { defaultRoleDir, loadRoleCatalog, projectRoleDir, sameNameOnly, userRoleDir } from "../runtime/roles.ts";

async function resolveRepoRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await readGit(cwd, ["rev-parse", "--show-toplevel"]);
    return stdout.trim();
  } catch {
    return cwd;
  }
}

export type SettingsExtensionContext = Pick<ExtensionContext, "hasUI" | "cwd" | "ui" | "mode" | "isProjectTrusted" | "modelRegistry" | "model">;

/** /one:agents：查看内置、用户、项目三层的角色定义，C 复制为新定义；设定栏里可以改 PM、解释器、草稿核验器用的模型和思考等级。 */
export async function openSettingsPage(ctx: SettingsExtensionContext): Promise<void> {
  const projectTrusted = ctx.isProjectTrusted();
  const agentDir = dirname(dataRoot(process.env));
  const repositoryRoot = await resolveRepoRoot(ctx.cwd);
  const dirs = { defaultDir: defaultRoleDir(), userDir: userRoleDir(agentDir), projectDir: projectRoleDir(repositoryRoot) };
  const layers = [{ label: "内置层", dir: dirs.defaultDir }, { label: "用户层", dir: dirs.userDir }, { label: "项目层", dir: dirs.projectDir }];
  const fileOf = (dir: string, name: string) => join(dir, `${name}.md`);
  const nameTaken = (name: string) => layers.find((layer) => existsSync(fileOf(layer.dir, name)))?.label;
  const untrustedProjectCount = projectTrusted ? 0 : await readdir(dirs.projectDir).then((files) => files.filter((file) => file.endsWith(".md")).length, () => 0);
  const settingsPaths: Record<SettingsLayerName, string> = { user: userSettingsPath(agentDir), project: projectSettingsPath(repositoryRoot) };
  const layerLabel: Record<SettingsLayerName, string> = { user: "用户层", project: "项目层" };
  const readSettings = () => readAgentSettings({ agentDir, repositoryRoot, projectTrusted });
  const models = ctx.modelRegistry.getAll().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
  type Picked = { state: CatalogPageState } & ({ copy: CopyRequest } | { save: SaveSettingRequest } | { clear: ClearSettingRequest });
  let state: CatalogPageState | undefined;
  for (;;) {
    const catalog = await loadRoleCatalog({ ...dirs, parseFrontmatter, projectTrusted });
    const settings = await readSettings();
    const picked = await ctx.ui.custom<Picked | undefined>((tui, theme, _keybindings, done) => {
      const view: AgentCatalogView = new AgentCatalogView({ catalog, theme: theme as unknown as AgentCatalogTheme, projectTrusted, untrustedProjectCount, nameTaken,
        settings, models, mainModel: ctx.model, ...(state ? { state } : {}),
        onCopy: (copy) => done({ copy, state: view.state() }), onSaveSetting: (save) => done({ save, state: view.state() }), onClearSetting: (clear) => done({ clear, state: view.state() }),
        onClose: () => done(undefined) });
      return { render: (width: number) => view.render(width), invalidate: () => view.invalidate(),
        handleInput: (data: string) => { view.handleInput(data); tui.requestRender(); } };
    });
    if (!picked) return;
    if ("save" in picked || "clear" in picked) {
      const { role, layer } = "save" in picked ? picked.save : picked.clear;
      const { label, effect } = SETTINGS_ROLES.find((item) => item.key === role)!;
      let text: string;
      try {
        if ("save" in picked) {
          const { model, thinking } = picked.save;
          await saveAgentSetting({ path: settingsPaths[layer], role, model, thinking });
          text = `✓ ${label} 改为 ${describeSetting(role, { model, thinking })}，存到${layerLabel[layer]}，${effect}`;
        } else {
          await clearAgentSetting({ path: settingsPaths[layer], role });
          const now = (await readSettings()).values[role];
          text = `✓ 已清除${layerLabel[layer]}的 ${label} 设定，现在用${now.source === "user" ? "用户层的" : "内置默认值"} ${describeSetting(role, now)}`;
        }
        state = { ...picked.state, fresh: role, notice: { tone: "ok", text } };
      } catch (error) {
        state = { ...picked.state, notice: { tone: "muted", text: error instanceof Error ? error.message : String(error) } };
      }
      continue;
    }
    const { entry, name } = picked.copy;
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
    const layer = await chooseWindow(ctx, { title: `复制 ${entry.name} 到哪一层？`,
      lines: sameNameOnly(entry.definition!.role) ? [] : mutedLines([`新名称：${name}`]), choices });
    if (!layer) { back({ tone: "muted", text: "已取消复制" }); continue; }
    try {
      const copied = await copyAgentDefinition({ entry, newName: name, targetDir: layer === "用户层" ? dirs.userDir : dirs.projectDir, layerDirs: layers.map((item) => item.dir) });
      back({ tone: "ok", text: `✓ 已复制到 ${tilde(copied)}，请直接编辑这个文件` }, name, name);
    } catch (error) {
      if (!(error instanceof AgentCopyError)) throw error;
      back({ tone: "muted", text: error.message });
    }
  }
}
