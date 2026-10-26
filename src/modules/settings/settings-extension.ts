import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chooseWindow, mutedLines, openProgramWindow } from "../../core/host/question-window.ts";
import type { WindowChoice } from "../../core/host/question-window.ts";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dataRoot } from "../../core/storage/data-root.ts";
import { primaryWorktreeRoot } from "../../core/storage/identity.ts";
import { defaultModeReason, methodsText, MODE_LABEL, SettingsPageView, tilde } from "./settings-page-ui.ts";
import type { ClearSwitchRequest, CopyRequest, PageState, SaveSwitchRequest } from "./settings-page-ui.ts";
import { AgentCopyError, copyAgentDefinition } from "../agents/agent-copy.ts";
import { readProjectTrust, trustProject } from "./project-trust.ts";
import { describeSetting } from "./agent-settings-ui.ts";
import type { ClearSettingRequest, PageNotice, PageTheme, SaveSettingRequest, SettingsLayerName } from "./agent-settings-ui.ts";
import { agentSwitchOf, clearAgentSetting, clearGitDeliverySetting, clearMergeMethodsSetting, disabledAgentProblems, projectSettingsPath, readAgentSettings, saveAgentSetting, saveDisabledAgentsSetting, saveGitDeliverySetting, saveMergeMethodsSetting, SETTINGS_ROLES, userSettingsPath } from "./agent-settings.ts";
import type { RoleCatalogEntry } from "../agents/roles.ts";
import { defaultRoleDir, loadRoleCatalog, projectRoleDir, userRoleDir } from "../agents/roles.ts";

const TRUSTED_NOTE = " · 已把本项目设为受信任";

export type SettingsExtensionContext = Pick<ExtensionContext, "hasUI" | "cwd" | "ui" | "mode" | "modelRegistry" | "model">;

/** /one:setting：查看内置、用户、项目三层的角色定义，C 复制为新定义；「模型」里改 PM、解释器、草稿核验器用的模型和思考等级；「开关」里改 Git 交付档位和允许的合并方式。 */
export async function openSettingsPage(ctx: SettingsExtensionContext, options: { mainThinking: () => string }): Promise<void> {
  const agentDir = dirname(dataRoot(process.env));
  const repositoryRoot = await primaryWorktreeRoot(ctx.cwd);
  const dirs = { defaultDir: defaultRoleDir(), userDir: userRoleDir(agentDir), projectDir: projectRoleDir(repositoryRoot) };
  const layers = [{ label: "内置层", dir: dirs.defaultDir }, { label: "用户层", dir: dirs.userDir }, { label: "项目层", dir: dirs.projectDir }];
  const fileOf = (dir: string, name: string) => join(dir, `${name}.md`);
  const nameTaken = (name: string) => layers.find((layer) => existsSync(fileOf(layer.dir, name)))?.label;
  const settingsPaths: Record<SettingsLayerName, string> = { user: userSettingsPath(agentDir), project: projectSettingsPath(repositoryRoot) };
  const layerLabel: Record<SettingsLayerName, string> = { user: "用户层", project: "项目层" };
  const readSettings = () => readAgentSettings({ agentDir, repositoryRoot, projectTrusted: readProjectTrust(agentDir, repositoryRoot) === "trusted" });
  const models = ctx.modelRegistry.getAll().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
  type Picked = { state: PageState } & ({ copy: CopyRequest } | { save: SaveSettingRequest } | { clear: ClearSettingRequest } | { saveSwitch: SaveSwitchRequest } | { clearSwitch: ClearSwitchRequest } | { toggle: RoleCatalogEntry });
  const claimProjectLayer = (): string => {
    const now = readProjectTrust(agentDir, repositoryRoot);
    if (now === "denied") throw new Error("你在 pi 里选过不信任这个项目，先输入 /trust 选 Trust");
    if (now === "trusted") return "";
    trustProject(agentDir, repositoryRoot);
    return TRUSTED_NOTE;
  };
  const applyChange = async (picked: Exclude<Picked, { copy: CopyRequest }>): Promise<{ text: string; fresh: string; tone?: PageNotice["tone"] }> => {
    if ("toggle" in picked) {
      const { name, source } = picked.toggle, layer: SettingsLayerName = source === "project" ? "project" : "user";
      const disabled = (await readSettings()).disabledAgents, names = disabled[layer];
      const enabled = agentSwitchOf(name, disabled).enabled;
      await saveDisabledAgentsSetting(settingsPaths[layer], enabled ? [...names, name] : names.filter((item) => item !== name));
      const now = agentSwitchOf(name, (await readSettings()).disabledAgents);
      if (!enabled && !now.enabled) return { fresh: name, tone: "warning", text: `${name} 仍是关闭：${layerLabel[now.from!]}设置文件里也写了关闭` };
      return { fresh: name, text: `${enabled ? "已关闭" : "已开启"} ${name} · ${layer === "project" ? "本项目生效" : "全局生效"}` };
    }
    if ("save" in picked) {
      const { role, layer, model, thinking } = picked.save;
      const { label, effect } = SETTINGS_ROLES.find((item) => item.key === role)!;
      const note = layer === "project" ? claimProjectLayer() : "";
      await saveAgentSetting({ path: settingsPaths[layer], role, model, thinking });
      return { fresh: role, text: `✓ ${label} 改为 ${describeSetting(role, { model, thinking })}，存到${layerLabel[layer]}，${effect}${note}` };
    }
    if ("clear" in picked) {
      const { role, layer } = picked.clear;
      const { label } = SETTINGS_ROLES.find((item) => item.key === role)!;
      await clearAgentSetting({ path: settingsPaths[layer], role });
      const now = (await readSettings()).values[role];
      return { fresh: role, text: `✓ 已清除${layerLabel[layer]}的 ${label} 设定，现在用${now.source === "user" ? `用户层的 ${describeSetting(role, now)}` : "内置默认值：跟随主会话"}` };
    }
    if ("saveSwitch" in picked) {
      const request = picked.saveSwitch, path = settingsPaths[request.layer];
      const note = request.layer === "project" ? claimProjectLayer() : "";
      if (request.key === "git-delivery") {
        await saveGitDeliverySetting({ path, mode: request.mode });
        return { fresh: "git-delivery", text: `✓ Git 交付 改为${MODE_LABEL[request.mode]}，存到${layerLabel[request.layer]}，立即生效${note}` };
      }
      await saveMergeMethodsSetting({ path, methods: request.methods });
      return { fresh: "merge-methods", text: `✓ 合并方式 改为 ${methodsText(request.methods)}，存到${layerLabel[request.layer]}，立即生效${note}` };
    }
    const { key, layer } = picked.clearSwitch;
    await (key === "git-delivery" ? clearGitDeliverySetting : clearMergeMethodsSetting)({ path: settingsPaths[layer] });
    const settings = await readSettings();
    if (key === "git-delivery") {
      const now = settings.gitDelivery;
      const current = now.source === "default" ? `内置默认值：${MODE_LABEL[now.mode]}（${defaultModeReason(now.detected)}）` : `${layerLabel[now.source]}的值：${MODE_LABEL[now.mode]}`;
      return { fresh: key, text: `✓ 已清除${layerLabel[layer]}的 Git 交付 设定，现在用${current}` };
    }
    const now = settings.mergeMethods;
    return { fresh: key, text: `✓ 已清除${layerLabel[layer]}的合并方式 设定，现在用${now.source === "default" ? "内置默认值" : `${layerLabel[now.source]}的值`}：${methodsText(now.methods)}` };
  };
  let state: PageState | undefined;
  for (;;) {
    const projectTrust = readProjectTrust(agentDir, repositoryRoot), projectTrusted = projectTrust === "trusted";
    const untrustedProjectCount = projectTrusted ? 0 : await readdir(dirs.projectDir).then((files) => files.filter((file) => file.endsWith(".md")).length, () => 0);
    const catalog = await loadRoleCatalog({ ...dirs, parseFrontmatter, projectTrusted });
    const settings = await readSettings();
    settings.problems.push(...disabledAgentProblems(settings.disabledAgents, { user: settingsPaths.user, project: settingsPaths.project }, catalog));
    const picked = await openProgramWindow<Picked>(ctx, (tui, theme, _keybindings, done) => {
      const view: SettingsPageView = new SettingsPageView({ catalog, theme: theme as unknown as PageTheme, projectTrust, untrustedProjectCount, nameTaken,
        settings, models, mainModel: ctx.model, mainThinking: options.mainThinking(), ...(state ? { state } : {}),
        onCopy: (copy) => done({ copy, state: view.state() }), onSaveSetting: (save) => done({ save, state: view.state() }), onClearSetting: (clear) => done({ clear, state: view.state() }),
        onSaveSwitch: (saveSwitch) => done({ saveSwitch, state: view.state() }), onClearSwitch: (clearSwitch) => done({ clearSwitch, state: view.state() }), onToggleAgent: (toggle) => done({ toggle, state: view.state() }),
        onClose: () => done(undefined) });
      return { render: (width: number) => view.render(width), invalidate: () => view.invalidate(),
        handleInput: (data: string) => { view.handleInput(data); tui.requestRender(); } };
    });
    if (!picked) return;
    if (!("copy" in picked)) {
      try {
        const { text, fresh, tone = "ok" } = await applyChange(picked);
        state = { ...picked.state, fresh, notice: { tone, text } };
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).split("\n")[0];
        state = { ...picked.state, notice: { tone: "error", text: `✗ 没有保存：${message}` } };
      }
      continue;
    }
    const { entry, name } = picked.copy;
    const back = (notice: PageNotice, selectName = entry.name, fresh?: string) => { state = { ...picked.state, selectName, notice, ...(fresh ? { fresh } : {}) }; };
    const target = (dir: string) => ({ path: fileOf(dir, name), taken: existsSync(fileOf(dir, name)) });
    const user = target(dirs.userDir), project = target(dirs.projectDir);
    const choices: WindowChoice[] = [
      { label: "用户层", ...(user.taken ? { disabled: `已有 ${tilde(user.path)}` } : { description: tilde(user.path) }) },
      { label: "项目层", ...(projectTrust === "denied" ? { disabled: "你在 pi 里选过不信任这个项目，先输入 /trust 选 Trust" } : project.taken ? { disabled: `已有 ${tilde(project.path)}` } : { description: projectTrust === "unset" ? `${tilde(project.path)} · 选它会把本项目设为受信任` : tilde(project.path) }) },
    ];
    if (choices.every((choice) => choice.disabled)) {
      back({ tone: "muted", text: project.taken ? `用户层和项目层都已经有 ${name}，直接编辑对应文件即可` : `用户层已经有 ${name}，直接编辑这个文件即可；你在 pi 里选过不信任这个项目，不能复制到项目层` });
      continue;
    }
    const layer = await chooseWindow(ctx, { title: `复制 ${entry.name} 到哪一层？`,
      lines: mutedLines([`新名称：${name}`]), choices });
    if (!layer) { back({ tone: "muted", text: "已取消复制" }); continue; }
    const targetDir = layer === "用户层" ? dirs.userDir : dirs.projectDir;
    let note = "";
    try {
      if (layer === "项目层") note = claimProjectLayer();
    } catch (error) {
      back({ tone: "muted", text: `复制没有完成：${(error instanceof Error ? error.message : String(error)).split("\n")[0]}` });
      continue;
    }
    try {
      const copied = await copyAgentDefinition({ entry, newName: name, targetDir, layerDirs: layers.map((item) => item.dir) });
      back({ tone: "ok", text: `✓ 已复制到 ${tilde(copied)}，打开它写专长、skills 和 mcp${note}` }, name, name);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const text = error instanceof AgentCopyError ? error.message
        : code === "ENOENT" ? "复制没有完成：源文件已经不存在，重新打开本页再试"
        : code === "EEXIST" ? `复制没有完成：${tilde(fileOf(targetDir, name))} 已经存在，换一个名字再复制`
        : code === "EACCES" || code === "EPERM" ? `复制没有完成：没有权限写入 ${tilde(targetDir)}`
        : `复制没有完成：${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`;
      back({ tone: "muted", text });
    }
  }
}
