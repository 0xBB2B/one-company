import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { promisify } from "node:util";
import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  ExtensionAPI,
  ModelRuntime,
  SessionManager,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { checkMcpCall, describeMcpStatus, loadMcpForRole } from "../runtime/mcp.ts";
import type { McpConfig } from "../runtime/mcp.ts";
import { classifyFailure } from "../runtime/network-pause.ts";
import type { NetworkPauseGate } from "../runtime/network-pause.ts";
import type { RoleCatalogEntry, RoleDefinition, RoleKind } from "../runtime/roles.ts";
import { ResultCollector } from "../runtime/result.ts";
import type { Phase } from "../runtime/result.ts";
import { createSessionManagerForRun, openSessionManagerForRun } from "../runtime/session-records.ts";
import { createManagedBashTool } from "../runtime/shell-bash.ts";
import type { Host, ShellRegistry, StopResult } from "../runtime/shell-registry.ts";
import type { Clock, TimerHandle } from "../runtime/clock.ts";

const execFileAsync = promisify(execFile);

export interface RoleSessionGuards {
  checkWrite(path: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  fingerprint(paths: string[]): Promise<Record<string, string>>;
  verifyFingerprint(fp: Record<string, string>): Promise<Array<{ path: string }>>;
}

export interface RoleSessionMcpOptions {
  servers: string[];
  entryPath?: string;
  packageDir?: string;
  config?: McpConfig;
}

interface CreateRoleSessionBaseOptions {
  dataRoot: string;
  repoId: string;
  runId: string;
  shellToken: string;
  cwd: string;
  roleName: string;
  role: RoleCatalogEntry;
  task: string;
  readPaths: string[];
  writePaths: string[];
  mcp?: RoleSessionMcpOptions;
  reportPath?: string;
  streamIdleTimeoutMs?: number;
  runtime: ModelRuntime;
  modelRef: { provider: string; id: string };
  clock: Clock;
  shellRegistry: ShellRegistry;
  guards: RoleSessionGuards;
  networkGate: NetworkPauseGate;
  extraExtensionFactories?: Array<(pi: ExtensionAPI) => Promise<void> | void>;
  /** true 时以既有会话文件重建会话（续接），而非创建一份新的空会话文件 */
  resume?: boolean;
}

// 角色的收尾方式与是否要求提交结构化结果是同一份契约的两面，调用方整块传入，本模块不再按
// 角色 kind/名称推断：structured 有真实提交格式；plain 没有提交格式，区别只在于纯文字回合
// 结束时是直接结算 completed（单轮即完成的角色，如 plan），还是只发 idle 交回控制权
// （自身驱动多轮外部编排的角色，如需求代理，不能被任一次纯文字回合提前结束）
export type RoleOutputContract =
  | { kind: "structured"; outputSchema: TSchema; expectedPhase: Phase }
  | { kind: "plain"; completion: "complete-on-idle" }
  | { kind: "plain"; completion: "idle-only" };

export type CreateRoleSessionOptions = CreateRoleSessionBaseOptions & { contract: RoleOutputContract };

// 无有效结构化提交时，纯文字回合结束是直接结算 completed 还是只发 idle 交回控制权——
// 穷尽契约的每一种分支，新增契约种类时这里编译期（never 断言）或运行期即暴露，不会静默按 idle 兜底
function completesOnIdle(contract: RoleOutputContract): boolean {
  switch (contract.kind) {
    case "structured":
      return false;
    case "plain":
      switch (contract.completion) {
        case "complete-on-idle":
          return true;
        case "idle-only":
          return false;
        default: {
          const exhaustive: never = contract.completion;
          throw new Error(`未知的 plain 契约收尾方式: ${String(exhaustive)}`);
        }
      }
    default: {
      const exhaustive: never = contract;
      throw new Error(`未知的角色输出契约种类: ${String((exhaustive as { kind: string }).kind)}`);
    }
  }
}

export type RoleSessionState = "running" | "paused" | "paused_network" | "completed" | "failed" | "stopped";

export interface RoleSessionStopOutcome {
  stopped: boolean;
  shellResults: Array<{ taskId: string; result: StopResult }>;
}

export interface RoleSessionHandle {
  events: EventEmitter;
  state(): RoleSessionState;
  prompt(text: string): void;
  result(): Promise<unknown>;
  pause(): Promise<{ confirmed: boolean; reason?: string }>;
  resume(): Promise<void>;
  stop(): Promise<RoleSessionStopOutcome>;
  finalize(): Promise<unknown>;
  dispose(): void;
}

export function buildRolePrompt(input: {
  role: RoleDefinition;
  task: string;
  readPaths: string[];
  writePaths: string[];
  outputSchema?: TSchema;
  mcpStatus: string;
}): string {
  const describeList = (paths: string[]): string => (paths.length > 0 ? paths.join("、") : "无");
  return [
    input.role.body.trim(),
    "",
    `## 本次任务\n${input.task}`,
    "",
    `## 读写范围\n可读：${describeList(input.readPaths)}\n可写：${describeList(input.writePaths)}`,
    "",
    // plan 角色不提交结构化结果，回合结束即代表完成，不承诺一个不存在的提交工具
    input.outputSchema
      ? `## 结构化提交格式\n完成后必须调用 structured_output 工具提交一次，参数须满足以下 JSON Schema：\n${JSON.stringify(input.outputSchema)}\n`
      : "",
    `## MCP 状态\n${input.mcpStatus}`,
  ].join("\n");
}

function registerStructuredOutput(pi: ExtensionAPI, input: { outputSchema: TSchema; collector: ResultCollector }): void {
  pi.registerTool({
    name: "structured_output",
    label: "提交结构化结果",
    description: "提交本次任务的结构化结果，唯一一次有效",
    parameters: input.outputSchema,
    async execute(toolCallId, params) {
      const outcome = input.collector.accept({ toolCallId, value: params });
      if (!outcome.accepted) throw new Error(outcome.errors.join("; "));
      return { content: [{ type: "text", text: "提交已接受" }], details: {} };
    },
  });
}

const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);

function extractPath(input: unknown, cwd: string): string {
  if (input !== null && typeof input === "object") {
    const path = (input as Record<string, unknown>).path;
    if (typeof path === "string") return path;
  }
  // grep/find/ls 允许省略 path，此时按会话 cwd 判定范围，不能因省略而绕过读写边界
  return cwd;
}

// 候选路径可能尚未创建（写入目标）；沿父目录逐级 realpath，找到已存在的祖先后再拼回后续片段
export async function bestEffortRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    const resolvedParent = await bestEffortRealpath(parent);
    return join(resolvedParent, path.slice(parent.length + 1));
  }
}

export async function withinScope(cwd: string, candidate: string, scopes: string[]): Promise<boolean> {
  const resolvedCandidate = await bestEffortRealpath(resolvePath(cwd, candidate));
  for (const scope of scopes) {
    const resolvedScope = await bestEffortRealpath(resolvePath(cwd, scope));
    if (resolvedCandidate === resolvedScope || resolvedCandidate.startsWith(resolvedScope + sep)) return true;
  }
  return false;
}

interface CheckToolCallContext {
  cwd: string;
  readPaths: string[];
  writePaths: string[];
  guards: RoleSessionGuards;
  mcp?: { servers: string[] };
  mcpRoleKind: RoleKind;
  readOnlyRole: boolean;
  allowReportPathWrite: boolean;
  reportPath?: string;
  verifying: () => boolean;
  paused: () => boolean;
  submitted: () => boolean;
}

export async function checkToolCall(event: ToolCallEvent, ctx: CheckToolCallContext): Promise<ToolCallEventResult | void> {
  if (ctx.paused()) {
    return { block: true, reason: "会话已暂停，拒绝新操作" };
  }
  if (ctx.submitted()) {
    // 结构化提交是会话的最后一个动作，其后任何调用都必须让本轮尽快收尾
    return { block: true, reason: "已提交结构化结果，会话即将结束", terminate: true };
  }
  if (ctx.verifying() && !READ_ONLY_TOOL_NAMES.has(event.toolName)) {
    return { block: true, reason: "核对期内仅允许只读操作" };
  }
  if (READ_ONLY_TOOL_NAMES.has(event.toolName)) {
    const path = extractPath(event.input, ctx.cwd);
    if (!(await withinScope(ctx.cwd, path, [...ctx.readPaths, ...ctx.writePaths]))) {
      return { block: true, reason: `读取路径超出范围: ${path}` };
    }
    return;
  }
  if (event.toolName === "write" || event.toolName === "edit") {
    const path = extractPath(event.input, ctx.cwd);
    if (ctx.readOnlyRole) {
      if (ctx.allowReportPathWrite && ctx.reportPath) {
        const resolvedReport = await bestEffortRealpath(resolvePath(ctx.cwd, ctx.reportPath));
        // reportPath 本身必须落在 cwd 之内（含经符号链接跳出的情形），否则不管写入目标
        // 是否与它逐字相同都不放行；这条核对独立于注入的 guards，不能靠宽松的 guards 兜底
        if (await withinScope(ctx.cwd, ctx.reportPath, [ctx.cwd])) {
          const resolvedPath = await bestEffortRealpath(resolvePath(ctx.cwd, path));
          if (resolvedPath === resolvedReport) {
            const occupancy = await ctx.guards.checkWrite(path);
            if (!occupancy.ok) return { block: true, reason: occupancy.reason };
            return;
          }
        }
      }
      return { block: true, reason: "只读角色不允许直接调用写类工具" };
    }
    if (!(await withinScope(ctx.cwd, path, ctx.writePaths))) {
      return { block: true, reason: `写入路径超出范围: ${path}` };
    }
    const occupancy = await ctx.guards.checkWrite(path);
    if (!occupancy.ok) return { block: true, reason: occupancy.reason };
    return;
  }
  if (event.toolName === "mcp") {
    const input = event.input as Record<string, unknown>;
    const mode = input.search !== undefined ? "search" : input.describe !== undefined ? "describe" : "call";
    const decision = checkMcpCall({
      roleKind: ctx.mcpRoleKind,
      allowedServers: ctx.mcp?.servers ?? [],
      request: {
        mode,
        server: input.server as string | undefined,
        tool: input.tool as string | undefined,
        args: input.args,
      },
    });
    if (!decision.allowed) return { block: true, reason: decision.reason };
  }
}

const EXCLUDED_DIR_NAMES = new Set([".git", "node_modules"]);
// git 配置（local 与 global 都能生效）里任何键都可能被滥用（core.hooksPath/core.fsmonitor
// 指向仓库外脚本、alias/include/includeIf 注入任意命令、credential.helper/filter.*/diff.*
// 同样能执行代码），逐键列举白名单挡不住新花样，所以整份比对；只豁免已知会被只读命令
// 自身触发写入、且不可执行的调优键（如 core.untrackedcache、partial clone 相关的
// remote.<name>.promisor/partialclonefilter），而非假定"只有这些键才危险"
const GIT_CONFIG_BENIGN_KEYS = new Set(["core.untrackedcache"]);
const GIT_CONFIG_BENIGN_KEY_PATTERNS = [/^remote\.[^.]+\.promisor$/, /^remote\.[^.]+\.partialclonefilter$/];

function isGitConfigBenignKey(key: string): boolean {
  return GIT_CONFIG_BENIGN_KEYS.has(key) || GIT_CONFIG_BENIGN_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

async function gitCommand(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000, env: { ...process.env, LC_ALL: "C" } });
    return stdout.trim();
  } catch {
    // --global 在没有全局配置文件时以非零码退出；和"仓库外/未装 git"一样按空内容处理，
    // 不当作查询故障——空快照本身就是正确的比对基准
    return undefined;
  }
}

interface RepoGuardAnchors {
  configRoot: string;
  commonDir: string;
  hooksDir: string;
  infoAttributes: string;
  infoExclude: string;
  configWorktree: string;
  nodeModulesBin: string;
}

// 定点路径锚定 --git-common-dir/--git-dir 而非 --show-toplevel：linked worktree 下
// hooks/info 等钩子类文件实际落在主仓的公共目录，只看当前 worktree 的顶层会漏判；
// node_modules/.bin 是工作树概念，仍按当前 worktree 顶层定位。一次 rev-parse 拿三个路径、
// 一次 config --get 读 core.hooksPath，均只在会话建立时跑一次，不计入单条命令的 git 子进程预算
async function resolveRepoGuardAnchors(cwd: string): Promise<RepoGuardAnchors | undefined> {
  const raw = await gitCommand(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"]);
  if (!raw) return undefined;
  const [toplevel, commonDir, gitDir] = raw.split("\n").filter((line) => line.length > 0);
  if (!toplevel || !commonDir || !gitDir) return undefined;
  const hooksPathRaw = await gitCommand(cwd, ["config", "--get", "core.hooksPath"]);
  // core.hooksPath 的相对值按工作树顶层解析（git 的解释口径），不是发起调用的 cwd——
  // 会话 cwd 常常在仓库子目录下，按 cwd 解析会把相对钩子目录定位到错误的地方
  const hooksDir = hooksPathRaw ? resolvePath(toplevel, hooksPathRaw) : join(commonDir, "hooks");
  return {
    configRoot: cwd,
    commonDir,
    hooksDir,
    infoAttributes: join(commonDir, "info", "attributes"),
    infoExclude: join(commonDir, "info", "exclude"),
    configWorktree: join(gitDir, "config.worktree"),
    nodeModulesBin: join(toplevel, "node_modules", ".bin"),
  };
}

function normalizeGitConfigList(raw: string | undefined): string {
  return (raw ?? "")
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => {
      const key = line.slice(0, line.indexOf("=") === -1 ? line.length : line.indexOf("=")).toLowerCase();
      return !isGitConfigBenignKey(key);
    })
    .sort()
    .join("\n");
}

// 不带作用域参数的 --list 本身就是 local+global（连同 system）的合并视图：一次调用即可覆盖
// "只改 --global 不动 local 文件"这类绕过手法，不必分别再查一次 --local 与 --global——
// 单条命令前后各查一次已经要占用子进程预算，两次查询会把预算挤爆
async function snapshotGitConfigFull(anchors: RepoGuardAnchors): Promise<string> {
  const raw = await gitCommand(anchors.configRoot, ["config", "--list"]);
  return normalizeGitConfigList(raw);
}

function gitConfigChanged(before: string, after: string): boolean {
  return before !== after;
}

// git config --list 把键名整段小写（core.hooksPath 显示成 core.hookspath），直接报告差异行
// 会让最值得警惕的那个键在违规文案里变得认不出来，所以定点还原这一个的规范大小写
function describeGitConfigKey(key: string): string {
  return key === "core.hookspath" ? "core.hooksPath" : key;
}

function gitConfigDiffKeys(before: string, after: string): string[] {
  const beforeLines = before.split("\n").filter((line) => line.length > 0);
  const afterLines = after.split("\n").filter((line) => line.length > 0);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const changedLines = [...beforeLines.filter((line) => !afterSet.has(line)), ...afterLines.filter((line) => !beforeSet.has(line))];
  const keys = new Set(
    changedLines.map((line) => {
      const eq = line.indexOf("=");
      return describeGitConfigKey(eq === -1 ? line : line.slice(0, eq));
    }),
  );
  return [...keys];
}

async function enumerateFiles(root: string): Promise<string[]> {
  let entryStat;
  try {
    entryStat = await lstat(root);
  } catch {
    return [];
  }
  if (entryStat.isFile()) return [root];
  if (!entryStat.isDirectory()) return [];

  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await walk(root);
  return out;
}

async function listScopeFiles(scopeRoots: string[]): Promise<string[]> {
  const lists = await Promise.all(scopeRoots.map(enumerateFiles));
  return [...new Set(lists.flat())];
}

async function listSensitiveFiles(anchors: RepoGuardAnchors | undefined): Promise<string[]> {
  if (!anchors) return [];
  const targets = [anchors.hooksDir, anchors.infoAttributes, anchors.infoExclude, anchors.configWorktree, anchors.nodeModulesBin];
  const lists = await Promise.all(targets.map(enumerateFiles));
  return [...new Set(lists.flat())];
}

interface GuardSnapshot {
  files: string[];
  fp: Record<string, string>;
  gitConfig?: string;
}

async function snapshotScope(scopeRoots: string[], anchors: RepoGuardAnchors | undefined, guards: RoleSessionGuards): Promise<GuardSnapshot> {
  const files = [...new Set([...(await listScopeFiles(scopeRoots)), ...(await listSensitiveFiles(anchors))])];
  const [fp, gitConfig] = await Promise.all([guards.fingerprint(files), anchors ? snapshotGitConfigFull(anchors) : Promise.resolve(undefined)]);
  return { files, fp, gitConfig };
}

// configureRoleExtension 只关心"有没有真实提交格式"，用不到 completion 的收尾细节；
// 与 RoleOutputContract 的差别只在于 structured 分支额外带上已构造好的 collector 实例
export type RoleExtensionContract =
  | { kind: "structured"; outputSchema: TSchema; expectedPhase: Phase; collector: ResultCollector }
  | { kind: "plain"; completion: "complete-on-idle" }
  | { kind: "plain"; completion: "idle-only" };

export interface ConfigureRoleExtensionInput {
  role: RoleDefinition;
  task: string;
  readPaths: string[];
  writePaths: string[];
  mcp?: RoleSessionMcpOptions;
  contract: RoleExtensionContract;
  verifying: () => boolean;
  paused: () => boolean;
  submitted: () => boolean;
  guards: RoleSessionGuards;
  readOnlyRole: boolean;
  allowReportPathWrite: boolean;
  mcpRoleKind: RoleKind;
  scopeRoots: string[];
  cwd: string;
  reportPath?: string;
  onToolEnd: (event: { toolCallId: string; toolName: string; isError: boolean; suppressed: boolean }) => void;
  onActiveToolChange: (toolCallId: string, active: boolean) => void;
  onGuardViolation: (violations: string[]) => void;
  onReadOnlySuccess: () => void;
}

const MCP_STUB_PARAMS = Type.Object({
  tool: Type.Optional(Type.String()),
  args: Type.Optional(Type.Unknown()),
  describe: Type.Optional(Type.String()),
  search: Type.Optional(Type.String()),
  server: Type.Optional(Type.String()),
});

export function configureRoleExtension(input: ConfigureRoleExtensionInput): (pi: ExtensionAPI) => Promise<void> {
  return async (pi: ExtensionAPI) => {
    const mcpResult =
      input.mcp?.entryPath && input.mcp.packageDir && input.mcp.config
        ? await loadMcpForRole({
            pi,
            entryPath: input.mcp.entryPath,
            packageDir: input.mcp.packageDir,
            config: input.mcp.config,
            selected: input.mcp.servers,
          })
        : { loaded: [] as string[], missing: input.mcp?.servers ?? [], failure: undefined as string | undefined };

    // 真实适配器装载失败时其内部从未调用 pi.registerTool("mcp", ...)；不补一个工具桩的话，
    // 模型调用 mcp 会被 SDK 判成"工具不存在"，而不是我们想给出的"服务不可用"说明
    if (input.mcp && mcpResult.failure !== undefined) {
      pi.registerTool({
        name: "mcp",
        label: "MCP",
        description: "MCP 网关工具（装载失败占位）",
        parameters: MCP_STUB_PARAMS,
        async execute() {
          throw new Error(`MCP 服务不可用（${mcpResult.failure}）`);
        },
      });
    }

    const rolePrompt = buildRolePrompt({
      role: input.role,
      task: input.task,
      readPaths: input.readPaths,
      writePaths: input.writePaths,
      outputSchema: input.contract.kind === "structured" ? input.contract.outputSchema : undefined,
      mcpStatus: describeMcpStatus(mcpResult),
    });
    pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${rolePrompt}` }));

    if (input.contract.kind === "structured") {
      registerStructuredOutput(pi, { outputSchema: input.contract.outputSchema, collector: input.contract.collector });
    }

    const guardAnchors = input.readOnlyRole ? await resolveRepoGuardAnchors(input.cwd) : undefined;
    const pendingGuards = new Map<string, GuardSnapshot>();
    // 暂停期间新发起的调用从未真正执行，其收尾事件不代表一次真实操作；
    // 但暂停前已在执行中的调用（例如正在跑的 bash）会在暂停后才收尾，那是真实发生过的操作，必须照常上报
    const suppressedToolCallIds = new Set<string>();

    pi.on("tool_call", async (event) => {
      const wasPausedBeforeCall = input.paused();
      if (input.readOnlyRole && event.toolName === "bash") {
        pendingGuards.set(event.toolCallId, await snapshotScope(input.scopeRoots, guardAnchors, input.guards));
      }
      const result = await checkToolCall(event, {
        cwd: input.cwd,
        readPaths: input.readPaths,
        writePaths: input.writePaths,
        guards: input.guards,
        mcp: input.mcp,
        mcpRoleKind: input.mcpRoleKind,
        readOnlyRole: input.readOnlyRole,
        allowReportPathWrite: input.allowReportPathWrite,
        reportPath: input.reportPath,
        verifying: input.verifying,
        paused: input.paused,
        submitted: input.submitted,
      });
      if (result?.block && wasPausedBeforeCall) suppressedToolCallIds.add(event.toolCallId);
      return result;
    });

    pi.on("tool_execution_start", (event) => {
      input.onActiveToolChange(event.toolCallId, true);
    });

    pi.on("tool_execution_end", async (event) => {
      input.onActiveToolChange(event.toolCallId, false);
      const suppressed = suppressedToolCallIds.delete(event.toolCallId);
      input.onToolEnd({ toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError, suppressed });
      if (!event.isError && READ_ONLY_TOOL_NAMES.has(event.toolName)) input.onReadOnlySuccess();

      if (input.readOnlyRole && event.toolName === "bash") {
        const before = pendingGuards.get(event.toolCallId);
        pendingGuards.delete(event.toolCallId);
        if (before) {
          const afterFiles = [...new Set([...(await listScopeFiles(input.scopeRoots)), ...(await listSensitiveFiles(guardAnchors))])];
          const newFiles = afterFiles.filter((f) => !before.files.includes(f));
          const changed = await input.guards.verifyFingerprint(before.fp);
          const violations = [...new Set([...changed.map((c) => c.path), ...newFiles])];
          if (guardAnchors && before.gitConfig !== undefined) {
            const afterGitConfig = await snapshotGitConfigFull(guardAnchors);
            if (gitConfigChanged(before.gitConfig, afterGitConfig)) {
              const changedKeys = gitConfigDiffKeys(before.gitConfig, afterGitConfig);
              violations.push(`${join(guardAnchors.commonDir, "config")}（${changedKeys.join("、")}）`);
            }
          }
          const filtered: string[] = [];
          for (const violation of violations) {
            if (input.reportPath && (await bestEffortRealpath(violation)) === (await bestEffortRealpath(input.reportPath))) continue;
            filtered.push(violation);
          }
          if (filtered.length > 0) input.onGuardViolation(filtered);
        }
      }
    });
  };
}

const PAUSE_ABORT_TIMEOUT_MS = 5000;

export async function createRoleSession(options: CreateRoleSessionOptions): Promise<RoleSessionHandle> {
  if (!options.role.available || !options.role.definition) {
    throw new Error(options.role.reason ?? `角色定义不可用: ${options.roleName}`);
  }
  const definition = options.role.definition;
  const agentDir = dirname(options.dataRoot);

  const models = options.runtime.getModels(options.modelRef.provider);
  const model = models.find((entry) => entry.id === options.modelRef.id);
  if (!model) throw new Error(`未找到模型: ${options.modelRef.provider}/${options.modelRef.id}`);

  let sessionManager: SessionManager;
  if (options.resume) {
    const opened = openSessionManagerForRun({
      dataRoot: options.dataRoot,
      repoId: options.repoId,
      runId: options.runId,
      cwd: options.cwd,
    });
    if (!opened.ok) throw new Error(opened.detail);
    sessionManager = opened.manager;
  } else {
    sessionManager = createSessionManagerForRun({
      dataRoot: options.dataRoot,
      repoId: options.repoId,
      runId: options.runId,
      cwd: options.cwd,
    });
  }

  const readOnlyRole = options.roleName === "reviewer" || options.roleName === "acceptance";
  const allowReportPathWrite = options.roleName === "acceptance";
  const mcpRoleKind: RoleKind = readOnlyRole ? "review" : definition.kind;
  const scopeRoots = options.readPaths.length > 0 ? options.readPaths : [options.cwd];
  const contract = options.contract;
  let collector: ResultCollector | undefined;
  let extensionContract: RoleExtensionContract;
  if (contract.kind === "structured") {
    collector = new ResultCollector({ schema: contract.outputSchema, phase: contract.expectedPhase });
    extensionContract = { ...contract, collector };
  } else {
    extensionContract = contract;
  }
  const usesStructuredOutput = collector !== undefined;

  const events = new EventEmitter();
  const activeTools = new Set<string>();
  let currentState: RoleSessionState = "running";
  let verifying = false;
  let submitted = false;
  let queuedMessages: string[] = [];
  let idleTimer: TimerHandle | null = null;
  let session!: AgentSession;

  let resolveResult!: (value: unknown) => void;
  let rejectResult!: (error: Error) => void;
  const resultPromise = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  resultPromise.catch(() => {});

  function isTerminal(): boolean {
    return currentState === "completed" || currentState === "failed" || currentState === "stopped";
  }

  function isPaused(): boolean {
    return currentState === "paused" || currentState === "paused_network";
  }

  // 三种终态都不该再留着本次运行自己登记的后台 Shell；结算已经决定了运行的去向，
  // 不必等调用方另外调 stop() 才清理，失败/异常路径下更容易被忘记调用
  function stopBackgroundShell(): void {
    void shellRegistry.stopHost(host).catch(() => {});
  }

  function finishFailed(reason: string): void {
    if (isTerminal()) return;
    currentState = "failed";
    events.emit("failed", { reason });
    rejectResult(new Error(reason));
    stopBackgroundShell();
  }

  function finishCompleted(value: unknown): void {
    if (isTerminal()) return;
    currentState = "completed";
    resolveResult(value);
    stopBackgroundShell();
  }

  // agent_end 本身不再是唯一的结算触发点（多轮场景下一次自然回合结束未必是"结束"，
  // 未提交时改走 idle 让调用方决定是否继续）；completed/failed 的判定逻辑集中在这里，
  // 供 agent_end 的"已有效提交"分支、finalize()、stop() 复用
  function settleFinal(): void {
    if (isTerminal()) return;
    collector!.markSettled({ stopReason: "stop" });
    const outcome = collector!.finish();
    if (outcome.ok) {
      finishCompleted(outcome.result);
    } else {
      const reason = collector!.diagnostics().attempts === 0 ? "模型结束运行但未提交结构化结果" : outcome.reason;
      finishFailed(reason);
    }
  }

  const shellRegistry = options.shellRegistry;
  const runToken = options.shellToken;
  const host: Host = { kind: "role", id: options.runId, role: options.roleName, runId: options.runId };

  const extensionFactory = configureRoleExtension({
    role: definition,
    task: options.task,
    readPaths: options.readPaths,
    writePaths: options.writePaths,
    mcp: options.mcp,
    contract: extensionContract,
    verifying: () => verifying,
    paused: isPaused,
    submitted: () => submitted,
    guards: options.guards,
    readOnlyRole,
    allowReportPathWrite,
    mcpRoleKind,
    scopeRoots,
    cwd: options.cwd,
    reportPath: options.reportPath,
    onToolEnd: (event) => {
      if (event.toolName === "structured_output" && !event.isError) submitted = true;
      // 暂停后才发起、从未真正执行的调用不算一次真实操作；暂停前已在执行、暂停后才收尾的
      // 调用（例如正在跑的 bash 被中止）是真实发生过的操作，仍需完整上报
      if (!event.suppressed) events.emit("tool_end", event);
    },
    onActiveToolChange: (toolCallId, active) => {
      if (active) activeTools.add(toolCallId);
      else activeTools.delete(toolCallId);
    },
    onGuardViolation: (violations) => {
      finishFailed(`只读角色 ${options.roleName} 的 bash 命令改变了工作区: ${violations.join("、")}`);
      void session.abort().catch(() => {});
    },
    onReadOnlySuccess: () => {
      verifying = false;
    },
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir,
    noSkills: !definition.skills,
    noContextFiles: !definition.contextFiles,
    noExtensions: true,
    extensionFactories: [extensionFactory, ...(options.extraExtensionFactories ?? [])],
  });
  await resourceLoader.reload();

  const activeToolNames = [...definition.tools, ...(usesStructuredOutput ? ["structured_output"] : [])];
  if (options.mcp) activeToolNames.push("mcp");

  const created = await createAgentSession({
    cwd: options.cwd,
    agentDir,
    modelRuntime: options.runtime,
    model,
    resourceLoader,
    sessionManager,
    tools: activeToolNames,
    customTools: [createManagedBashTool({ registry: shellRegistry, host, cwd: options.cwd, runToken })],
  });
  session = created.session;

  let pendingNetworkAbort: Promise<void> | undefined;

  function armIdleWatchdog(): void {
    if (options.streamIdleTimeoutMs === undefined) return;
    if (idleTimer) options.clock.clearTimer(idleTimer);
    idleTimer = options.clock.setTimeoutExcludingSleep(async () => {
      idleTimer = null;
      if (currentState !== "running") return;
      currentState = "paused_network";
      options.networkGate.requestPause(options.runId, "network");
      events.emit("paused_network", { reason: "connection" });
      pendingNetworkAbort = session.abort().catch(() => {});
      await pendingNetworkAbort;
    }, options.streamIdleTimeoutMs);
  }

  const unsubscribe = session.subscribe((event) => {
    armIdleWatchdog();

    if (event.type === "agent_end") {
      // 一次自然回合结束未必是角色任务的终点（多轮场景下模型可能先汇报再继续）；
      // structured 契约只有已经拿到一个有效结构化提交才据此结算，否则保持 running 交回控制权
      // 由调用方决定是继续追加 prompt 还是显式 finalize()；plain 契约按其 completion 决定：
      // complete-on-idle（如 plan，单轮即完成）纯文字回合结束直接结算，idle-only（如需求代理，
      // 自身驱动多轮编排）同样交回控制权，不能被任一次纯文字回合提前结束
      if (currentState === "running") {
        if (collector && collector.diagnostics().valid > 0) {
          settleFinal();
        } else if (completesOnIdle(contract)) {
          finishCompleted(undefined);
        } else {
          events.emit("idle", { submitted: false });
        }
      }
      return;
    }

    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const stopReason = event.message.stopReason;
    if (stopReason === "error" && currentState === "running") {
      const failure = classifyFailure(new Error(event.message.errorMessage ?? "模型请求失败"));
      if (failure === "connection") {
        currentState = "paused_network";
        options.networkGate.requestPause(options.runId, "network");
        events.emit("paused_network", { reason: "connection" });
        pendingNetworkAbort = session.abort().catch(() => {});
      } else if (failure === "cancelled") {
        // 取消是我们自己发起的中止（pause/stop/网络空闲重连）造成的正常收尾，不是业务失败；
        // 真正需要的状态流转已经在发起中止的那处代码完成，这里什么都不用做
      } else {
        finishFailed(event.message.errorMessage ?? "模型请求失败");
      }
    }
  });

  function prompt(text: string): void {
    if (isTerminal()) return;
    if (currentState === "paused") {
      queuedMessages.push(text);
      return;
    }
    const gate = options.networkGate.canProceed(options.runId);
    if (!gate.allowed) {
      queuedMessages.push(text);
      return;
    }
    armIdleWatchdog();
    if (session.isStreaming) {
      void session.prompt(text, { streamingBehavior: "followUp" });
    } else {
      void session.prompt(text);
    }
  }

  async function pause(): Promise<{ confirmed: boolean; reason?: string }> {
    if (isTerminal()) return { confirmed: true };
    if (idleTimer) {
      options.clock.clearTimer(idleTimer);
      idleTimer = null;
    }
    currentState = "paused";
    const drained = session.clearQueue();
    queuedMessages.push(...drained.steering, ...drained.followUp);

    let abortConfirmed = false;
    const abortPromise = session
      .abort()
      .then(() => {
        abortConfirmed = true;
      })
      .catch(() => {});

    let timeoutTimer: TimerHandle | null = null;
    // abort 是否在超时窗口内确认要在竞速落定的那一刻定案；abortPromise 后续即便自己也 settle，
    // 也不能追溯改判——那代表的是"超时之后才勉强confirm"，不是"按时确认"
    let timedOut = false;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutTimer = options.clock.setTimeoutExcludingSleep(() => {
        timedOut = true;
        resolve();
      }, PAUSE_ABORT_TIMEOUT_MS);
    });

    await Promise.race([abortPromise, timeoutPromise]);
    if (timeoutTimer) options.clock.clearTimer(timeoutTimer);
    const abortConfirmedInTime = abortConfirmed && !timedOut;

    const stopResults = await shellRegistry.stopHost(host);
    const shellConfirmed = stopResults.every((entry) => entry.result.ok === true && entry.result.task.status !== "uncertain");
    const confirmed = abortConfirmedInTime && activeTools.size === 0 && shellConfirmed;
    if (confirmed) return { confirmed };
    const reasons: string[] = [];
    if (!abortConfirmedInTime) reasons.push("abort 未在超时内确认");
    if (!shellConfirmed) reasons.push("Shell 未确认全部停止");
    return { confirmed, reason: reasons.join("；") };
  }

  async function resume(): Promise<void> {
    if (isTerminal()) return;
    // 先等旧的 abort 落定，再放行 networkGate：否则新 prompt 可能在旧请求的收尾之前就被判定"可继续"
    if (pendingNetworkAbort) {
      await pendingNetworkAbort;
      pendingNetworkAbort = undefined;
    }
    options.networkGate.resume(options.runId);

    currentState = "running";
    verifying = true;
    const queued = queuedMessages.splice(0);
    const resumeText = [
      "已恢复运行：暂停期间任何操作的结果均结果不明，请先核对工作区当前实际状态再继续，不要假设之前的操作已生效。",
      queued.length > 0 ? `排队消息：\n${queued.join("\n")}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
    armIdleWatchdog();
    await session.prompt(resumeText);
  }

  async function stop(): Promise<RoleSessionStopOutcome> {
    // 终态后再调用不改变已有结算，但清理请求仍要如实执行并回报真实结果——
    // 不能因为"已经终态"就假装这次清理是恒定的空操作
    if (isTerminal()) {
      const shellResults = await shellRegistry.stopHost(host);
      const stopped = shellResults.every((entry) => entry.result.ok === true && entry.result.task.status !== "uncertain");
      return { stopped, shellResults };
    }
    if (idleTimer) {
      options.clock.clearTimer(idleTimer);
      idleTimer = null;
    }
    // 先切到 stopped 再 abort：abort 引发的 message_end error（stopReason "aborted"）
    // 要被"仅 running 才处理"的守卫挡在外面，不能让它被误判成一次业务失败
    currentState = "stopped";
    rejectResult(new Error("会话已被用户停止"));

    // Shell 清理是我们自己的机制，不依赖模型会话是否响应中止；先做这一步，
    // 让真实结果不被下面对 abort 的有界等待卡住
    const shellResults = await shellRegistry.stopHost(host);

    // abort 要等 session 转为空闲，而空闲判定要等在飞工具调用真正结束；
    // 工具调用若挂在不响应 signal 的外部依赖上会永远不结束，因此这里只等一个上限，
    // 超时就放弃等待——currentState 早已同步置为 stopped，不依赖这次 abort 是否落定
    let timeoutTimer: TimerHandle | null = null;
    const abortPromise = session.abort().catch(() => {});
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutTimer = options.clock.setTimeoutExcludingSleep(() => resolve(), PAUSE_ABORT_TIMEOUT_MS);
    });
    await Promise.race([abortPromise, timeoutPromise]);
    if (timeoutTimer) options.clock.clearTimer(timeoutTimer);

    const stopped = shellResults.every((entry) => entry.result.ok === true && entry.result.task.status !== "uncertain");
    return { stopped, shellResults };
  }

  async function finalize(): Promise<unknown> {
    if (!collector) {
      finishCompleted(undefined);
    } else {
      settleFinal();
    }
    return resultPromise;
  }

  function dispose(): void {
    if (currentState === "paused") throw new Error("暂停态禁止释放会话");
    if (idleTimer) options.clock.clearTimer(idleTimer);
    unsubscribe();
    session.dispose();
  }

  return {
    events,
    state: () => currentState,
    prompt,
    result: () => resultPromise,
    pause,
    resume,
    stop,
    finalize,
    dispose,
  };
}
