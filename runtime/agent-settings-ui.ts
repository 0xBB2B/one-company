import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { ModelLike } from "./agent-resolve.ts";
import { thinkingSupported } from "./agent-resolve.ts";
import { SETTINGS_ROLES } from "./agent-settings.ts";
import type { EffectiveSetting, RoleSetting, SettingsRoleKey } from "./agent-settings.ts";
import type { AgentCatalogTheme, CatalogNotice } from "./agent-catalog-ui.ts";
import { findDefinedModel } from "./model-ref.ts";
import { THINKING_LEVELS } from "./roles.ts";
import type { RoleSource, ThinkingLevel } from "./roles.ts";

export type SettingsLayerName = "user" | "project";
export interface SaveSettingRequest { role: SettingsRoleKey; model: string | null; thinking: ThinkingLevel; layer: SettingsLayerName }
export interface ClearSettingRequest { role: SettingsRoleKey; layer: SettingsLayerName }

const MARKER = 3, NAME = 14, SOURCE = 8, THINKING = 8, MIN_NAME = 8, MIN_MODEL = 9, MAX_MODEL = 24, CHECK = 2;
const FOLLOW = "跟随主会话";

export const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleWidth(text)));
export const fit = (text: string, width: number) => {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  let kept = "";
  for (const char of text) { if (visibleWidth(kept + char) > width - 1) break; kept += char; }
  return `${kept}…`;
};

const roleOf = (key: SettingsRoleKey) => SETTINGS_ROLES.find((role) => role.key === key)!;
export const thinkingLabel = (role: SettingsRoleKey, thinking: ThinkingLevel) => role !== "pm" && thinking === "off" ? "不思考" : thinking;
export const describeSetting = (role: SettingsRoleKey, setting: RoleSetting) => `${setting.model ?? FOLLOW} · ${thinkingLabel(role, setting.thinking)}`;

interface ModelChoice { name: string; note: string; value: string | null; model: ModelLike | undefined; current: boolean }
interface LevelChoice { level: ThinkingLevel; unsupported?: string }
interface PickerRow { name: string; note: string; current?: boolean; disabled?: boolean; soft?: boolean }

export function modelChoices(models: readonly ModelLike[], mainModel: ModelLike | undefined, current: RoleSetting): ModelChoice[] {
  const currentModel = current.model === null ? undefined : findDefinedModel(current.model, models, mainModel?.provider);
  return [
    ...models.map((model) => ({ name: model.id, note: model.provider, value: models.filter((other) => other.id === model.id).length > 1 ? `${model.provider}/${model.id}` : model.id, model, current: currentModel?.ok === true && currentModel.model === model })),
    { name: FOLLOW, note: mainModel ? `现在是 ${mainModel.provider}/${mainModel.id}` : "", value: null, model: mainModel, current: current.model === null },
  ];
}

export function thinkingChoices(model: ModelLike | undefined): LevelChoice[] {
  return THINKING_LEVELS.map((level) => model && !thinkingSupported(model, level) ? { level, unsupported: `${model.id} 不支持` } : { level });
}

export function rowAvailability(role: SettingsRoleKey, setting: RoleSetting, models: readonly ModelLike[], mainModel: ModelLike | undefined): { ok: true } | { ok: false; reason: string; consequence: string } {
  if (setting.model === null) return { ok: true };
  const defined = findDefinedModel(setting.model, models, mainModel?.provider);
  if (defined.ok) return { ok: true };
  const ambiguous = !setting.model.includes("/") && models.filter((model) => model.id === setting.model).length > 1;
  return { ok: false, reason: ambiguous ? defined.reason : `${setting.model} 没有可用的凭据`, consequence: `，${roleOf(role).failure}；回车重新选` };
}

/** 设定栏：三行角色设定列表，加上回车进入的"模型 → 思考等级 → 存到哪一层"三步选择。 */
export class SettingsTab {
  private step = 0;
  private role: SettingsRoleKey = "pm";
  private cursor = 0;
  private modelOptions: ModelChoice[] = [];
  private levelOptions: LevelChoice[] = [];
  private chosenModel: ModelChoice | undefined;
  private chosenThinking: ThinkingLevel = "off";
  private readonly options: {
    theme: AgentCatalogTheme; settings: { values: Record<SettingsRoleKey, EffectiveSetting> }; models: readonly ModelLike[]; mainModel: ModelLike | undefined;
    projectTrusted: boolean; sourceTag(source: RoleSource): string;
    onSave(request: SaveSettingRequest): void; onClear(request: ClearSettingRequest): void;
  };

  constructor(options: SettingsTab["options"]) { this.options = options; }

  picking(): boolean { return this.step > 0; }

  start(role: SettingsRoleKey): void {
    this.role = role;
    this.modelOptions = modelChoices(this.options.models, this.options.mainModel, this.options.settings.values[role]);
    this.enterStep(1);
  }

  clear(role: SettingsRoleKey): CatalogNotice | undefined {
    const source = this.options.settings.values[role].source;
    if (source === "default") return { tone: "muted", text: "已经是内置默认值" };
    this.options.onClear({ role, layer: source });
    return undefined;
  }

  handleInput(data: string): CatalogNotice | undefined {
    if (matchesKey(data, "escape")) {
      if (this.step > 1) this.enterStep(this.step - 1);
      else { this.step = 0; return { tone: "muted", text: "已取消修改" }; }
      return undefined;
    }
    const rows = this.rows();
    if (matchesKey(data, "down")) { const next = rows.findIndex((row, index) => index > this.cursor && !row.disabled); if (next >= 0) this.cursor = next; return undefined; }
    if (matchesKey(data, "up")) { const previous = rows.findLastIndex((row, index) => index < this.cursor && !row.disabled); if (previous >= 0) this.cursor = previous; return undefined; }
    if (!matchesKey(data, "enter")) return undefined;
    if (this.step === 1) {
      this.chosenModel = this.modelOptions[this.cursor]!;
      this.levelOptions = thinkingChoices(this.chosenModel.model);
      this.enterStep(2);
    } else if (this.step === 2) {
      this.chosenThinking = this.levelOptions[this.cursor]!.level;
      this.enterStep(3);
    } else {
      this.step = 0;
      this.options.onSave({ role: this.role, model: this.chosenModel!.value, thinking: this.chosenThinking, layer: this.cursor === 0 ? "project" : "user" });
    }
    return undefined;
  }

  private enterStep(step: number): void {
    this.step = step;
    const rows = this.rows();
    const current = rows.findIndex((row) => row.current && !row.disabled);
    this.cursor = current >= 0 ? current : rows.findIndex((row) => !row.disabled);
  }

  private rows(): PickerRow[] {
    if (this.step === 1) return this.modelOptions.map((choice) => ({ name: choice.name, note: choice.note, current: choice.current, soft: choice.value === null }));
    if (this.step === 2) {
      const current = this.options.settings.values[this.role].thinking;
      return this.levelOptions.map((choice) => ({ name: thinkingLabel(this.role, choice.level), note: choice.unsupported ?? "", current: choice.level === current, disabled: !!choice.unsupported }));
    }
    return [
      { name: "项目层", note: this.options.projectTrusted ? ".pi/settings.json · 只对这个项目生效" : "项目未受信任，项目层的设定不会生效", disabled: !this.options.projectTrusted },
      { name: "用户层", note: "~/.pi/agent/settings.json · 所有项目" },
    ];
  }

  private columns(width: number) {
    let name = NAME, model = MAX_MODEL;
    const total = () => MARKER + name + SOURCE + model + THINKING;
    if (total() > width) model = Math.max(MIN_MODEL, model - (total() - width));
    if (total() > width) name = Math.max(MIN_NAME, name - (total() - width));
    return { name, model };
  }

  renderList(width: number, cursor: number, fresh: string | undefined): string[] {
    const { theme, settings, models, mainModel } = this.options, { name: nameWidth, model } = this.columns(width);
    const lines = [theme.fg("muted", `${" ".repeat(MARKER)}${pad("名称", nameWidth)}${pad("来源", SOURCE)}${pad("模型", model)}思考`)];
    SETTINGS_ROLES.forEach((role, index) => {
      const value = settings.values[role.key], selected = index === cursor, available = rowAvailability(role.key, value, models, mainModel);
      const cell = (text: string, style?: (text: string) => string) => selected ? theme.bg("selectedBg", style ? style(text) : text) : style ? style(text) : text;
      const modelText = fit(available.ok ? value.model ?? FOLLOW : `${value.model} 不可用`, model - 1);
      const thinking = thinkingLabel(role.key, value.thinking);
      lines.push([
        cell(selected ? " › " : "   ", (text) => theme.fg("accent", text)),
        cell(pad(fit(role.label, nameWidth - 1), nameWidth), role.key === fresh ? (text) => theme.fg("success", text) : undefined),
        selected ? theme.bg("selectedBg", this.options.sourceTag(value.source)) : this.options.sourceTag(value.source), cell(" ".repeat(SOURCE - 6)),
        cell(pad(modelText, model), (text) => theme.fg(!available.ok ? "error" : value.model ? "accent" : "dim", text)),
        cell(thinking),
        ...(selected ? [cell(" ".repeat(Math.max(0, width - MARKER - nameWidth - SOURCE - model - visibleWidth(thinking))))] : []),
      ].join(""));
    });
    return lines;
  }

  footer(role: SettingsRoleKey, width: number): string {
    const { theme, settings, models, mainModel } = this.options, value = settings.values[role], info = roleOf(role);
    const available = rowAvailability(role, value, models, mainModel);
    if (!available.ok) {
      const room = width - 1 - 2 - visibleWidth(available.consequence);
      return theme.fg("error", room >= MIN_MODEL ? `✗ ${fit(available.reason, room)}${available.consequence}` : fit(`✗ ${available.reason}${available.consequence}`, width - 1));
    }
    const origin = value.source === "default" ? "内置默认值" : value.source === "user" ? "来自用户层" : "来自项目层";
    return theme.fg("muted", fit(`${info.label}：${info.purpose} · ${origin} · ${info.effect}`, width - 1));
  }

  renderPicker(width: number): string[] {
    const { theme } = this.options, info = roleOf(this.role), rows = this.rows();
    const muted = (text: string) => theme.fg("muted", text), dim = (text: string) => theme.fg("dim", text);
    const modelName = this.chosenModel?.name ?? "";
    const heading = this.step === 1 ? [`修改 ${info.label} 的模型`, "第 1 步，共 3 步"]
      : this.step === 2 ? [`修改 ${info.label} 的思考等级`, `第 2 步，共 3 步 · 模型 ${modelName}`]
        : [`${info.label} 改为 ${describeSetting(this.role, { model: this.chosenModel!.value, thinking: this.chosenThinking })}，存到哪一层`, "第 3 步，共 3 步"];
    const title = fit(heading[0]!, width - 1), step = visibleWidth(heading[1]!) <= width - 1 - visibleWidth(title) - 2 ? heading[1]! : "";
    const nameWidth = this.step === 1 ? 22 : this.step === 2 ? 12 : 10;
    const list = rows.map((row, index) => {
      const selected = index === this.cursor;
      const cell = (text: string, style?: (text: string) => string) => selected ? theme.bg("selectedBg", style ? style(text) : text) : style ? style(text) : text;
      const name = pad(fit(row.name, nameWidth), nameWidth), note = fit(row.note, Math.max(0, width - MARKER - CHECK - nameWidth - 1));
      return [
        cell(selected ? " › " : "   ", (text) => theme.fg("accent", text)),
        cell(row.current ? "✓ " : "  ", (text) => theme.fg("success", text)),
        cell(name, row.disabled ? dim : row.soft ? muted : undefined), cell(note, dim),
        ...(selected ? [cell(" ".repeat(Math.max(0, width - MARKER - CHECK - nameWidth - visibleWidth(note))))] : []),
      ].join("");
    });
    const head = ` ${theme.bold(title)}${step ? dim(`  ${step}`) : ""}`;
    if (this.step === 1) {
      const empty = this.options.models.length === 0;
      return [head, "", ...list, "", ` ${empty ? muted(fit("本机还没有其他配了凭据的模型，先在 pi 里登录模型服务", width - 1)) : dim("只列出本机配了凭据的模型")}`,
        ...(empty ? [""] : []), ` ${muted(empty ? "回车 下一步  Esc 取消" : "↑↓ 选择  回车 下一步  Esc 取消")}`];
    }
    if (this.step === 2) return [head, "", ...list, "", ` ${muted("↑↓ 选择  回车 下一步  Esc 上一步")}`];
    return [head, "", ...list, "", this.options.projectTrusted ? "" : ` ${dim(fit("在 pi 里把这个项目设为受信任后，才能存到项目层", width - 1))}`, ` ${muted("↑↓ 选择  回车 保存  Esc 上一步")}`];
  }
}
