import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRole, RoleCatalog, RoleCatalogEntry } from "./roles.ts";

const SOURCE = { default: "内置", user: "用户", project: "项目" } as const;
const PROBLEMS = "问题";
const TABS: readonly AgentRole[] = ["pm", "worker", "reviewer", "qa", "explore"];

export interface AgentCatalogTheme {
  fg?: (kind: string, text: string) => string;
  bg?: (kind: string, text: string) => string;
}

/** 只读角色目录：←→ 按职责切换，↑↓ 选择，回车看详情，C 复制；不提供编辑与开关。 */
export class AgentCatalogView {
  private tab = 0;
  private cursor = 0;
  private detail = false;

  private readonly options: { catalog: RoleCatalog; onCopy(entry: RoleCatalogEntry): void; onClose(): void; theme?: AgentCatalogTheme };

  constructor(options: AgentCatalogView["options"]) { this.options = options; }

  private tabs(): string[] {
    const { catalog } = this.options;
    return catalog.problems.length || catalog.roles.some((entry) => !entry.available) ? [...TABS, PROBLEMS] : [...TABS];
  }

  private entries(): RoleCatalogEntry[] {
    const tab = this.tabs()[this.tab];
    return this.options.catalog.roles.filter((entry) => tab === PROBLEMS ? !entry.available : entry.definition?.role === tab);
  }

  private selected(): RoleCatalogEntry | undefined { return this.entries()[this.cursor]; }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { if (this.detail) this.detail = false; else this.options.onClose(); return; }
    if (this.detail) { if (data === "c" || data === "C") this.copy(); return; }
    const tabs = this.tabs().length;
    if (matchesKey(data, "right")) { this.tab = (this.tab + 1) % tabs; this.cursor = 0; }
    else if (matchesKey(data, "left")) { this.tab = (this.tab + tabs - 1) % tabs; this.cursor = 0; }
    else if (matchesKey(data, "down")) this.cursor = Math.min(this.cursor + 1, Math.max(0, this.entries().length - 1));
    else if (matchesKey(data, "up")) this.cursor = Math.max(this.cursor - 1, 0);
    else if (matchesKey(data, "enter")) { if (this.selected()) this.detail = true; }
    else if (data === "c" || data === "C") this.copy();
  }

  private copy(): void {
    const entry = this.selected();
    if (entry?.available) this.options.onCopy(entry);
  }

  render(width: number): string[] {
    const clip = (text: string) => truncateToWidth(text, width);
    const muted = (text: string) => this.options.theme?.fg?.("muted", text) ?? text;
    const entry = this.selected();
    if (this.detail && entry) {
      const definition = entry.definition;
      const lines = [
        `${entry.name}（${SOURCE[entry.source]}）`,
        ...(definition ? [
          `职责：${definition.role}`,
          `描述：${definition.description}`,
          `模型：${definition.model ?? "继承主会话"}`,
          `思考等级：${definition.thinking ?? "继承主会话"}`,
          `MCP：${definition.mcp?.join("、") || "无"}`,
          `skills：${definition.skills?.join("、") || "无"}`,
        ] : [`不可用：${entry.reason ?? "未知原因"}`]),
        `覆盖：${entry.overrides?.map((source) => SOURCE[source]).join("、") || "无"}`,
        `文件：${entry.path}`,
        "",
        muted(entry.available ? "Esc 返回  C 复制为新定义（编辑请直接修改对应目录下的 md 文件）" : "Esc 返回"),
      ];
      return lines.map(clip);
    }
    const tabs = this.tabs().map((tab, index) => index === this.tab ? `[${tab}]` : tab).join("  ");
    const entries = this.entries();
    const rows = entries.map((item, index) => {
      const branch = index === entries.length - 1 ? "└" : "├";
      const overrides = item.overrides?.length ? `  ⤷覆盖 ${item.overrides.map((source) => SOURCE[source]).join("、")}` : "";
      const text = clip(`${branch} ${item.name}  ${SOURCE[item.source]}${overrides}${item.available ? "" : `  ⚠ ${item.reason ?? "不可用"}`}`);
      return index === this.cursor && this.options.theme?.bg ? this.options.theme.bg("selectedBg", text) : text;
    });
    const problems = this.tabs()[this.tab] === PROBLEMS ? this.options.catalog.problems.map((problem) => clip(`⚠ ${problem.dir}：${problem.reason}`)) : [];
    return [clip(`one-company 角色定义  ${tabs}`), ...(rows.length ? rows : [muted("（没有定义）")]), ...problems, "",
      clip(muted("←→ 分类  ↑↓ 选择  回车 详情  C 复制  Esc 退出"))];
  }

  invalidate(): void {}
}
