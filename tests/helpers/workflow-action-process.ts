import { readFileSync } from "node:fs";
import { createWorkflowTool } from "../../runtime/workflow-tool.ts";

interface ActionConfig {
  dataRoot: string;
  cwd: string;
  params: Record<string, unknown>;
}

const configPath = process.argv[2];
if (!configPath) throw new Error("缺少配置文件路径参数");
const config = JSON.parse(readFileSync(configPath, "utf8")) as ActionConfig;

const tool = createWorkflowTool({ dataRoot: config.dataRoot, cwd: config.cwd });
try {
  const result = await tool.execute("workflow-action-process", config.params, undefined, undefined, { cwd: config.cwd });
  process.stdout.write(JSON.stringify({ ok: true, text: result.content[0]?.text ?? "" }));
  process.exit(0);
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, text: (error as Error).message }));
  process.exit(1);
}
