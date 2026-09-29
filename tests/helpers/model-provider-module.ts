import { appendFileSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerControlledProvider, scriptReplies } from "./controlled-provider.ts";
import type { ControlledProvider, ScriptedReply } from "./controlled-provider.ts";

export const PROVIDER_SCRIPTS_ENV_VAR = "ONE_COMPANY_TEST_PROVIDER_SCRIPTS";
export const PROVIDER_REQUESTS_LOG_ENV_VAR = "ONE_COMPANY_TEST_PROVIDER_REQUESTS_LOG";
export const TRIGGER_UNHANDLED_REJECTION_ENV_VAR = "ONE_COMPANY_TEST_TRIGGER_UNHANDLED_REJECTION";
export const TRIGGER_UNCAUGHT_EXCEPTION_ENV_VAR = "ONE_COMPANY_TEST_TRIGGER_UNCAUGHT_EXCEPTION";
export const ASSEMBLY_DELAY_MS_ENV_VAR = "ONE_COMPANY_TEST_ASSEMBLY_DELAY_MS";
/** 测试运行中追加回复的 JSONL 文件，每行 {providerId, reply}；队列空时 provider 最多等 30 秒读到新行。 */
export const PROVIDER_APPEND_ENV_VAR = "ONE_COMPANY_TEST_PROVIDER_APPEND";

export interface ProviderScript {
  providerId: string;
  modelId: string;
  baseUrl?: string;
  roleName?: string;
  taskId?: string;
  replies: ScriptedReply[];
}

export type SelectModel = (input: { roleName: string; taskId?: string }) => { provider: string; id: string };

// 生产代码经 ONE_COMPANY_MODEL_PROVIDER_MODULE 动态导入本模块，只调用 registerProviders(runtime)；
// 角色/任务到 provider 的路由脚本与匹配逻辑留在测试目录内，不进入生产路径
export async function registerProviders(runtime: ModelRuntime): Promise<void> {
  // 用于验证守护进程的进程级兜底：一次孤立的未处理拒绝不该把整个进程拖垮
  if (process.env[TRIGGER_UNHANDLED_REJECTION_ENV_VAR]) {
    void Promise.reject(new Error("测试注入的未处理拒绝"));
  }
  // 用于验证看门狗：装配期内一次真正未捕获的同步异常（定时器回调内抛出，没有任何 catch 能接住）
  if (process.env[TRIGGER_UNCAUGHT_EXCEPTION_ENV_VAR]) {
    setTimeout(() => {
      throw new Error("测试注入的未捕获异常");
    }, 0);
  }
  // 用于验证分发层就绪信号：人为拉长装配窗口，模拟 ModelRuntime/角色目录等重活还没完工的时段
  const assemblyDelayMs = Number(process.env[ASSEMBLY_DELAY_MS_ENV_VAR]);
  if (Number.isFinite(assemblyDelayMs) && assemblyDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, assemblyDelayMs));
  }
  const scriptsPath = process.env[PROVIDER_SCRIPTS_ENV_VAR];
  if (!scriptsPath) return;
  const raw = await readFile(scriptsPath, "utf8");
  const scripts = JSON.parse(raw) as ProviderScript[];
  const logPath = process.env[PROVIDER_REQUESTS_LOG_ENV_VAR];
  const registered = new Set<string>();
  for (const script of scripts) {
    if (registered.has(script.providerId)) continue;
    registered.add(script.providerId);
    const provider = registerControlledProvider(runtime, {
      providerId: script.providerId,
      modelId: script.modelId,
      baseUrl: script.baseUrl,
    });
    scriptReplies(provider, script.replies);
    if (logPath) watchRequests(provider, logPath);
    const appendPath = process.env[PROVIDER_APPEND_ENV_VAR];
    if (appendPath) provider.awaitReply = () => awaitAppended(appendPath, provider.providerId);
  }
}

const consumedAppends = new Map<string, number>();
async function awaitAppended(path: string, providerId: string): Promise<ScriptedReply | undefined> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let lines: string[] = [];
    try { lines = readFileSync(path, "utf8").split("\n").filter(Boolean); } catch { /* 文件尚未创建 */ }
    const mine = lines.map((line) => JSON.parse(line) as { providerId: string; reply: ScriptedReply }).filter((entry) => entry.providerId === providerId);
    const used = consumedAppends.get(providerId) ?? 0;
    if (mine.length > used) { consumedAppends.set(providerId, used + 1); return mine[used]!.reply; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

// requests 是测试进程读不到的子进程内数组；重写这个具体数组实例的 push，
// 让每次模型调用收到请求的同一时刻同步落盘，而不是靠轮询猜测何时写完
function watchRequests(provider: ControlledProvider, logPath: string): void {
  const requests = provider.requests as unknown[] & { push(...items: unknown[]): number };
  const originalPush = requests.push.bind(requests);
  requests.push = (...items: unknown[]): number => {
    for (const context of items) {
      let text = "", last = "";
      try {
        text = JSON.stringify(context).slice(0, 20_000);
        last = JSON.stringify((context as { messages?: unknown[] }).messages?.at(-1) ?? null).slice(0, 20_000);
      } catch {
        text = "";
      }
      try {
        appendFileSync(logPath, `${JSON.stringify({ providerId: provider.providerId, at: Date.now(), text, last })}\n`);
      } catch {
        // 日志文件写入失败不影响受控 provider 正常应答
      }
    }
    return originalPush(...items);
  };
}

export function selectModel({ roleName, taskId }: { roleName: string; taskId?: string }): { provider: string; id: string } {
  const scriptsPath = process.env[PROVIDER_SCRIPTS_ENV_VAR];
  if (!scriptsPath) throw new Error("未设置 ONE_COMPANY_TEST_PROVIDER_SCRIPTS，无法解析测试模型");
  const raw = readFileSync(scriptsPath, "utf8");
  const scripts = JSON.parse(raw) as ProviderScript[];
  const exact = scripts.find((script) => script.roleName === roleName && script.taskId === taskId);
  if (exact) return { provider: exact.providerId, id: exact.modelId };
  const byRole = scripts.find((script) => script.roleName === roleName && script.taskId === undefined);
  if (byRole) return { provider: byRole.providerId, id: byRole.modelId };
  const generic = scripts.find((script) => script.roleName === undefined && script.taskId === undefined);
  if (generic) return { provider: generic.providerId, id: generic.modelId };
  throw new Error(`未找到匹配的受控 provider 脚本: role=${roleName} task=${taskId ?? ""}`);
}
