import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
const productRoot = fileURLToPath(new URL("../../../", import.meta.url));
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Thinking = (typeof THINKING_LEVELS)[number];

export interface AcceptanceConfig {
  provider: string;
  modelId: string;
  thinking: Thinking;
  credentialsDir: string;
  output: string;
}

/** 只有显式给出模型与证据目录时才跑真实模型验收；缺任一项返回 null，由用例跳过。 */
export function acceptanceConfig(): AcceptanceConfig | null {
  const model = process.env.PI_COMPANY_ACCEPTANCE_MODEL, output = process.env.PI_COMPANY_ACCEPTANCE_OUTPUT;
  if (!model || !output) return null;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error("PI_COMPANY_ACCEPTANCE_MODEL 须写成 <provider>/<model>");
  if (!isAbsolute(output)) throw new Error("PI_COMPANY_ACCEPTANCE_OUTPUT 须是绝对路径");
  const thinking = (process.env.PI_COMPANY_ACCEPTANCE_THINKING ?? "high") as Thinking;
  if (!THINKING_LEVELS.includes(thinking)) throw new Error(`不支持的思考等级：${thinking}`);
  return {
    provider: model.slice(0, slash), modelId: model.slice(slash + 1), thinking, output,
    credentialsDir: process.env.PI_COMPANY_ACCEPTANCE_CREDENTIALS ?? join(homedir(), ".pi", "agent"),
  };
}

function installedPackageRoot(specifier: string): string {
  return dirname(dirname(fileURLToPath(import.meta.resolve(specifier))));
}

async function pack(pnpm: string, path: string, destination: string): Promise<string> {
  const raw = (await exec(process.execPath, [pnpm, "--config.ignore-scripts=true", "pack", "--json", "--pack-destination", destination], {
    cwd: path, env: { ...process.env, npm_config_ignore_scripts: "true", npm_config_update_notifier: "false" }, maxBuffer: 4 * 1024 * 1024,
  })).stdout;
  return resolve(path, (JSON.parse(raw) as { filename: string }).filename);
}

/** 用 pnpm 打包产品并离线装进独立的使用方目录，返回安装后的包根目录。 */
export async function installProduct(root: string): Promise<string> {
  const packs = join(root, "packs"), consumer = join(root, "consumer");
  await mkdir(packs, { recursive: true }); await mkdir(consumer, { recursive: true });
  const pnpm = await realpath((await exec("/usr/bin/which", ["pnpm"])).stdout.trim());
  const artifact = await pack(pnpm, productRoot, packs);
  const treeSitter = await pack(pnpm, dirname(fileURLToPath(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm"))), packs);
  const typebox = await pack(pnpm, await realpath(join(productRoot, "node_modules", "typebox")), packs);
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "acceptance-consumer", version: "1.0.0", private: true, packageManager: "pnpm@11.7.0",
    dependencies: {
      "@0xbb2b/pi-company": `file:${artifact}`,
      "@earendil-works/pi-ai": `link:${installedPackageRoot("@earendil-works/pi-ai")}`,
      "@earendil-works/pi-coding-agent": `link:${installedPackageRoot("@earendil-works/pi-coding-agent")}`,
      "@earendil-works/pi-tui": `link:${installedPackageRoot("@earendil-works/pi-tui")}`,
    },
  }));
  await writeFile(join(consumer, "pnpm-workspace.yaml"), ["autoInstallPeers: false", "overrides:",
    `  typebox: ${JSON.stringify(`file:${typebox}`)}`, `  web-tree-sitter: ${JSON.stringify(`file:${treeSitter}`)}`, ""].join("\n"));
  const env = { ...process.env, npm_config_ignore_scripts: "true", npm_config_update_notifier: "false" };
  await exec(process.execPath, [pnpm, "install", "--offline", "--ignore-scripts", "--lockfile-only"], { cwd: consumer, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  await exec(process.execPath, [pnpm, "install", "--offline", "--frozen-lockfile", "--ignore-scripts"], { cwd: consumer, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const installed = await realpath(join(consumer, "node_modules", "@0xbb2b", "pi-company"));
  if (installed === productRoot) throw new Error("安装产物解析回了源码目录");
  return installed;
}

/** 把模型配置与凭据复制进隔离的 agent 目录，仅当前用户可读；用完随临时根目录一起删除。 */
export async function copyCredentials(from: string, agentDir: string): Promise<void> {
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  for (const name of ["models.json", "auth.json"]) {
    await copyFile(join(from, name), join(agentDir, name));
    await chmod(join(agentDir, name), 0o600);
  }
}

export interface DialogRecord { kind: "confirm" | "select" | "input"; title: string; message?: string; options?: string[]; answer: unknown; at: number }

export interface InstalledHost {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  dialogs: DialogRecord[];
  notifications: Array<{ message: string; type?: string; at: number }>;
  /** 主会话的模型回合结束、出错与自动重试，失败的尝试可能不留在会话消息里。 */
  modelEvents: Array<{ type: string; detail: string; at: number }>;
  /** 扩展在主会话里另行发起的无工具模型调用（如需求解释器）的请求开头与模型原始回答，供排查校验失败。 */
  sideCalls: Array<{ systemPrompt: string; input: string; stopReason: string; output: string; at: number }>;
  /** 按用户在终端里看到的样子渲染 PM 面板。 */
  panelLines(width?: number): string[];
  /** 模拟用户在终端按键（输入框为空时）。 */
  press(data: string): void;
  close(): Promise<void>;
}

/**
 * 用真实 SDK 加载安装产物，模式为 tui：驱动方接管界面，确认框一律回答"是"并记录，
 * PM 面板经 setWidget 挂载后可按用户所见渲染，按键经 onTerminalInput 送入。
 */
export async function startInstalledHost(options: { installed: string; repo: string; agentDir: string; config: AcceptanceConfig }): Promise<InstalledHost> {
  const { installed, repo, agentDir, config } = options;
  // 与真实宿主一致：启动时刷新提供方状态，否则"已配置凭据"的快照为空
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const sideCalls: InstalledHost["sideCalls"] = [];
  const complete = runtime.complete.bind(runtime);
  runtime.complete = (async (...args: Parameters<typeof runtime.complete>) => {
    const [, context] = args, response = await complete(...args);
    const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
    sideCalls.push({ systemPrompt: text(context.systemPrompt ?? "").slice(0, 200), input: context.messages.map((m) => text(m.content)).join("\n").slice(0, 20_000),
      stopReason: response.stopReason, output: response.content.map((b) => b.type === "text" ? b.text : `[${b.type}]`).join("").slice(0, 60_000), at: Date.now() });
    return response;
  }) as typeof runtime.complete;
  const model = runtime.getModel(config.provider, config.modelId);
  if (!model) throw new Error(`模型配置里找不到 ${config.provider}/${config.modelId}`);
  const loader = new DefaultResourceLoader({
    cwd: repo, agentDir, settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [join(installed, "extensions", "index.ts")], noContextFiles: true, noThemes: true,
  });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length > 0) throw new Error(`扩展加载失败：${JSON.stringify(errors)}`);
  const { session } = await createAgentSession({
    cwd: repo, agentDir, modelRuntime: runtime, model, thinkingLevel: config.thinking, resourceLoader: loader,
    settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.inMemory(repo),
  });

  const dialogs: DialogRecord[] = [], notifications: InstalledHost["notifications"] = [];
  const inputHandlers = new Set<TerminalInputHandler>();
  let panel: { render(width: number): string[] } | undefined;
  const defaultUI = session.extensionRunner.getUIContext();
  const ui: ExtensionUIContext = {
    ...defaultUI,
    confirm: async (title, message) => { dialogs.push({ kind: "confirm", title, message, answer: true, at: Date.now() }); return true; },
    select: async (title, choices) => { dialogs.push({ kind: "select", title, options: choices, answer: undefined, at: Date.now() }); return undefined; },
    input: async (title) => { dialogs.push({ kind: "input", title, answer: undefined, at: Date.now() }); return undefined; },
    editor: async () => undefined,
    custom: async () => undefined as never,
    notify: (message, type) => { notifications.push({ message, type, at: Date.now() }); },
    onTerminalInput: (handler) => { inputHandlers.add(handler); return () => { inputHandlers.delete(handler); }; },
    getEditorText: () => "",
    setWidget: ((key: string, content: unknown) => {
      if (key !== "pm-panel") return;
      panel = typeof content === "function" ? (content as (tui: unknown, theme: unknown) => { render(width: number): string[] })({ requestRender() {} }, {}) : undefined;
    }) as ExtensionUIContext["setWidget"],
  };
  await session.bindExtensions({ uiContext: ui, mode: "tui" });
  const modelEvents: InstalledHost["modelEvents"] = [];
  session.subscribe((event) => {
    const at = Date.now();
    if (event.type === "message_end" && event.message.role === "assistant") {
      const { usage, stopReason, errorMessage, content } = event.message;
      modelEvents.push({ type: "assistant", detail: `${stopReason} in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} blocks=${content.map((b) => b.type).join(",")}${errorMessage ? ` ${errorMessage.slice(0, 500)}` : ""}`, at });
    } else if (event.type === "auto_retry_start") modelEvents.push({ type: event.type, detail: `${event.attempt}/${event.maxAttempts} ${event.errorMessage.slice(0, 500)}`, at });
    else if (event.type === "auto_retry_end") modelEvents.push({ type: event.type, detail: `${event.success} ${event.finalError?.slice(0, 500) ?? ""}`, at });
    else if (event.type === "agent_end") modelEvents.push({ type: event.type, detail: `willRetry=${event.willRetry}`, at });
  });

  return {
    session, dialogs, notifications, modelEvents, sideCalls,
    panelLines: (width = 160) => panel?.render(width) ?? [],
    press: (data) => { for (const handler of inputHandlers) handler(data); },
    close: async () => {
      if (!session.isIdle) { await session.abort(); await session.waitForIdle(); }
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    },
  };
}
