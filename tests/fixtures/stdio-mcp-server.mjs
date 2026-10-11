import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const pidFile = process.argv[2];
if (pidFile) writeFileSync(pidFile, String(process.pid));

const TOOLS = [
  { name: "search", description: "检索内网文档", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "delete-all", description: "删除全部文档", inputSchema: { type: "object", properties: {} } },
];

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } });
  } else if (message.method === "tools/list") {
    send({ id: message.id, result: { tools: TOOLS } });
  } else if (message.method === "tools/call") {
    send({ id: message.id, result: { content: [{ type: "text", text: `内网文档：${message.params.name} ${JSON.stringify(message.params.arguments ?? {})}` }] } });
  } else {
    send({ id: message.id, result: {} });
  }
});
