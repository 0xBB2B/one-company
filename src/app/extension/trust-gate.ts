import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dataRoot } from "../../core/storage/data-root.ts";
import { disabledNotice, resolveSessionTrust, type DisabledReason, type SessionTrust } from "../../modules/settings/startup-trust.ts";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

const PENDING: SessionTrust = { enabled: false, reason: { kind: "pending" } };

function normalizeShellPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path.startsWith("file://") ? fileURLToPath(path) : path;
}

export function createTrustGate(pi: ExtensionAPI): ExtensionAPI {
  let session: SessionTrust = PENDING;
  let agentDir = "";
  const oneCompanyToolNames = new Set<string>();

  // bash 是 pi 自带工具名，停用时仍要能用，所以不从可用列表移出
  const setTools = (enabled: boolean) => {
    const active = pi.getActiveTools();
    const registered = [...oneCompanyToolNames];
    pi.setActiveTools(enabled
      ? [...new Set([...active, ...registered])]
      : active.filter((name) => name === "bash" || !oneCompanyToolNames.has(name)));
  };

  const restorePiBash = (cwd: string) => {
    const { shellCommandPrefix, shellPath } = pi.getSettings();
    pi.registerTool(createBashToolDefinition(cwd, { commandPrefix: shellCommandPrefix, shellPath: shellPath && normalizeShellPath(shellPath) }));
  };

  pi.on("session_start", async (event, ctx) => {
    session = PENDING;
    try {
      setTools(false);
      agentDir = dirname(dataRoot(process.env));
      session = await resolveSessionTrust(event, ctx, agentDir);
    } catch (error) {
      const reason: DisabledReason = { kind: "error", detail: (error instanceof Error ? error.message : String(error)).split("\n")[0] };
      session = { enabled: false, reason };
      if (ctx.hasUI) ctx.ui.notify(disabledNotice(reason, agentDir, ctx.ui.theme));
    }
    if (session.enabled) setTools(true);
    else restorePiBash(ctx.cwd);
  });

  return new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "on") {
        return (event: string, handler: (...args: unknown[]) => unknown) =>
          (target.on as (event: string, handler: unknown) => void)(event, (...args: unknown[]) => (session.enabled ? handler(...args) : undefined));
      }
      if (prop === "registerCommand") {
        return (name: string, options: CommandOptions) =>
          target.registerCommand(name, {
            ...options,
            handler: async (args, ctx) => {
              if (session.enabled) return options.handler(args, ctx);
              ctx.ui.notify(disabledNotice(session.reason, agentDir, ctx.ui.theme));
            },
          });
      }
      if (prop === "registerTool") {
        return (tool: ToolDefinition) => {
          oneCompanyToolNames.add(tool.name);
          target.registerTool(tool);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
