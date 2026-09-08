export type SettingsField = "model" | "thinking" | "mcp";
export type SettingsScope = "global" | "project";
export type FieldSourceKind = "project" | "global" | "default";

export interface RoleEntryLike {
  model?: string;
  thinking?: string;
  mcp?: string[];
}

export interface ModelInfo {
  provider: string;
  id: string;
  thinkingLevels: string[];
}

export interface SettingsModelsContext {
  available: ModelInfo[];
  sessionModel: string;
  sessionThinking: string;
}

export interface SettingsLayerInput {
  roles: Record<string, RoleEntryLike>;
}

export interface SettingsCatalogEntry {
  name: string;
}

export type SaveField = (scope: SettingsScope, role: string, field: SettingsField, value: unknown) => Promise<void>;

export interface CreateSettingsSessionInput {
  catalog: { roles: SettingsCatalogEntry[] };
  settings: { global: SettingsLayerInput; project: SettingsLayerInput | null };
  scope: SettingsScope;
  models: SettingsModelsContext;
  mcp: { detected: string[] };
  save: SaveField;
}

export interface TitleRow {
  kind: "title";
  text: string;
}
export interface ScopeOption {
  label: string;
  value: SettingsScope;
  active: boolean;
}
export interface ScopeRow {
  kind: "scope";
  options: ScopeOption[];
}
export interface RoleOption {
  label: string;
  value: string;
  active: boolean;
}
export interface RolesRow {
  kind: "roles";
  options: RoleOption[];
}
export interface FieldTitleRow {
  kind: "field-title";
  field: SettingsField;
  source: FieldSourceKind;
  text: string;
  selected: boolean;
}
export interface FieldValueRow {
  kind: "field-value";
  field: SettingsField;
  text: string;
  selected: boolean;
}
export interface HintRow {
  kind: "hint";
  text: string;
}
export type SettingsRow = TitleRow | ScopeRow | RolesRow | FieldTitleRow | FieldValueRow | HintRow;

export interface CandidateItem {
  value: string;
  label: string;
  unavailable?: boolean;
  checked?: boolean;
}

export interface SettingsCandidatePage {
  field: SettingsField;
  title: string;
  searchable: boolean;
  query: string;
  items(): CandidateItem[];
  cursor(): number;
  setQuery(query: string): void;
  press(key: string): Promise<void>;
}

export type SettingsReceipt = { ok: true } | { ok: false; reason: string };

export interface SettingsSession {
  homeRows(): SettingsRow[];
  currentRole(): string;
  currentField(): SettingsField;
  currentScope(): SettingsScope;
  pressHome(key: string): void;
  candidatePage(): SettingsCandidatePage | null;
  lastReceipt(): SettingsReceipt | null;
  isClosed(): boolean;
}

interface RoleLayerState {
  roles: Record<string, RoleEntryLike>;
}

interface CandidateState {
  field: SettingsField;
  role: string;
  title: string;
  searchable: boolean;
  query: string;
  cursorValue: string;
  checkedValues: Set<string>;
}

interface SessionState {
  roles: string[];
  roleIndex: number;
  field: SettingsField;
  scope: SettingsScope;
  layers: { global: RoleLayerState; project: RoleLayerState | null };
  models: SettingsModelsContext;
  detectedMcp: string[];
  save: SaveField;
  candidate: CandidateState | null;
  confirmPending: boolean;
  receipt: SettingsReceipt | null;
  closed: boolean;
}

const FIELD_ORDER: SettingsField[] = ["model", "thinking", "mcp"];
const FIELD_LABEL: Record<SettingsField, string> = { model: "模型", thinking: "思考", mcp: "MCP" };
const SOURCE_LABEL: Record<FieldSourceKind, string> = { project: "项目", global: "全局", default: "默认" };
export const SETTINGS_HINT_TEXT = "←→ 角色 · ↑↓ 字段 · Tab 范围 · Enter 修改 · Esc 关闭";

function currentRoleName(state: SessionState): string {
  return state.roles[state.roleIndex] as string;
}

function layerEntry(layer: RoleLayerState | null | undefined, role: string): RoleEntryLike | undefined {
  return layer?.roles[role];
}

export function fieldSource(state: SessionState, role: string, field: SettingsField): FieldSourceKind {
  const projectEntry = layerEntry(state.layers.project, role);
  if (projectEntry?.[field] !== undefined) return "project";
  const globalEntry = layerEntry(state.layers.global, role);
  if (globalEntry?.[field] !== undefined) return "global";
  return "default";
}

function resolvedRawValue(state: SessionState, role: string, field: SettingsField): unknown {
  const projectEntry = layerEntry(state.layers.project, role);
  if (projectEntry?.[field] !== undefined) return projectEntry[field];
  const globalEntry = layerEntry(state.layers.global, role);
  if (globalEntry?.[field] !== undefined) return globalEntry[field];
  return undefined;
}

function scopedMcpChosen(state: SessionState, role: string): string[] {
  if (state.scope === "project") {
    const projectEntry = layerEntry(state.layers.project, role);
    if (projectEntry?.mcp !== undefined) return projectEntry.mcp;
  }
  const globalEntry = layerEntry(state.layers.global, role);
  return globalEntry?.mcp ?? [];
}

function fieldValueText(state: SessionState, role: string, field: SettingsField): string {
  if (field === "mcp") {
    const chosen = (resolvedRawValue(state, role, field) as string[] | undefined) ?? [];
    if (chosen.length === 0) return "无";
    return chosen.map((id) => (state.detectedMcp.includes(id) ? id : `${id}（不可用）`)).join("、");
  }
  const raw = resolvedRawValue(state, role, field) as string | undefined;
  if (raw === undefined || raw === "inherit") {
    return field === "model" ? "沿用主会话" : "使用上级/角色默认";
  }
  return raw;
}

function buildRows(state: SessionState): SettingsRow[] {
  const role = currentRoleName(state);
  const rows: SettingsRow[] = [];
  rows.push({ kind: "title", text: "设置" });
  rows.push({
    kind: "scope",
    options: [
      { label: "全局", value: "global", active: state.scope === "global" },
      { label: "项目", value: "project", active: state.scope === "project" },
    ],
  });
  rows.push({
    kind: "roles",
    options: state.roles.map((name, index) => ({ label: name, value: name, active: index === state.roleIndex })),
  });
  for (const field of FIELD_ORDER) {
    const source = fieldSource(state, role, field);
    rows.push({
      kind: "field-title",
      field,
      source,
      text: `${FIELD_LABEL[field]} - ${SOURCE_LABEL[source]}`,
      selected: state.field === field,
    });
    rows.push({
      kind: "field-value",
      field,
      text: fieldValueText(state, role, field),
      selected: state.field === field,
    });
  }
  rows.push({ kind: "hint", text: SETTINGS_HINT_TEXT });
  return rows;
}

export function settingsRows(state: SessionState): SettingsRow[] {
  return buildRows(state);
}

function effectiveModelId(state: SessionState, role: string): string {
  const raw = resolvedRawValue(state, role, "model") as string | undefined;
  if (raw !== undefined && raw !== "inherit") return raw;
  return state.models.sessionModel;
}

export function modelCandidates(state: SessionState, query: string): CandidateItem[] {
  const items: CandidateItem[] = [{ value: "inherit", label: "沿用主会话" }];
  for (const model of state.models.available) {
    const value = `${model.provider}/${model.id}`;
    items.push({ value, label: value });
  }
  if (!query) return items;
  const needle = query.toLowerCase();
  return items.filter((item) => item.label.toLowerCase().includes(needle));
}

export function thinkingCandidates(state: SessionState, role: string): CandidateItem[] {
  const modelId = effectiveModelId(state, role);
  const model = state.models.available.find((entry) => `${entry.provider}/${entry.id}` === modelId);
  const levels = model ? model.thinkingLevels : [];
  return [{ value: "inherit", label: "使用上级/角色默认" }, ...levels.map((level) => ({ value: level, label: level }))];
}

export function mcpCandidates(state: SessionState, role: string): CandidateItem[] {
  const chosen = scopedMcpChosen(state, role);
  const detected = state.detectedMcp;
  const extra = chosen.filter((id) => !detected.includes(id));
  return [...detected, ...extra].map((id) => ({
    value: id,
    label: id,
    unavailable: !detected.includes(id),
    checked: chosen.includes(id),
  }));
}

function candidateItems(state: SessionState): CandidateItem[] {
  const candidate = state.candidate;
  if (!candidate) return [];
  if (candidate.field === "model") return modelCandidates(state, candidate.query);
  if (candidate.field === "thinking") return thinkingCandidates(state, candidate.role);
  return mcpCandidates(state, candidate.role).map((item) => ({
    ...item,
    checked: candidate.checkedValues.has(item.value),
  }));
}

function openCandidate(state: SessionState, field: SettingsField): void {
  const role = currentRoleName(state);
  let title: string;
  let searchable: boolean;
  let items: CandidateItem[];
  if (field === "model") {
    title = `${role} 模型选择`;
    searchable = true;
    items = modelCandidates(state, "");
  } else if (field === "thinking") {
    title = `${role} 思考选择`;
    searchable = false;
    items = thinkingCandidates(state, role);
  } else {
    title = `${role} MCP 选择`;
    searchable = false;
    items = mcpCandidates(state, role);
  }

  const checkedValues = new Set(items.filter((item) => item.checked).map((item) => item.value));

  let cursorValue: string;
  if (field === "mcp") {
    cursorValue = items[0]?.value ?? "";
  } else {
    const raw = resolvedRawValue(state, role, field) as string | undefined;
    const initial = raw === undefined || raw === "inherit" ? "inherit" : raw;
    cursorValue = items.some((item) => item.value === initial) ? initial : (items[0]?.value ?? "inherit");
  }

  state.candidate = { field, role, title, searchable, query: "", cursorValue, checkedValues };
}

function moveCandidateCursor(state: SessionState, direction: "up" | "down"): void {
  const candidate = state.candidate;
  if (!candidate) return;
  const items = candidateItems(state);
  if (items.length === 0) return;
  const index = items.findIndex((item) => item.value === candidate.cursorValue);
  const current = index === -1 ? 0 : index;
  const next = direction === "down" ? Math.min(items.length - 1, current + 1) : Math.max(0, current - 1);
  candidate.cursorValue = items[next]!.value;
}

export async function saveField(
  state: SessionState,
  role: string,
  field: SettingsField,
  value: unknown,
): Promise<SettingsReceipt> {
  const scope = state.scope;
  try {
    await state.save(scope, role, field, value);
    const layer = scope === "project" ? (state.layers.project ?? (state.layers.project = { roles: {} })) : state.layers.global;
    const entry: RoleEntryLike = { ...(layer.roles[role] ?? {}) };
    const isDefaultValue = field !== "mcp" && value === "inherit";
    if (isDefaultValue) {
      delete entry[field];
    } else {
      (entry as Record<SettingsField, unknown>)[field] = value;
    }
    if (Object.keys(entry).length === 0) {
      delete layer.roles[role];
    } else {
      layer.roles[role] = entry;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

export async function applyCandidateKey(state: SessionState, key: string): Promise<void> {
  const candidate = state.candidate;
  if (!candidate) return;
  if (key === "up" || key === "down") {
    moveCandidateCursor(state, key);
    return;
  }
  if (key === "space") {
    if (candidate.field === "mcp") {
      if (candidate.checkedValues.has(candidate.cursorValue)) candidate.checkedValues.delete(candidate.cursorValue);
      else candidate.checkedValues.add(candidate.cursorValue);
    }
    return;
  }
  if (key === "escape") {
    state.candidate = null;
    return;
  }
  if (key === "enter") {
    if (state.confirmPending) return;
    if (candidate.field !== "mcp" && candidateItems(state).length === 0) return;
    state.confirmPending = true;
    const role = candidate.role;
    const field = candidate.field;
    const value: unknown =
      field === "mcp"
        ? candidateItems(state)
            .filter((item) => candidate.checkedValues.has(item.value))
            .map((item) => item.value)
        : candidate.cursorValue;
    const receipt = await saveField(state, role, field, value);
    state.receipt = receipt;
    state.candidate = null;
    state.confirmPending = false;
    return;
  }
}

export function applyMainPageKey(state: SessionState, key: string): void {
  state.receipt = null;
  if (key === "left") state.roleIndex = Math.max(0, state.roleIndex - 1);
  else if (key === "right") state.roleIndex = Math.min(state.roles.length - 1, state.roleIndex + 1);
  else if (key === "up") {
    const index = FIELD_ORDER.indexOf(state.field);
    state.field = FIELD_ORDER[(index - 1 + FIELD_ORDER.length) % FIELD_ORDER.length] as SettingsField;
  } else if (key === "down") {
    const index = FIELD_ORDER.indexOf(state.field);
    state.field = FIELD_ORDER[(index + 1) % FIELD_ORDER.length] as SettingsField;
  } else if (key === "tab") state.scope = state.scope === "global" ? "project" : "global";
  else if (key === "enter") openCandidate(state, state.field);
  else if (key === "escape") state.closed = true;
}

export function createSettingsSession(input: CreateSettingsSessionInput): SettingsSession {
  const state: SessionState = {
    roles: input.catalog.roles.map((role) => role.name),
    roleIndex: 0,
    field: "model",
    scope: input.scope,
    layers: {
      global: { roles: { ...input.settings.global.roles } },
      project: input.settings.project ? { roles: { ...input.settings.project.roles } } : null,
    },
    models: input.models,
    detectedMcp: input.mcp.detected,
    save: input.save,
    candidate: null,
    confirmPending: false,
    receipt: null,
    closed: false,
  };

  function candidatePage(): SettingsCandidatePage | null {
    const candidate = state.candidate;
    if (!candidate) return null;
    return {
      field: candidate.field,
      title: candidate.title,
      searchable: candidate.searchable,
      query: candidate.query,
      items: () => candidateItems(state),
      cursor: () => {
        const items = candidateItems(state);
        const index = items.findIndex((item) => item.value === candidate.cursorValue);
        return index === -1 ? 0 : index;
      },
      setQuery: (query: string) => {
        if (!candidate.searchable) return;
        candidate.query = query;
        const filtered = candidateItems(state);
        candidate.cursorValue = filtered[0]?.value ?? "";
      },
      press: (key: string) => applyCandidateKey(state, key),
    };
  }

  return {
    homeRows: () => settingsRows(state),
    currentRole: () => currentRoleName(state),
    currentField: () => state.field,
    currentScope: () => state.scope,
    pressHome: (key: string) => applyMainPageKey(state, key),
    candidatePage,
    lastReceipt: () => state.receipt,
    isClosed: () => state.closed,
  };
}

export interface SettingsTheme {
  fg?: (kind: string, text: string) => string;
  bg?: (kind: string, text: string) => string;
}

export interface CreateSettingsComponentOptions {
  theme?: SettingsTheme;
  onClose?: () => void;
  rows?: () => number;
  requestRender?: () => void;
}

export interface SettingsComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  getText(): string;
  setText(text: string): void;
  invalidate(): void;
}

function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  return width;
}

function clipToWidth(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  let result = "";
  let width = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (width + w > maxWidth) break;
    result += ch;
    width += w;
  }
  return result;
}

function wrapText(text: string, maxWidth: number): string[] {
  if (displayWidth(text) <= maxWidth) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && displayWidth(candidate) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

const EMPTY_CANDIDATE_TEXT = "没有可选项";

export function createSettingsComponent(
  session: SettingsSession,
  options: CreateSettingsComponentOptions = {},
): SettingsComponent {
  const theme = options.theme;
  const onClose = options.onClose;
  let confirming = false;

  function renderScopeLine(row: ScopeRow): string {
    return row.options.map((option) => (option.active ? `[${option.label}]` : option.label)).join("  ");
  }

  function renderRolesLine(row: RolesRow): string {
    return row.options.map((option) => (option.active ? `[${option.value}]` : option.value)).join(" ");
  }

  function renderBorder(width: number): string {
    const border = "─".repeat(width);
    return theme?.fg ? theme.fg("border", border) : border;
  }

  function buildHomeBlocks(contentWidth: number): string[][] {
    const clip = (text: string) => clipToWidth(text, contentWidth);
    const rows = session.homeRows();
    const titleRow = rows.find((row): row is TitleRow => row.kind === "title")!;
    const scopeRow = rows.find((row): row is ScopeRow => row.kind === "scope")!;
    const rolesRow = rows.find((row): row is RolesRow => row.kind === "roles")!;
    const hintRow = rows.find((row): row is HintRow => row.kind === "hint")!;

    const blocks: string[][] = [
      [clip(titleRow.text), clip(renderScopeLine(scopeRow))],
      wrapText(renderRolesLine(rolesRow), contentWidth).map(clip),
    ];
    for (const field of FIELD_ORDER) {
      const titleR = rows.find((row): row is FieldTitleRow => row.kind === "field-title" && row.field === field)!;
      const valueR = rows.find((row): row is FieldValueRow => row.kind === "field-value" && row.field === field)!;
      const sourceLabel = SOURCE_LABEL[titleR.source];
      const titlePrefix = clip(`${FIELD_LABEL[field]} - `);
      const titleLine = `${titlePrefix}${theme?.fg ? theme.fg("muted", sourceLabel) : sourceLabel}`;
      const rawValueLine = clip(`  ${valueR.text}`);
      const valueLine = valueR.selected && theme?.bg ? theme.bg("selectedBg", rawValueLine) : rawValueLine;
      blocks.push([titleLine, valueLine]);
    }

    const receipt = session.lastReceipt();
    if (receipt && !receipt.ok) blocks.push([clip(receipt.reason)]);

    blocks.push(wrapText(hintRow.text, contentWidth).map(clip));
    return blocks;
  }

  function homeLinesFromBlocks(blocks: string[][], compact: boolean): string[] {
    if (compact) return blocks.flat();
    const out: string[] = [];
    blocks.forEach((block, index) => {
      if (index > 0) out.push("");
      out.push(...block);
    });
    return out;
  }

  function candidateHint(field: SettingsField): string {
    if (field === "mcp") return "↑↓ 选择 · Space 勾选 · Enter 确认 · Esc 取消";
    if (field === "model") return "↑↓ 选择 · 输入搜索 · Enter 确认 · Esc 取消";
    return "↑↓ 选择 · Enter 确认 · Esc 取消";
  }

  function renderCandidateItemLine(item: CandidateItem, isCursor: boolean, field: SettingsField, clip: (text: string) => string): string {
    if (field === "mcp") {
      const mark = item.checked ? "x" : " ";
      const suffix = item.unavailable ? "（不可用）" : "";
      const line = clip(`${isCursor ? "› " : "  "}[${mark}] ${item.label}${suffix}`);
      return isCursor && theme?.bg ? theme.bg("selectedBg", line) : line;
    }
    const line = clip(`${isCursor ? "› " : "  "}${item.label}`);
    return isCursor && theme?.bg ? theme.bg("selectedBg", line) : line;
  }

  function renderCandidateContent(page: SettingsCandidatePage, contentWidth: number, availableRows?: number): string[] {
    const clip = (text: string) => clipToWidth(text, contentWidth);
    const titleLine = clip(page.title);
    const searchLine = page.searchable ? clip(`搜索：${page.query}`) : undefined;
    const hintLines = wrapText(candidateHint(page.field), contentWidth).map(clip);
    const items = page.items();
    const cursor = page.cursor();

    if (items.length === 0) {
      return [titleLine, ...(searchLine !== undefined ? [searchLine] : []), clip(EMPTY_CANDIDATE_TEXT), ...hintLines];
    }

    const fixedCount = 1 + (searchLine !== undefined ? 1 : 0) + hintLines.length;
    let windowStart = 0;
    let windowEnd = items.length;
    if (availableRows !== undefined) {
      const itemBudget = Math.max(0, availableRows - fixedCount);
      if (items.length > itemBudget) {
        windowStart = Math.max(0, Math.min(cursor - Math.floor(itemBudget / 2), items.length - itemBudget));
        windowEnd = windowStart + itemBudget;
      }
    }

    const itemLines = items
      .slice(windowStart, windowEnd)
      .map((item, offset) => renderCandidateItemLine(item, windowStart + offset === cursor, page.field, clip));

    return [titleLine, ...(searchLine !== undefined ? [searchLine] : []), ...itemLines, ...hintLines];
  }

  function render(width: number): string[] {
    const border = renderBorder(width);
    const contentWidth = Math.min(72, width);
    const availableRows = options.rows?.();
    const page = session.candidatePage();
    if (page) {
      const contentBudget = availableRows !== undefined ? availableRows - 2 : undefined;
      return [border, ...renderCandidateContent(page, contentWidth, contentBudget), border];
    }

    const blocks = buildHomeBlocks(contentWidth);
    const expanded = homeLinesFromBlocks(blocks, false);
    const compact = availableRows !== undefined && expanded.length + 2 > availableRows;
    const content = compact ? homeLinesFromBlocks(blocks, true) : expanded;
    return [border, ...content, border];
  }

  function handleCandidateInput(page: SettingsCandidatePage, data: string): void {
    if (data === "\x1b[A") {
      void page.press("up");
      return;
    }
    if (data === "\x1b[B") {
      void page.press("down");
      return;
    }
    if (data === "\r") {
      if (confirming) return;
      confirming = true;
      page.press("enter").finally(() => {
        confirming = false;
        options.requestRender?.();
      });
      return;
    }
    if (data === "\x1b") {
      void page.press("escape");
      return;
    }
    if (data === " ") {
      if (page.field === "mcp") void page.press("space");
      else if (page.searchable) page.setQuery(`${page.query} `);
      return;
    }
    if (page.searchable && (data === "\x7f" || data === "\b")) {
      page.setQuery(page.query.slice(0, -1));
      return;
    }
    if (page.searchable && data.length === 1 && data >= " ") {
      page.setQuery(page.query + data);
    }
  }

  function handleHomeInput(data: string): void {
    if (data === "\x1b[C") session.pressHome("right");
    else if (data === "\x1b[D") session.pressHome("left");
    else if (data === "\x1b[A") session.pressHome("up");
    else if (data === "\x1b[B") session.pressHome("down");
    else if (data === "\t") session.pressHome("tab");
    else if (data === "\r") session.pressHome("enter");
    else if (data === "\x1b") {
      session.pressHome("escape");
      if (session.isClosed()) onClose?.();
    }
  }

  function handleInput(data: string): void {
    const page = session.candidatePage();
    if (page) handleCandidateInput(page, data);
    else handleHomeInput(data);
  }

  let hostText = "";
  return {
    render,
    handleInput,
    getText: () => hostText,
    setText: (text: string) => {
      hostText = text;
    },
    invalidate: () => {},
  };
}
