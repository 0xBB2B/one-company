import { isAbsolute, join } from "node:path";

export function dataRoot(env: Record<string, string | undefined>): string {
  const agentDir = env.PI_CODING_AGENT_DIR;
  if (agentDir !== undefined) {
    if (!agentDir || !isAbsolute(agentDir)) {
      throw new Error(`PI_CODING_AGENT_DIR 必须是非空绝对路径: ${agentDir}`);
    }
    return join(agentDir, "one-company");
  }
  const home = env.HOME;
  if (!home) throw new Error("未设置 PI_CODING_AGENT_DIR 时必须设置 HOME");
  if (!isAbsolute(home)) throw new Error(`HOME 必须是绝对路径: ${home}`);
  return join(home, ".pi", "agent", "one-company");
}
