import { spawn } from "node:child_process";

// 只通过受控 IPC 启动；等待父进程持久登记进程组后才接收 Git 命令。
if (!process.send || !process.connected) throw new Error("Git 存储子进程需要受控 IPC");
let child;
let activeId;
let closing = false;
const send = (message) => { if (process.connected) process.send(message); };
function stopGroup() {
  closing = true;
  try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
}
process.on("disconnect", () => { if (!closing) stopGroup(); });
process.on("uncaughtException", stopGroup);
process.on("unhandledRejection", stopGroup);
process.on("message", (message) => {
  if (!message || typeof message !== "object") return stopGroup();
  if (message.type === "shutdown") {
    if (child) return stopGroup();
    closing = true;
    process.disconnect();
    return;
  }
  if (message.type === "input") {
    if (!child || activeId !== message.id) return;
    child.stdin.on("error", () => undefined);
    child.stdin.end(message.input === undefined ? undefined : Buffer.from(message.input, "base64"));
    return;
  }
  if (message.type !== "run" || child || !Number.isSafeInteger(message.id) || typeof message.executable !== "string"
    || !Array.isArray(message.args) || message.args.some((arg) => typeof arg !== "string") || typeof message.cwd !== "string") return stopGroup();
  activeId = message.id;
  const id = activeId;
  const stdout = [], stderr = [];
  let size = 0, overflow = false, timedOut = false, spawnCode;
  const proc = spawn(message.executable, message.args, { cwd: message.cwd, env: message.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child = proc;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, message.timeout ?? 10_000);
  const collect = (chunks) => (chunk) => {
    size += chunk.length;
    if (size > (message.maxBuffer ?? 64 * 1024 * 1024)) { overflow = true; proc.kill("SIGKILL"); return; }
    chunks.push(Buffer.from(chunk));
  };
  proc.stdout.on("data", collect(stdout));
  proc.stderr.on("data", collect(stderr));
  proc.once("error", (error) => { spawnCode = error.code ?? "spawn_failed"; });
  proc.once("close", (code) => {
    clearTimeout(timer);
    child = undefined;
    activeId = undefined;
    send({ type: "result", id, code: code ?? -1, stdout: Buffer.concat(stdout).toString("base64"), stderr: Buffer.concat(stderr).toString("base64"), overflow, timedOut, spawnCode });
  });
  send({ type: "started", id, pid: proc.pid });
});
send({ type: "ready" });
