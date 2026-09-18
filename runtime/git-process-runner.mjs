import { spawn } from "node:child_process";

import { currentHostGit, initializeInheritedGit, parseGitExpectation } from "./git-runtime.mjs";

// 只通过受控父进程的既有 ChildProcess IPC 启动；环境变量不承载Git期望或业务授权。
if (!process.send || !process.connected) throw new Error("Git 存储子进程需要受控 IPC");
let child;
let activeId;
let activeRoots = [];
let activeIdentityKey;
let activeStdout = [];
let activeStderr = [];
let activeInputReceived = false;
let activeFailed = false;
let lastCompletedId = 0;
let knownRoots = [];
let closing = false;
let phase = "bootstrap";
let boundIdentityKey;
let boundExecutable;

const send = (message, callback) => {
  if (!process.connected) { callback?.(new Error("disconnected")); return; }
  process.send(message, callback);
};

function stopGroup() {
  if (closing) return;
  closing = true;
  try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(1); }
}

function fixedFailure(type, id) {
  const timer = setTimeout(stopGroup, 100);
  timer.unref();
  const message = { type, ...(id === undefined ? {} : { id }) };
  send(message, () => { clearTimeout(timer); stopGroup(); });
}

function appendRoots(existing, additions) {
  const result = [...existing];
  for (const root of additions) if (!result.includes(root)) result.push(root);
  return result;
}

function commandRoots(message) {
  if (!Array.isArray(message.excludedRoots) || message.excludedRoots.some((root) => typeof root !== "string")) throw new Error("roots");
  if (typeof message.cwd !== "string" || message.cwd !== process.cwd()) throw new Error("cwd");
  return appendRoots(message.excludedRoots, [message.cwd]);
}

function completeRoots(expected, message) {
  return appendRoots(knownRoots, [...expected.excludedRootInputs, ...expected.excludedRoots, ...commandRoots(message)]);
}

function assertRunBinding(message) {
  const expected = parseGitExpectation(message.expected);
  if (typeof message.identityKey !== "string" || message.identityKey !== boundIdentityKey
    || expected.identityKey !== boundIdentityKey || typeof message.executable !== "string"
    || message.executable !== boundExecutable || expected.executablePath !== boundExecutable) throw new Error("identity");
  const roots = completeRoots(expected, message);
  const binding = currentHostGit(roots);
  if (binding.executablePath !== boundExecutable) throw new Error("executable");
  knownRoots = roots;
  return { roots: [...knownRoots], identityKey: expected.identityKey };
}

function assertActiveBinding(identityKey) {
  if (identityKey !== activeIdentityKey || identityKey !== boundIdentityKey) throw new Error("identity");
  const binding = currentHostGit(activeRoots);
  if (binding.executablePath !== boundExecutable) throw new Error("executable");
}

function inputBytes(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new Error("input");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("input");
  return bytes;
}

function assertInputShape(message) {
  const keys = Object.keys(message).sort();
  const expectedKeys = message.input === undefined
    ? ["id", "identityKey", "type"]
    : ["id", "identityKey", "input", "type"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error("input");
  if (message.type !== "input" || typeof message.identityKey !== "string") throw new Error("input");
  return inputBytes(message.input);
}

function failActiveRun() {
  activeFailed = true;
  activeStdout.length = 0;
  activeStderr.length = 0;
  try { child?.kill("SIGKILL"); } catch { /* 真实close后发送固定失败。 */ }
}

function resetActive(id) {
  child = undefined;
  activeId = undefined;
  activeRoots = [];
  activeIdentityKey = undefined;
  activeStdout = [];
  activeStderr = [];
  activeInputReceived = false;
  activeFailed = false;
  lastCompletedId = id;
}

process.on("disconnect", () => { if (!closing) stopGroup(); });
process.on("uncaughtException", stopGroup);
process.on("unhandledRejection", stopGroup);
process.on("message", (message) => {
  if (!message || typeof message !== "object" || Array.isArray(message)) return stopGroup();
  if (message.type === "shutdown") {
    if (child) return stopGroup();
    closing = true;
    process.disconnect();
    return;
  }
  if (message.type === "git-init") {
    if (phase !== "bootstrap") return stopGroup();
    phase = "initializing";
    try {
      const expected = parseGitExpectation(message.expected);
      if (typeof message.identityKey !== "string" || message.identityKey !== expected.identityKey) throw new Error("identity");
      const roots = appendRoots([], [...expected.excludedRootInputs, ...expected.excludedRoots, ...commandRoots(message)]);
      const binding = initializeInheritedGit(expected, roots);
      if (binding.executablePath !== expected.executablePath) throw new Error("executable");
      knownRoots = roots;
      boundIdentityKey = expected.identityKey;
      boundExecutable = binding.executablePath;
      phase = "ready";
      send({ type: "ready", identityKey: boundIdentityKey, executablePath: boundExecutable });
    } catch {
      fixedFailure("init-failed");
    }
    return;
  }
  if (message.type === "input") {
    if (phase !== "ready") return stopGroup();
    if (!Number.isSafeInteger(message.id) || message.id <= 0) {
      if (child) failActiveRun(); else stopGroup();
      return;
    }
    // 父进程串行递增run id；已完成旧run的迟到input没有执行能力，也不污染当前run。
    if (message.id <= lastCompletedId) return;
    if (!child || activeId === undefined) return stopGroup();
    if (message.id !== activeId || activeInputReceived) { failActiveRun(); return; }
    let bytes;
    try {
      bytes = assertInputShape(message);
      assertActiveBinding(message.identityKey);
    } catch {
      failActiveRun();
      return;
    }
    activeInputReceived = true;
    child.stdin.on("error", () => undefined);
    try { child.stdin.end(bytes); }
    catch { failActiveRun(); }
    return;
  }
  if (message.type !== "run" || phase !== "ready" || child || !Number.isSafeInteger(message.id)
    || message.id <= 0 || message.id !== lastCompletedId + 1
    || !Array.isArray(message.args) || message.args.some((arg) => typeof arg !== "string")
    || message.env === null || typeof message.env !== "object" || Array.isArray(message.env)
    || !Number.isSafeInteger(message.timeout) || message.timeout <= 0
    || !Number.isSafeInteger(message.maxBuffer) || message.maxBuffer <= 0) return stopGroup();

  let runBinding;
  try { runBinding = assertRunBinding(message); }
  catch { fixedFailure("binding-failed", message.id); return; }

  activeId = message.id;
  activeRoots = runBinding.roots;
  activeIdentityKey = runBinding.identityKey;
  activeStdout = [];
  activeStderr = [];
  activeInputReceived = false;
  activeFailed = false;
  const id = activeId;
  let size = 0, overflow = false, timedOut = false, spawnCode;
  let proc;
  try {
    // 这是实际spawn前的最后一步；绑定失效时不会启动Git。
    assertActiveBinding(activeIdentityKey);
    proc = spawn(boundExecutable, message.args, {
      cwd: message.cwd,
      env: message.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    resetActive(id);
    fixedFailure("binding-failed", id);
    return;
  }
  child = proc;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, message.timeout);
  const collect = (chunks) => (chunk) => {
    if (activeFailed) return;
    size += chunk.length;
    if (size > message.maxBuffer) { overflow = true; proc.kill("SIGKILL"); return; }
    chunks.push(Buffer.from(chunk));
  };
  proc.stdout.on("data", collect(activeStdout));
  proc.stderr.on("data", collect(activeStderr));
  proc.once("error", (error) => { spawnCode = error.code ?? "spawn_failed"; });
  proc.once("close", (code) => {
    clearTimeout(timer);
    child = undefined;
    const identityKey = activeIdentityKey;
    const failed = activeFailed;
    const stdout = failed ? Buffer.alloc(0) : Buffer.concat(activeStdout);
    const stderr = failed ? Buffer.alloc(0) : Buffer.concat(activeStderr);
    if (!failed) {
      try {
        // 只有真实close后的复验通过，才允许把受限输出交回父进程。
        assertActiveBinding(identityKey);
      } catch {
        resetActive(id);
        fixedFailure("binding-failed", id);
        return;
      }
    }
    resetActive(id);
    if (failed) {
      fixedFailure("binding-failed", id);
      return;
    }
    send({ type: "result", id, identityKey, code: code ?? -1,
      stdout: stdout.toString("base64"), stderr: stderr.toString("base64"),
      overflow, timedOut, ...(spawnCode === undefined ? {} : { spawnCode }) });
  });
  send({ type: "started", id, pid: proc.pid, identityKey: activeIdentityKey });
});

// 先注册message监听，再通知父进程；此时尚未解析期望或执行Git --version。
send({ type: "bootstrap-ready" });
