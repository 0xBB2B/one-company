import { homedir } from "node:os";
import { basename } from "node:path";
import { decodeKittyPrintable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import {
  fit, FOLLOW, layerRows, MARKER, pad, pickerHead, pickerList, SettingsTab, SOURCE, tableColumns, tableRow, untrustedLayerNote, wrapHint, wrapText,
} from "./agent-settings-ui.ts";
import type { ClearSettingRequest, PageNotice, PickerRow, PageTheme, SaveSettingRequest, SettingsLayerName } from "./agent-settings-ui.ts";
import type { ModelLike } from "./agent-resolve.ts";
import { SETTINGS_ROLES } from "./agent-settings.ts";
import type { readAgentSettings } from "./agent-settings.ts";
import { NAME_PATTERN } from "./roles.ts";
import type { RoleCatalog, RoleCatalogEntry, RoleDefinitionProblem, RoleSource } from "./roles.ts";

const ROLE_SECTIONS = ["worker", "reviewer", "qa", "explore", "prototype"] as const;
type Section = (typeof ROLE_SECTIONS)[number] | "models" | "switches" | "problems";
const TITLE: Record<string, string> = { models: "模型", switches: "开关", problems: "问题" };
const DESCRIPTION: Record<Section, string> = {
  worker: "写代码", reviewer: "代码审查：实现是否合理", qa: "功能验收：行为是否符合目标", explore: "只读查资料", prototype: "需求涉及界面时出 HTML 原型",
  models: "PM 和两个内部代理用哪个模型", switches: "可选功能，默认都关闭", problems: "这些文件写错了，没有生效",
};
const SOURCE_LABEL: Record<RoleSource, string> = { default: "内置", user: "用户", project: "项目" };
const LAYER_ORDER: RoleSource[] = ["project", "user", "default"];
const NAV_WIDTH = 20, WIDE = 60, KEY = 8, FILE = 18, MIN_COLUMN = 8;
const WORD_CHAR = /[\w.~-]/u;
const NAME_RULE = "小写字母、数字、连字符，最多 64 个字符；三层里不能重名";
const GIT_DELIVERY_ON = "主代理可以替你提交归档、推送并建 PR";

export const tilde = (path: string) => { const home = homedir(); return path.startsWith(home) ? `~${path.slice(home.length)}` : path; };
const fitTail = (text: string, width: number) => {
  if (visibleWidth(text) <= width) return text;
  let kept = "";
  for (const char of [...text].reverse()) { if (visibleWidth(char + kept) > width - 1) break; kept = char + kept; }
  return `…${kept}`;
};

export interface PageState { section?: string; focus?: "nav" | "pane"; selectName?: string; fresh?: string; notice?: PageNotice }
export interface CopyRequest { entry: RoleCatalogEntry; name: string }
export interface SaveSwitchRequest { enabled: boolean; layer: SettingsLayerName }
export interface ClearSwitchRequest { layer: SettingsLayerName }
type Settings = Awaited<ReturnType<typeof readAgentSettings>>;

interface ProblemRow {
  file: string; tailFit?: boolean; source: RoleSource; short: string; tone: "error" | "info";
  detail: Array<{ key: string; value: string; error?: boolean }>; footer: string;
}

class SwitchPicker {
  private step = 0;
  private cursor = 0;
  private chosen = false;
  private readonly options: {
    theme: PageTheme; current: { enabled: boolean; source: "project" | "user" | "default" }; projectTrusted: boolean;
    onSave(request: SaveSwitchRequest): void; onClear(request: ClearSwitchRequest): void;
  };

  constructor(options: SwitchPicker["options"]) { this.options = options; }

  picking(): boolean { return this.step > 0; }

  start(): void { this.step = 1; this.cursor = this.options.current.enabled ? 1 : 0; }

  clear(): PageNotice<"muted"> | undefined {
    const { source } = this.options.current;
    if (source === "default") return { tone: "muted", text: "已经是内置默认值" };
    this.options.onClear({ layer: source });
    return undefined;
  }

  handleInput(data: string): PageNotice<"muted"> | undefined {
    if (matchesKey(data, "escape")) {
      if (this.step === 2) { this.step = 1; this.cursor = this.chosen ? 0 : 1; return undefined; }
      this.step = 0;
      return { tone: "muted", text: "已取消修改" };
    }
    const rows = this.rows();
    if (matchesKey(data, "down")) { const next = rows.findIndex((row, index) => index > this.cursor && !row.disabled); if (next >= 0) this.cursor = next; return undefined; }
    if (matchesKey(data, "up")) { const previous = rows.findLastIndex((row, index) => index < this.cursor && !row.disabled); if (previous >= 0) this.cursor = previous; return undefined; }
    if (!matchesKey(data, "enter")) return undefined;
    if (this.step === 1) {
      this.chosen = this.cursor === 0;
      this.step = 2;
      this.cursor = this.options.projectTrusted ? 0 : 1;
    } else {
      this.step = 0;
      this.options.onSave({ enabled: this.chosen, layer: this.cursor === 0 ? "project" : "user" });
    }
    return undefined;
  }

  hint(): string { return this.step === 1 ? "↑↓ 选择  回车 下一步  Esc 取消" : "↑↓ 选择  回车 保存  Esc 上一步"; }

  private rows(): PickerRow[] {
    if (this.step === 1) {
      const enabled = this.options.current.enabled;
      return [{ name: "开启", note: GIT_DELIVERY_ON, current: enabled }, { name: "关闭", note: "推送和合并由你自己做", current: !enabled }];
    }
    return layerRows(this.options.projectTrusted);
  }

  render(width: number): string[] {
    const { theme } = this.options;
    if (this.step === 1) return [pickerHead(theme, "修改 Git 交付", "第 1 步，共 2 步", width), "", ...pickerList(theme, this.rows(), this.cursor, 10, width)];
    return [pickerHead(theme, `Git 交付 改为${this.chosen ? "开启" : "关闭"}，存到哪一层`, "第 2 步，共 2 步", width), "",
      ...pickerList(theme, this.rows(), this.cursor, 10, width), ...(this.options.projectTrusted ? [] : ["", ...untrustedLayerNote(theme, width)])];
  }
}

export class SettingsPageView {
  private sectionIndex = 0;
  private focus: "nav" | "pane" = "nav";
  private cursor = 0;
  private expanded = false;
  private notice: PageNotice | undefined;
  private fresh: string | undefined;
  private naming: { entry: RoleCatalogEntry; text: string; error?: string } | undefined;
  private readonly options: {
    catalog: RoleCatalog; theme: PageTheme; projectTrusted: boolean; untrustedProjectCount: number; state?: PageState;
    settings: Settings; models: readonly ModelLike[]; mainModel: ModelLike | undefined; mainThinking: string;
    nameTaken(name: string): string | undefined; onCopy(request: CopyRequest): void; onClose(): void;
    onSaveSetting(request: SaveSettingRequest): void; onClearSetting(request: ClearSettingRequest): void;
    onSaveSwitch(request: SaveSwitchRequest): void; onClearSwitch(request: ClearSwitchRequest): void;
  };
  private readonly settingsTab: SettingsTab;
  private readonly switchPicker: SwitchPicker;

  constructor(options: SettingsPageView["options"]) {
    this.options = options;
    const { theme, settings, projectTrusted } = options;
    this.settingsTab = new SettingsTab({ theme, settings, models: options.models, mainModel: options.mainModel, mainThinking: options.mainThinking, projectTrusted,
      sourceTag: (source) => this.sourceTag(source), onSave: options.onSaveSetting, onClear: options.onClearSetting });
    this.switchPicker = new SwitchPicker({ theme, current: settings.gitDelivery, projectTrusted, onSave: options.onSaveSwitch, onClear: options.onClearSwitch });
    const state = options.state;
    const index = state?.section ? this.sections().indexOf(state.section as Section) : -1;
    if (index >= 0) this.sectionIndex = index;
    if (state?.focus === "pane") this.focus = "pane";
    if (state?.selectName) this.cursor = Math.max(0, this.rowNames().indexOf(state.selectName));
    this.fresh = state?.fresh;
    this.notice = state?.notice;
  }

  state(): PageState {
    const selectName = this.rowNames()[this.cursor];
    return { section: this.section, focus: this.focus, ...(selectName ? { selectName } : {}) };
  }

  invalidate(): void {}

  private sections(): Section[] { return [...ROLE_SECTIONS, "models", "switches", ...(this.problemRows().length ? ["problems" as const] : [])]; }
  private get section(): Section { return this.sections()[this.sectionIndex]!; }
  private isDefinitions(): boolean { return (ROLE_SECTIONS as readonly string[]).includes(this.section); }

  private entries(section: Section = this.section): RoleCatalogEntry[] {
    return this.options.catalog.roles
      .filter((entry) => entry.available && entry.definition && entry.definition.role === section)
      .sort((a, b) => Number(a.source === "default") - Number(b.source === "default") || a.name.localeCompare(b.name));
  }

  private rowNames(): string[] {
    if (this.section === "models") return SETTINGS_ROLES.map((role) => role.key);
    if (this.section === "switches") return ["git-delivery"];
    return this.isDefinitions() ? this.entries().map((entry) => entry.name) : [];
  }

  private rowCount(section: Section = this.section): number {
    if (section === "models") return SETTINGS_ROLES.length;
    if (section === "switches") return 1;
    return section === "problems" ? this.problemRows().length : this.entries(section).length;
  }

  private problemRows(): ProblemRow[] {
    const invalid = (file: string, source: RoleSource, path: string, problem: RoleDefinitionProblem | undefined, reason: string | undefined): ProblemRow => ({
      file, source, tone: "error", short: problem?.field ? `${problem.field} 写错了` : "格式不对",
      detail: [{ key: "原因", value: problem?.display ?? reason ?? "格式不对" },
        ...(problem?.value !== undefined ? [{ key: "现在是", value: String(problem.value), error: true }] : []),
        { key: "影响", value: "这份定义没有生效" }, { key: "文件", value: tilde(path) }],
      footer: "这份定义没有生效 · 改正文件后重新打开本页" });
    const rows: ProblemRow[] = [];
    for (const problem of this.options.catalog.problems) {
      if (problem.kind === "untrusted") {
        const count = this.options.untrustedProjectCount;
        rows.unshift({ file: ".pi/agents/", source: "project", tone: "info", short: "项目未受信任，项目层的定义和设定没有生效",
          detail: [{ key: "原因", value: "项目未受信任，项目层的定义和设定不会加载" }, { key: "目录", value: tilde(problem.dir) }],
          footer: `在 pi 里把这个项目设为受信任后，项目层的${count ? ` ${count} 份` : ""}定义就会生效` });
      } else if (problem.kind === "foreign") {
        rows.push({ file: basename(problem.dir), source: problem.source, tone: "info", short: "不是 one-company 的定义，没有导入",
          detail: [{ key: "原因", value: "缺少 role 字段，视为其他工具的定义" }, { key: "文件", value: tilde(problem.dir) }], footer: "缺少 role 字段，视为其他工具的定义" });
      } else if (problem.kind === "retired") {
        rows.push({ file: basename(problem.dir), source: problem.source, tone: "info", short: problem.reason,
          detail: [{ key: "原因", value: problem.reason }, { key: "文件", value: tilde(problem.dir) }], footer: "这份定义没有生效，模型和思考等级改在「模型」里" });
      } else if (problem.kind === "invalid") {
        rows.push(invalid(basename(problem.dir), problem.source, problem.dir, problem.problem, problem.reason));
      } else {
        rows.push({ file: tilde(problem.dir), source: problem.source, tone: "error", short: "目录读不了",
          detail: [{ key: "原因", value: problem.reason }], footer: "这一层的定义都没有加载" });
      }
    }
    for (const problem of this.options.settings.problems) {
      rows.push({ file: tilde(problem.path), tailFit: true, source: problem.layer, tone: "error", short: problem.display,
        detail: [{ key: "原因", value: problem.display }, ...(problem.value !== undefined ? [{ key: "现在是", value: problem.value, error: true }] : []),
          { key: "影响", value: problem.role || problem.key ? "这一项没有生效，改用下一层" : "这一层的设定都没有生效，改用下一层" }, { key: "文件", value: tilde(problem.path) }],
        footer: "改正文件后重新打开本页" });
    }
    for (const entry of this.options.catalog.roles.filter((candidate) => !candidate.available)) {
      rows.push(invalid(basename(entry.path), entry.source, entry.path, entry.problem, entry.reason));
    }
    return rows;
  }

  handleInput(data: string): void {
    if (this.naming) { this.handleNaming(data); return; }
    this.notice = undefined; this.fresh = undefined;
    const picker = this.settingsTab.picking() ? this.settingsTab : this.switchPicker.picking() ? this.switchPicker : undefined;
    if (picker) { this.notice = picker.handleInput(data); return; }
    if (this.focus === "nav") {
      const last = this.sections().length - 1;
      if (matchesKey(data, "down") && this.sectionIndex < last) { this.sectionIndex++; this.cursor = 0; }
      else if (matchesKey(data, "up") && this.sectionIndex > 0) { this.sectionIndex--; this.cursor = 0; }
      else if (matchesKey(data, "right") || matchesKey(data, "enter")) { this.focus = "pane"; this.cursor = 0; this.expanded = false; }
      else if (matchesKey(data, "escape")) this.options.onClose();
      return;
    }
    if (matchesKey(data, "escape")) { this.options.onClose(); return; }
    if (matchesKey(data, "left")) { this.focus = "nav"; this.expanded = false; return; }
    if (matchesKey(data, "down")) { this.cursor = Math.min(this.cursor + 1, Math.max(0, this.rowCount() - 1)); this.expanded = false; return; }
    if (matchesKey(data, "up")) { this.cursor = Math.max(this.cursor - 1, 0); this.expanded = false; return; }
    if (matchesKey(data, "enter")) {
      if (this.section === "models") this.settingsTab.start(SETTINGS_ROLES[this.cursor]!.key);
      else if (this.section === "switches") this.switchPicker.start();
      else if (this.rowCount()) this.expanded = !this.expanded;
      return;
    }
    if ((data === "c" || data === "C") && this.isDefinitions()) {
      const entry = this.entries()[this.cursor];
      if (entry?.definition) this.naming = { entry, text: `${entry.name}-copy` };
    } else if (data === "r" || data === "R") {
      if (this.section === "models") this.notice = this.settingsTab.clear(SETTINGS_ROLES[this.cursor]!.key);
      else if (this.section === "switches") this.notice = this.switchPicker.clear();
    }
  }

  private handleNaming(data: string): void {
    const naming = this.naming!;
    if (matchesKey(data, "escape")) { this.naming = undefined; this.notice = { tone: "muted", text: "已取消复制" }; return; }
    if (matchesKey(data, "enter")) {
      if (!NAME_PATTERN.test(naming.text)) { naming.error = "只能用小写字母、数字和连字符，例如 ui-worker"; return; }
      const taken = this.options.nameTaken(naming.text);
      if (taken) { naming.error = `${taken}已经有 ${naming.text}，换一个名字`; return; }
      this.options.onCopy({ entry: naming.entry, name: naming.text });
      return;
    }
    if (matchesKey(data, "backspace")) { naming.text = [...naming.text].slice(0, -1).join(""); naming.error = undefined; return; }
    const printable = decodeKittyPrintable(data) ?? data;
    if (!/[\u0000-\u001f\u007f]/u.test(printable)) { naming.text += printable; naming.error = undefined; }
  }

  private sourceTag(source: RoleSource, info = false): string {
    const { theme } = this.options, text = ` ${SOURCE_LABEL[source]} `;
    if (info) return theme.inverse(theme.fg("muted", text));
    if (source === "default") return theme.bg("selectedBg", theme.fg("muted", text));
    return theme.inverse(theme.fg(source === "user" ? "accent" : "success", text));
  }

  render(width: number): string[] {
    const { theme } = this.options, wide = width >= WIDE;
    const edge = theme.fg("border", "─".repeat(width)), dim = (text: string) => theme.fg("dim", text);
    const modal = this.naming !== undefined || this.settingsTab.picking() || this.switchPicker.picking();
    const showPane = wide || this.focus === "pane" || modal;
    const paneWidth = wide ? width - NAV_WIDTH - 1 : width;
    const warning = this.options.projectTrusted ? [] : wrapText("! 项目未受信任：项目层的定义和设定都没有生效", width - 1).map((line) => ` ${theme.fg("warning", line)}`);
    const top = wide || !showPane ? this.header(width) : theme.fg("accent", theme.bold(` ${this.crumbs().join(" › ")}`));
    let body: string[];
    if (wide) {
      const nav = this.navRows(NAV_WIDTH);
      const pane = this.paneLines(paneWidth, true, modal);
      const height = Math.max(nav.length, pane.length, ...this.sections().map((section) => 3 + this.rowCount(section)));
      body = Array.from({ length: height }, (_, index) => `${pad(nav[index] ?? "", NAV_WIDTH)}${dim("│")}${pane[index] ?? ""}`);
    } else {
      body = showPane ? this.paneLines(width, false, modal) : this.navRows(width);
    }
    const rule = (joint: string) => dim(wide ? `${"─".repeat(NAV_WIDTH)}${joint}${"─".repeat(width - NAV_WIDTH - 1)}` : "─".repeat(width));
    return [edge, top, ...warning, rule("┬"), ...body, rule("┴"), ...this.footerLines(width), ...this.hintLines(width, this.hintFor(!wide)), edge];
  }

  private header(width: number): string {
    const { theme } = this.options, left = " 设置", right = "/one:setting ";
    const space = width - visibleWidth(left) - visibleWidth(right);
    return theme.fg("accent", theme.bold(left)) + (space >= 1 ? " ".repeat(space) + theme.fg("muted", right) : "");
  }

  private crumbs(): string[] {
    const label = this.isDefinitions() ? this.section : TITLE[this.section]!;
    if (this.naming) return ["设置", label, "复制"];
    if (this.settingsTab.picking()) return ["设置", label, SETTINGS_ROLES[this.cursor]!.label];
    if (this.switchPicker.picking()) return ["设置", label, "Git 交付"];
    return ["设置", label];
  }

  private navRows(width: number): string[] {
    const { theme } = this.options, problems = this.problemRows().length;
    const item = (section: Section, label: string, tone?: string) => {
      const selected = this.section === section, text = `${selected ? " ▸ " : "   "}${pad(label, 10)}${this.rowCount(section)}`;
      const filled = pad(text, width);
      if (!selected) return tone ? theme.fg(tone, filled) : filled;
      return this.focus === "nav" ? theme.bg("selectedBg", theme.fg("accent", theme.bold(filled))) : theme.fg("accent", theme.bold(text)) + " ".repeat(width - visibleWidth(text));
    };
    const heading = (text: string) => theme.fg("muted", theme.bold(pad(text, width)));
    return [heading(" 角色定义"), ...ROLE_SECTIONS.map((section) => item(section, section)), pad("", width), heading(" 设定"), item("models", "模型"), item("switches", "开关"),
      ...(problems ? [pad("", width), item("problems", "问题", "error")] : [])];
  }

  private paneLines(width: number, withTitle: boolean, modal: boolean): string[] {
    if (this.naming) return this.renderNaming(width);
    if (modal) return [...(this.settingsTab.picking() ? this.settingsTab.renderPicker(width) : this.switchPicker.render(width)), ""];
    const { theme } = this.options, section = this.section;
    const table = section === "models" ? this.settingsTab.renderList(width, this.focus === "pane" ? this.cursor : -1, this.fresh)
      : section === "switches" ? this.switchPane(width) : section === "problems" ? this.problemPane(width) : this.definitionPane(width);
    if (!withTitle) return table;
    const title = this.isDefinitions() ? section : TITLE[section]!;
    return [` ${theme.fg("accent", theme.bold(title))}  ${theme.fg("dim", fit(DESCRIPTION[section], Math.max(0, width - visibleWidth(title) - 3)))}`, "", ...table];
  }

  private selectedRow(index: number): boolean { return this.focus === "pane" && index === this.cursor; }
  private marker(selected: boolean): string { return selected ? (this.expanded ? " ▾ " : " ▸ ") : "   "; }

  private definitionPane(width: number): string[] {
    const { theme } = this.options, cols = tableColumns(width);
    const lines = [theme.fg("muted", `${" ".repeat(MARKER)}${pad("名称", cols.name)}${pad("来源", SOURCE)}${pad("模型", cols.model)}思考`)];
    this.entries().forEach((entry, index) => {
      const definition = entry.definition!, selected = this.selectedRow(index);
      const name = fit(entry.name, cols.name - 1), model = fit(definition.model ?? FOLLOW, cols.model - 1), thinking = definition.thinking ?? "跟随";
      lines.push(tableRow(theme, selected, width, [
        [this.marker(selected), (text) => theme.fg("accent", text)],
        [name, this.fresh === entry.name ? (text) => theme.fg("success", text) : undefined], [" ".repeat(cols.name - visibleWidth(name))],
        [" ".repeat(6), undefined, this.sourceTag(entry.source)], [" ".repeat(SOURCE - 6)],
        [model, (text) => theme.fg(definition.model ? "accent" : "dim", text)], [" ".repeat(cols.model - visibleWidth(model))],
        [thinking, definition.thinking ? undefined : (text) => theme.fg("dim", text)],
      ]));
      if (selected && this.expanded) lines.push(...this.entryDetail(entry, width));
    });
    return lines;
  }

  private detailLine(key: string, value: string, width: number, style?: (text: string) => string): string[] {
    const { theme } = this.options, room = Math.max(MIN_COLUMN, width - 5 - KEY);
    const chunks: string[] = [""];
    for (const char of value) {
      const line = chunks.at(-1)!;
      if (visibleWidth(line + char) <= room) { chunks[chunks.length - 1] = line + char; continue; }
      let cut = -1;
      if (WORD_CHAR.test(char)) for (let i = line.length - 1; i >= 0 && cut < 0; i--) if (!WORD_CHAR.test(line[i]!)) cut = i;
      if (cut > 0 && cut < line.length - 1) { chunks[chunks.length - 1] = line.slice(0, cut + 1).trimEnd(); chunks.push(line.slice(cut + 1) + char); }
      else chunks.push(char === " " ? "" : char);
    }
    return chunks.map((chunk, index) => `   ${theme.fg("dim", "┊ ")}${index === 0 ? theme.fg("muted", pad(key, KEY)) : " ".repeat(KEY)}${style ? style(chunk) : chunk}`);
  }

  private entryDetail(entry: RoleCatalogEntry, width: number): string[] {
    const { theme } = this.options, definition = entry.definition!, dim = (text: string) => theme.fg("dim", text);
    return [...this.detailLine("说明", definition.description, width),
      ...this.detailLine("skills", definition.skills?.join("、") || "无", width, definition.skills?.length ? undefined : dim),
      ...this.detailLine("MCP", definition.mcp?.join("、") || "无", width, definition.mcp?.length ? undefined : dim),
      ...this.detailLine("正文", definition.body.trim() ? "已写 · 流程规矩由程序加上，优先于正文" : "空 · 流程规矩由程序加上，正文只写专长和偏好", width),
      ...this.detailLine("文件", tilde(entry.path), width, dim)];
  }

  private problemPane(width: number): string[] {
    const { theme } = this.options, fileWidth = Math.min(FILE, Math.max(MIN_COLUMN, width - 23));
    const lines = [theme.fg("muted", `${" ".repeat(MARKER)}${pad("文件", fileWidth)}${pad("层", SOURCE)}原因`)];
    this.problemRows().forEach((row, index) => {
      const selected = this.selectedRow(index), info = row.tone === "info";
      const file = row.tailFit ? fitTail(row.file, fileWidth) : fit(row.file, fileWidth), short = fit(row.short, width - MARKER - fileWidth - SOURCE);
      lines.push(tableRow(theme, selected, width, [
        [this.marker(selected), (text) => theme.fg("accent", text)], [file], [" ".repeat(fileWidth - visibleWidth(file))],
        [" ".repeat(6), undefined, this.sourceTag(row.source, info)], [" ".repeat(SOURCE - 6)],
        [short, (text) => theme.fg(row.tone === "error" ? "error" : "muted", text)],
      ]));
      if (selected && this.expanded) {
        for (const item of row.detail) lines.push(...this.detailLine(item.key, item.value, width, item.error ? (text) => theme.fg("error", text) : item.key === "文件" || item.key === "目录" ? (text) => theme.fg("dim", text) : undefined));
      }
    });
    return lines;
  }

  private switchPane(width: number): string[] {
    const { theme, settings } = this.options, cols = tableColumns(width), { enabled, source } = settings.gitDelivery, selected = this.selectedRow(0);
    return [theme.fg("muted", `${" ".repeat(MARKER)}${pad("名称", cols.name)}${pad("来源", SOURCE)}状态`),
      tableRow(theme, selected, width, [
        [selected ? " ▸ " : "   ", (text) => theme.fg("accent", text)], [pad("Git 交付", cols.name), this.fresh === "git-delivery" ? (text) => theme.fg("success", text) : undefined],
        [" ".repeat(6), undefined, this.sourceTag(source)], [" ".repeat(SOURCE - 6)],
        [enabled ? "开启" : "关闭", (text) => theme.fg(enabled ? "success" : "dim", text)],
      ])];
  }

  private renderNaming(width: number): string[] {
    const { theme } = this.options, naming = this.naming!, muted = (text: string) => theme.fg("muted", text), dim = (text: string) => theme.fg("dim", text);
    return [` ${theme.bold(fit(`复制 ${naming.entry.name} 为新定义`, width - 1))}`, "",
      ` ${muted("新名称")}  ${fit(`${naming.text}█`, Math.max(MIN_COLUMN, width - 9))}`,
      ...(naming.error ? wrapText(`✗ ${naming.error}`, width - 1).map((line) => ` ${theme.fg("error", line)}`) : wrapText(NAME_RULE, width - 1).map((line) => ` ${dim(line)}`))];
  }

  private footerLines(width: number): string[] {
    const { theme } = this.options;
    if (this.notice) {
      const kind = this.notice.tone === "ok" ? "success" : this.notice.tone;
      return wrapText(this.notice.text, width - 1).map((line) => ` ${theme.fg(kind, line)}`);
    }
    const lines = this.categoryFooter(width);
    return lines.length ? lines : [""];
  }

  private categoryFooter(width: number): string[] {
    const { theme } = this.options, section = this.section, muted = (text: string) => ` ${theme.fg("muted", text)}`;
    const wrap = (text: string) => wrapText(text, width - 1).map(muted);
    if (this.focus === "nav") {
      if (!this.isDefinitions()) return wrap(`${TITLE[section]}：${DESCRIPTION[section]}`);
      const entries = this.entries(), layers = LAYER_ORDER.map((source) => ({ source, count: entries.filter((entry) => entry.source === source).length })).filter((layer) => layer.count > 0);
      return wrap(`${section}：${DESCRIPTION[section]} · ${entries.length} 份定义（${layers.map((layer) => `${SOURCE_LABEL[layer.source]} ${layer.count}`).join(" · ")}）`);
    }
    if (section === "models") return this.settingsTab.footer(SETTINGS_ROLES[this.cursor]!.key, width).map((line) => ` ${line}`);
    if (section === "switches") {
      const source = this.options.settings.gitDelivery.source;
      return wrap(`Git 交付：开启后${GIT_DELIVERY_ON} · ${source === "default" ? "内置默认值" : source === "user" ? "来自用户层" : "来自项目层"} · 立即生效`);
    }
    if (section === "problems") { const footer = this.problemRows()[this.cursor]?.footer; return footer ? wrap(footer) : []; }
    const definition = this.entries()[this.cursor]?.definition;
    if (!definition) return [];
    return wrap([definition.description, ...(definition.skills?.length ? [`skills ${definition.skills.join("、")}`] : []), ...(definition.mcp?.length ? [`MCP ${definition.mcp.join("、")}`] : [])].join(" · "));
  }

  private hintFor(narrow: boolean): string {
    let hint: string;
    if (this.naming) hint = "回车 下一步  Esc 取消";
    else if (this.settingsTab.picking()) hint = this.settingsTab.hint();
    else if (this.switchPicker.picking()) hint = this.switchPicker.hint();
    else if (this.focus === "nav") hint = "↑↓ 选分类  → 进右栏  Esc 退出";
    else if (this.section === "models" || this.section === "switches") hint = "← 回左栏  ↑↓ 选择  回车 修改  R 清除本层  Esc 退出";
    else hint = `← 回左栏  ↑↓ 选择  回车 ${this.expanded ? "收起" : "详情"}${this.section === "problems" ? "" : "  C 复制"}  Esc 退出`;
    return narrow ? hint.replace("← 回左栏", "← 回目录").replace("→ 进右栏", "→ 进入") : hint;
  }

  private hintLines(width: number, hint: string): string[] {
    return wrapHint(hint, width - 1).map((line) => ` ${this.options.theme.fg("muted", line)}`);
  }
}
