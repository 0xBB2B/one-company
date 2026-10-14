import { homedir } from "node:os";
import { basename } from "node:path";
import { decodeKittyPrintable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { fit, pad, SettingsTab } from "./agent-settings-ui.ts";
import type { ClearSettingRequest, SaveSettingRequest } from "./agent-settings-ui.ts";
import type { ModelLike } from "./agent-resolve.ts";
import { SETTINGS_ROLES, type SettingsRoleKey } from "./agent-settings.ts";
import type { readAgentSettings } from "./agent-settings.ts";
import { NAME_PATTERN, sameNameOnly } from "./roles.ts";
import type { RoleCatalog, RoleCatalogEntry, RoleDefinitionProblem, RoleSource } from "./roles.ts";

export interface AgentCatalogTheme {
  fg(kind: string, text: string): string;
  bg(kind: string, text: string): string;
  bold(text: string): string;
  inverse(text: string): string;
}
export interface CatalogNotice { tone: "ok" | "muted"; text: string }
/** 跨越一次复制前后保留的页面状态：停在哪个分类、选中哪一行、哪一行刚复制出来、底部提示。 */
export interface CatalogPageState { tab?: string; selectName?: string; fresh?: string; notice?: CatalogNotice }
export interface CopyRequest { entry: RoleCatalogEntry; name: string }

const ROLE_TABS = ["pm", "worker", "reviewer", "qa", "explore"] as const;
const SETTINGS_TAB = "设定", PROBLEMS_TAB = "问题";
const SOURCE_LABEL: Record<RoleSource, string> = { default: "内置", user: "用户", project: "项目" };
const MARKER = 2, SOURCE = 7, THINKING = 8, NAME = 15, MODEL = 19, MIN_COLUMN = 8, KEY = 8;
const WORD_CHAR = /[\w.~-]/u;
const NAME_RULE = "小写字母、数字、连字符，最多 64 个字符；三层里不能重名";

interface ProblemRow { file: string; tailFit?: boolean; source: RoleSource; short: string; tone: "error" | "info"; detail: Array<{ key: string; value: string; error?: boolean }>; footer: string }

const fitTail = (text: string, width: number) => {
  if (visibleWidth(text) <= width) return text;
  let kept = "";
  for (const char of [...text].reverse()) { if (visibleWidth(char + kept) > width - 1) break; kept = char + kept; }
  return `…${kept}`;
};
export const tilde = (path: string) => { const home = homedir(); return path.startsWith(home) ? `~${path.slice(home.length)}` : path; };

/** /one:agents 角色定义页：按职责分类的表格，回车就地展开，C 在页内输入新名称后交给调用方选层复制。 */
export class AgentCatalogView {
  private tabIndex = 0;
  private cursor = 0;
  private expanded = false;
  private width = 80;
  private notice: CatalogNotice | undefined;
  private fresh: string | undefined;
  private naming: { entry: RoleCatalogEntry; text: string; locked: boolean; error?: string } | undefined;
  private readonly options: {
    catalog: RoleCatalog; theme: AgentCatalogTheme; projectTrusted: boolean; untrustedProjectCount: number; state?: CatalogPageState;
    settings: Awaited<ReturnType<typeof readAgentSettings>>; models: readonly ModelLike[]; mainModel: ModelLike | undefined;
    nameTaken(name: string): string | undefined; onCopy(request: CopyRequest): void; onClose(): void;
    onSaveSetting(request: SaveSettingRequest): void; onClearSetting(request: ClearSettingRequest): void;
  };
  private readonly settingsTab: SettingsTab;

  constructor(options: AgentCatalogView["options"]) {
    this.options = options;
    this.settingsTab = new SettingsTab({ theme: options.theme, settings: options.settings, models: options.models, mainModel: options.mainModel, projectTrusted: options.projectTrusted,
      sourceTag: (source) => this.sourceTag(source), onSave: options.onSaveSetting, onClear: options.onClearSetting });
    const state = options.state;
    const tab = state?.tab ? this.tabs().indexOf(state.tab) : -1;
    if (tab >= 0) this.tabIndex = tab;
    if (state?.selectName) this.cursor = Math.max(0, this.rowNames().indexOf(state.selectName));
    this.fresh = state?.fresh;
    this.notice = state?.notice;
  }

  state(): CatalogPageState { return { tab: this.tab, ...(this.tab === SETTINGS_TAB ? { selectName: this.settingRole() } : {}) }; }

  private settingRole(): SettingsRoleKey { return SETTINGS_ROLES[this.cursor]!.key; }

  private rowNames(): string[] {
    return this.tab === SETTINGS_TAB ? SETTINGS_ROLES.map((role) => role.key) : this.tab === PROBLEMS_TAB ? [] : this.entries().map((entry) => entry.name);
  }

  private tabs(): string[] {
    return [...ROLE_TABS, SETTINGS_TAB, ...(this.problemRows().length ? [PROBLEMS_TAB] : [])];
  }
  private get tab(): string { return this.tabs()[this.tabIndex]!; }

  private entries(tab = this.tab): RoleCatalogEntry[] {
    return this.options.catalog.roles
      .filter((entry) => entry.available && entry.definition && entry.definition.role === tab)
      .sort((a, b) => Number(a.source === "default") - Number(b.source === "default") || a.name.localeCompare(b.name));
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
      } else if (problem.kind === "invalid") {
        rows.push(invalid(basename(problem.dir), problem.source, problem.dir, problem.problem, problem.reason));
      } else {
        rows.push({ file: tilde(problem.dir), source: problem.source, tone: "error", short: "目录读不了",
          detail: [{ key: "原因", value: problem.reason }], footer: "这一层的定义都没有加载" });
      }
    }
    for (const problem of this.options.settings.problems) {
      rows.push({ file: tilde(problem.path), tailFit: true, source: problem.layer, tone: "error", short: problem.display,
        detail: [{ key: "原因", value: problem.display }, { key: "文件", value: tilde(problem.path) },
          { key: "影响", value: problem.role ? "这一项没有生效，改用下一层" : "这一层的设定都没有生效，改用下一层" }], footer: "改正文件后重新打开本页" });
    }
    for (const entry of this.options.catalog.roles.filter((candidate) => !candidate.available)) {
      rows.push(invalid(basename(entry.path), entry.source, entry.path, entry.problem, entry.reason));
    }
    return rows;
  }

  private rowCount(): number { return this.tab === SETTINGS_TAB ? SETTINGS_ROLES.length : this.tab === PROBLEMS_TAB ? this.problemRows().length : this.entries().length; }

  handleInput(data: string): void {
    if (this.naming) { this.handleNaming(data); return; }
    this.notice = undefined; this.fresh = undefined;
    if (this.tab === SETTINGS_TAB) {
      if (this.settingsTab.picking()) { this.notice = this.settingsTab.handleInput(data); return; }
      if (matchesKey(data, "enter")) { this.settingsTab.start(this.settingRole()); return; }
      if (data === "r" || data === "R") { this.notice = this.settingsTab.clear(this.settingRole()); return; }
    }
    if (matchesKey(data, "escape")) { if (this.expanded) this.expanded = false; else this.options.onClose(); return; }
    const tabs = this.tabs().length;
    if (matchesKey(data, "right")) { this.tabIndex = (this.tabIndex + 1) % tabs; this.cursor = 0; this.expanded = false; return; }
    if (matchesKey(data, "left")) { this.tabIndex = (this.tabIndex + tabs - 1) % tabs; this.cursor = 0; this.expanded = false; return; }
    if (matchesKey(data, "down")) { this.cursor = Math.min(this.cursor + 1, Math.max(0, this.rowCount() - 1)); this.expanded = false; return; }
    if (matchesKey(data, "up")) { this.cursor = Math.max(this.cursor - 1, 0); this.expanded = false; return; }
    if (matchesKey(data, "enter")) { if (this.rowCount()) this.expanded = !this.expanded; return; }
    if ((data === "c" || data === "C") && this.tab !== PROBLEMS_TAB && this.tab !== SETTINGS_TAB) {
      const entry = this.entries()[this.cursor];
      if (!entry?.definition) return;
      const locked = sameNameOnly(entry.definition.role);
      this.naming = { entry, locked, text: locked ? entry.name : `${entry.name}-copy` };
    }
  }

  private handleNaming(data: string): void {
    const naming = this.naming!;
    if (matchesKey(data, "escape")) { this.naming = undefined; this.notice = { tone: "muted", text: "已取消复制" }; return; }
    if (matchesKey(data, "enter")) {
      if (!naming.locked) {
        if (!NAME_PATTERN.test(naming.text)) { naming.error = "只能用小写字母、数字和连字符，例如 ui-worker"; return; }
        const taken = this.options.nameTaken(naming.text);
        if (taken) { naming.error = `${taken}已经有 ${naming.text}，换一个名字`; return; }
      }
      this.options.onCopy({ entry: naming.entry, name: naming.text });
      return;
    }
    if (naming.locked) return;
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

  private describe(entry: RoleCatalogEntry): string {
    const definition = entry.definition!;
    return [definition.description, ...(definition.skills?.length ? [`skills ${definition.skills.join("、")}`] : []),
      ...(definition.mcp?.length ? [`MCP ${definition.mcp.join("、")}`] : [])].join(" · ");
  }

  private hint(): string {
    if (this.tab === SETTINGS_TAB) return "←→ 分类  ↑↓ 选择  回车 修改  R 清除本层  Esc 退出";
    if (this.tab === PROBLEMS_TAB) return this.expanded ? "回车 收起  Esc 收起" : "←→ 分类  ↑↓ 选择  回车 详情  Esc 退出";
    const selected = this.entries()[this.cursor];
    const copy = selected?.definition && sameNameOnly(selected.definition.role) ? "C 复制（只能同名）" : "C 复制";
    return this.expanded ? `回车 收起  ${copy}  Esc 收起` : `←→ 分类  ↑↓ 选择  回车 详情  ${copy}  Esc 退出`;
  }

  render(width: number): string[] {
    this.width = width;
    const { theme } = this.options;
    const edge = theme.fg("border", "─".repeat(width));
    if (this.naming) return [edge, ...this.renderNaming(width), edge];
    if (this.tab === SETTINGS_TAB && this.settingsTab.picking()) return [edge, ...this.settingsTab.renderPicker(width), edge];
    const muted = (text: string) => theme.fg("muted", text), dim = (text: string) => theme.fg("dim", text);
    const lines = [edge, this.header(width), this.tabsLine(width), dim("─".repeat(width))];
    const body = this.tab === SETTINGS_TAB ? this.settingsTab.renderList(width, this.cursor, this.fresh) : this.tab === PROBLEMS_TAB ? this.problemTable(width) : this.entryTable(width);
    const height = Math.max(SETTINGS_ROLES.length + 1, ...ROLE_TABS.map((tab) => this.entries(tab).length + 1), this.problemRows().length + 1);
    while (body.length < height) body.push("");
    lines.push(...body, dim("─".repeat(width)));
    if (!this.expanded) {
      if (this.notice) lines.push(` ${theme.fg(this.notice.tone === "ok" ? "success" : "muted", fit(this.notice.text, width - 1))}`);
      else if (this.tab === SETTINGS_TAB) lines.push(` ${this.settingsTab.footer(this.settingRole(), width)}`);
      else {
        const footer = this.tab === PROBLEMS_TAB ? this.problemRows()[this.cursor]?.footer : this.entries()[this.cursor] && this.describe(this.entries()[this.cursor]!);
        lines.push(footer ? ` ${muted(fit(footer, width - 1))}` : "");
      }
    }
    lines.push(` ${muted(fit(this.hint(), width - 1))}`, edge);
    return lines;
  }

  private header(width: number): string {
    const { theme, catalog, projectTrusted } = this.options;
    const counts: Record<RoleSource, number> = { default: 0, user: 0, project: 0 };
    for (const entry of catalog.roles.filter((candidate) => candidate.available)) for (const source of [entry.source, ...(entry.overrides ?? [])]) counts[source]++;
    const left = " 角色定义";
    const right = `内置 ${counts.default} · 用户 ${counts.user}${projectTrusted ? ` · 项目 ${counts.project}` : ""} `;
    const space = width - visibleWidth(left) - visibleWidth(right);
    return theme.fg("accent", theme.bold(left)) + (space >= 1 ? " ".repeat(space) + theme.fg("muted", right) : "");
  }

  private tabsLine(width: number): string {
    const { theme } = this.options;
    const selected = this.tab;
    const count = (tab: string) => tab === SETTINGS_TAB ? SETTINGS_ROLES.length : tab === PROBLEMS_TAB ? this.problemRows().length : this.entries(tab).length;
    const right = [SETTINGS_TAB, ...(this.problemRows().length ? [PROBLEMS_TAB] : [])].map((tab) => ({ tab, text: ` ${tab} ${count(tab)} ` }));
    let left: Array<{ tab: string; text: string }> = ROLE_TABS.map((tab) => ({ tab, text: ` ${tab} ${count(tab)} ` }));
    const rightWidth = 2 + right.reduce((sum, item) => sum + visibleWidth(item.text), 0) + (right.length - 1);
    const leftWidth = () => 1 + left.reduce((sum, item) => sum + visibleWidth(item.text), 0) + (left.length - 1);
    if (leftWidth() + 2 + rightWidth > width) left = left.map((item) => item.tab === selected ? item : { tab: item.tab, text: ` ${item.tab} ` });
    while (leftWidth() + 2 + rightWidth > width) {
      const index = left.map((item) => item.tab).lastIndexOf(left.findLast((item) => item.tab !== selected && item.tab !== "…")?.tab ?? "");
      if (index < 0) break;
      left.splice(index, 1);
      if (left.at(-1)?.tab !== "…") left.push({ tab: "…", text: " … " });
    }
    const style = (item: { tab: string; text: string }) => {
      const problem = item.tab === PROBLEMS_TAB;
      if (item.tab === selected) return theme.bg("selectedBg", theme.fg(problem ? "error" : "accent", theme.bold(item.text)));
      return theme.fg(problem ? "error" : "muted", item.text);
    };
    const space = Math.max(2, width - leftWidth() - rightWidth);
    return ` ${left.map(style).join(" ")}${" ".repeat(space)}${theme.fg("dim", "│")} ${right.map(style).join(" ")}`;
  }

  private columns(width: number) {
    let name = NAME, model = MODEL;
    const total = () => MARKER + 1 + name + 1 + SOURCE + 1 + model + 1 + THINKING;
    if (total() > width) model = Math.max(MIN_COLUMN, model - (total() - width));
    if (total() > width) name = Math.max(MIN_COLUMN, name - (total() - width));
    return { name, model };
  }

  private entryTable(width: number): string[] {
    const { theme } = this.options, cols = this.columns(width);
    const lines = [theme.fg("muted", `${" ".repeat(MARKER + 1)}${pad("名称", cols.name)} ${pad("来源", SOURCE)} ${pad("模型", cols.model)} 思考`)];
    this.entries().forEach((entry, index) => {
      const definition = entry.definition!, selected = index === this.cursor;
      const cell = (text: string, style?: (text: string) => string) => selected ? theme.bg("selectedBg", style ? style(text) : text) : style ? style(text) : text;
      const name = fit(entry.name, cols.name);
      const model = fit(definition.model ?? "继承主会话", cols.model);
      const thinking = definition.thinking ?? "继承";
      const plainWidth = MARKER + 1 + cols.name + 1 + SOURCE + 1 + cols.model + 1 + visibleWidth(thinking);
      lines.push([
        cell(pad(selected ? (this.expanded ? " ⌄" : " ›") : "", MARKER), (text) => theme.fg("accent", text)),
        cell(" "), cell(name, this.fresh === entry.name ? (text) => theme.fg("success", text) : undefined), cell(" ".repeat(cols.name - visibleWidth(name) + 1)),
        selected ? theme.bg("selectedBg", this.sourceTag(entry.source)) : this.sourceTag(entry.source), cell(" ".repeat(SOURCE - 6 + 1)),
        cell(model, (text) => theme.fg(definition.model ? "accent" : "dim", text)), cell(" ".repeat(cols.model - visibleWidth(model) + 1)),
        cell(thinking, definition.thinking ? undefined : (text) => theme.fg("dim", text)),
        ...(selected ? [cell(" ".repeat(Math.max(0, width - plainWidth)))] : []),
      ].join(""));
      if (selected && this.expanded) lines.push(...this.entryDetail(entry));
    });
    return lines;
  }

  private detailLine(key: string | undefined, value: string, style?: (text: string) => string): string[] {
    const { theme } = this.options;
    const indent = 5 + (key ? KEY : 0), room = Math.max(MIN_COLUMN, this.width - indent);
    const chunks: string[] = [""];
    for (const char of value) {
      const line = chunks.at(-1)!;
      if (visibleWidth(line + char) <= room) { chunks[chunks.length - 1] = line + char; continue; }
      let cut = -1;
      if (WORD_CHAR.test(char)) for (let i = line.length - 1; i >= 0 && cut < 0; i--) if (!WORD_CHAR.test(line[i]!)) cut = i;
      if (cut > 0 && cut < line.length - 1) { chunks[chunks.length - 1] = line.slice(0, cut + 1).trimEnd(); chunks.push(line.slice(cut + 1) + char); }
      else chunks.push(char === " " ? "" : char);
    }
    return chunks.map((chunk, index) => {
      const head = key ? (index === 0 ? theme.fg("muted", pad(key, KEY)) : " ".repeat(KEY)) : "";
      return `   ${theme.fg("dim", "┊ ")}${head}${style ? style(chunk) : chunk}`;
    });
  }

  private entryDetail(entry: RoleCatalogEntry): string[] {
    const { theme } = this.options, definition = entry.definition!, dim = (text: string) => theme.fg("dim", text);
    return [...this.detailLine(undefined, definition.description),
      ...this.detailLine("skills", definition.skills?.join("、") || "无", definition.skills?.length ? undefined : dim),
      ...this.detailLine("MCP", definition.mcp?.join("、") || "无", definition.mcp?.length ? undefined : dim),
      ...this.detailLine("文件", tilde(entry.path), dim)];
  }

  private problemTable(width: number): string[] {
    const { theme } = this.options, name = NAME;
    const lines = [theme.fg("muted", `${" ".repeat(MARKER + 1)}${pad("文件", name)} ${pad("层", SOURCE)} 原因`)];
    this.problemRows().forEach((row, index) => {
      const selected = index === this.cursor;
      const cell = (text: string, style?: (text: string) => string) => selected ? theme.bg("selectedBg", style ? style(text) : text) : style ? style(text) : text;
      const reasonWidth = Math.max(MIN_COLUMN, width - (MARKER + 1 + name + 1 + SOURCE + 1));
      const short = fit(row.short, reasonWidth);
      const plainWidth = MARKER + 1 + name + 1 + SOURCE + 1 + visibleWidth(short);
      lines.push([
        cell(pad(selected ? (this.expanded ? " ⌄" : " ›") : "", MARKER), (text) => theme.fg("accent", text)), cell(" "),
        cell(pad(row.tailFit ? fitTail(row.file, name) : fit(row.file, name), name)), cell(" "),
        selected ? theme.bg("selectedBg", this.sourceTag(row.source, row.tone === "info")) : this.sourceTag(row.source, row.tone === "info"), cell(" ".repeat(SOURCE - 6 + 1)),
        cell(short, (text) => theme.fg(row.tone === "error" ? "error" : "muted", text)),
        ...(selected ? [cell(" ".repeat(Math.max(0, width - plainWidth)))] : []),
      ].join(""));
      if (selected && this.expanded) {
        for (const item of row.detail) lines.push(...this.detailLine(item.key, item.value, item.error ? (text) => theme.fg("error", text) : item.key === "文件" || item.key === "目录" ? (text) => theme.fg("dim", text) : undefined));
      }
    });
    return lines;
  }

  private renderNaming(width: number): string[] {
    const { theme } = this.options, naming = this.naming!, muted = (text: string) => theme.fg("muted", text), dim = (text: string) => theme.fg("dim", text);
    if (naming.locked) {
      return [` ${theme.bold(`复制 ${naming.entry.name}`)}`, "",
        ` ${muted(pad("名称", KEY))}${naming.entry.name}  ${dim("（只能同名，不能改）")}`, "", ` ${muted("回车 下一步  Esc 取消")}`];
    }
    return [` ${theme.bold(`复制 ${naming.entry.name} 为新定义`)}`, "",
      ` ${muted("新名称")}  ${fit(`${naming.text}█`, Math.max(MIN_COLUMN, width - 9))}`,
      ` ${naming.error ? theme.fg("error", `✗ ${naming.error}`) : dim(fit(NAME_RULE, width - 1))}`, "", ` ${muted("回车 下一步  Esc 取消")}`];
  }

  invalidate(): void {}
}
