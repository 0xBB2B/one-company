// @ts-check
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const SOURCE_URL = new URL("../runtime/daemon-client.ts", import.meta.url);
const SOURCE = readFileSync(SOURCE_URL, "utf8");
const REPO_ID = "a".repeat(64);

/** @param {import("node:vm").Context} context @param {string} id @param {Record<string, unknown>} values */
async function synthetic(context, id, values) {
  const module = new SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context, identifier: id });
  await module.link(() => { throw new Error(`unexpected dependency from ${id}`); });
  await module.evaluate();
  return module;
}

class FakeSocket extends EventEmitter {
  constructor() { super(); this.destroyed = false; this.pendingClose = false; this.encoding = undefined; this.destroyCalls = 0; }
  setEncoding(value) { this.encoding = value; }
  write(text) {
    const request = JSON.parse(String(text));
    if (request.method === "hello") queueMicrotask(() => this.emit("data", JSON.stringify({ t: "res", id: request.id, ok: true, result: {
      repoId: REPO_ID, protocolVersion: 1, daemonPid: 7001, startedAt: "now",
      daemonInstanceId: "10000000-0000-4000-8000-000000000001",
      connectionId: "20000000-0000-4000-8000-000000000002", gitExpectation: "fixed",
    } }) + "\n"));
    return true;
  }
  destroy(error) {
    this.destroyCalls++;
    this.destroyed = true;
    this.pendingClose = true;
    if (error) queueMicrotask(() => this.emit("error", error));
    return this;
  }
  releaseClose() {
    if (!this.pendingClose && !this.destroyed) this.destroyed = true;
    if (this.pendingClose || this.destroyed) { this.pendingClose = false; this.emit("close"); }
  }
}

/** @param {() => boolean} condition @param {string} label */
async function until(condition, label) {
  for (let index = 0; index < 50; index++) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(`VM condition did not settle: ${label}`);
}

async function world() {
  const context = createContext({ Buffer, AggregateError, Error, Map, Math, Object, Promise, Set, JSON, console,
    process: { execPath: "/fixed/node" }, queueMicrotask, setTimeout, clearTimeout, Date });
  /** @type {FakeSocket[]} */ const sockets = [];
  /** @type {{kind:"success"|"error"|"pending", code?:string, error?:Error}[]} */ const outcomes = [];
  let spawns = 0;
  const timers = new Map();
  let timerId = 0;
  const clock = {
    setTimeoutExcludingSleep(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimer(id) { timers.delete(id); },
    stopGapWatcher() {},
  };
  const modules = new Map();
  modules.set("./daemon-auth.ts", await synthetic(context, "auth", { controlToken: () => "token" }));
  modules.set("node:fs", await synthetic(context, "fs", { closeSync() {}, openSync() { return 3; } }));
  modules.set("node:fs/promises", await synthetic(context, "fsp", { mkdir: async () => {}, open: async () => { throw new Error("unused"); } }));
  modules.set("node:child_process", await synthetic(context, "cp", { spawn() {
    spawns++;
    const child = new EventEmitter();
    child.unref = () => {};
    child.exitCode = null;
    child.signalCode = null;
    return child;
  } }));
  modules.set("node:net", await synthetic(context, "net", {
    Socket: FakeSocket,
    createConnection() {
      const socket = new FakeSocket(); sockets.push(socket);
      const outcome = outcomes.shift() ?? { kind: "success" };
      queueMicrotask(() => {
        if (outcome.kind === "success") socket.emit("connect");
        else if (outcome.kind === "error") {
          const error = outcome.error ?? Object.assign(new Error(outcome.code), { code: outcome.code });
          socket.emit("error", error);
        }
      });
      return socket;
    },
  }));
  modules.set("node:path", await synthetic(context, "path", { dirname: path.dirname, join: path.join }));
  modules.set("node:url", await synthetic(context, "url", { fileURLToPath }));
  modules.set("@earendil-works/pi-coding-agent", await synthetic(context, "sdk", { getPackageDir: () => "/sdk" }));
  modules.set("../daemon/lifecycle.ts", await synthetic(context, "lifecycle", { probeExistingInstance: async () => "existing", socketPathByteLimit: () => 1000 }));
  modules.set("./clock.ts", await synthetic(context, "clock", { createClock: () => clock }));
  modules.set("./database.ts", await synthetic(context, "database", { uuidv7: () => "00000000-0000-4000-8000-000000000001" }));
  modules.set("./identity.ts", await synthetic(context, "identity", {
    daemonSocketPath: () => "/vm/socket", discoverWorkspace: async () => ({ repos: [], skipped: [] }),
    listWorktrees: async () => [], repoDataDir: async () => "/data", repositoryIdentity: async () => ({ repoId: REPO_ID, commonDir: "/repo" }),
  }));
  let requestId = 0;
  modules.set("./protocol.ts", await synthetic(context, "protocol", {
    PROTOCOL_VERSION: 1,
    createRequest: (method, params) => ({ t: "req", id: String(++requestId), method, params }),
    encodeFrame: (frame) => JSON.stringify(frame) + "\n",
    decodeFrames(text) { const lines = text.split("\n"); const rest = lines.pop() ?? ""; return { frames: lines.filter(Boolean).map(JSON.parse), rest }; },
  }));
  modules.set("./git-daemon-binding.ts", await synthetic(context, "binding", {
    createGitExpectationText: () => "fixed", currentGitBinding() {}, decodeGitExpectation: () => ({}),
    gitExpectationRoots: () => [], isGitBindingFailure: () => false, verifyPeerGitBinding() {},
  }));
  const text = stripTypeScriptTypes(SOURCE, { mode: "strip" });
  const module = new SourceTextModule(text, { context, identifier: SOURCE_URL.href, initializeImportMeta(meta) { meta.url = SOURCE_URL.href; } });
  await module.link((specifier) => { const dependency = modules.get(specifier); if (!dependency) throw new Error(`unexpected import ${specifier}`); return dependency; });
  await module.evaluate();
  return {
    api: module.namespace, outcomes, sockets, spawns: () => spawns, timers,
    fireTimer() { const entry = timers.entries().next().value; assert.ok(entry); timers.delete(entry[0]); entry[1](); },
  };
}

function options(connectOnly = true) {
  return { repoDir: "/repo", dataRoot: "/data", sdkDir: "/sdk", connectOnly,
    hello: { windowId: "w", sessionId: "s", pid: 1, cwd: "/repo", workspaceRoot: "/repo" } };
}

let cases = 0;
{
  const w = await world();
  const client = await w.api.connectDaemon(options());
  const socket = w.sockets[0];
  const external = () => {};
  socket.on("data", external);
  client.close();
  assert.equal(socket.listeners("data").includes(external), true, "SocketLink must not remove external listeners");
  let settled = false;
  const waiting = client.waitClosed().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, "waitClosed must wait for the original socket close event");
  socket.releaseClose();
  await waiting;
  assert.equal(settled, true);
  cases++;
}

{
  const w = await world();
  const original = Object.assign(new Error("original-connect-error"), { code: "ENOENT" });
  w.outcomes.push({ kind: "error", code: "ENOENT", error: original });
  const connecting = w.api.connectDaemon(options()).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
  await until(() => w.sockets.length === 1, "first connect socket");
  await until(() => w.sockets[0].destroyed, "first connect error destroy");
  assert.equal(w.spawns(), 0, "connectOnly initial failure must not spawn");
  w.sockets[0].releaseClose();
  const result = await connecting;
  assert.equal(result.ok, false);
  assert.equal(result.error, original, "first connect error identity must be preserved");
  cases++;
}

{
  const w = await world();
  w.outcomes.push({ kind: "pending" });
  let settled = false;
  const connecting = w.api.connectDaemon(options()).then(() => { settled = true; }, () => { settled = true; });
  await until(() => w.sockets.length === 1, "pending connect socket");
  w.sockets[0].releaseClose();
  await connecting;
  assert.equal(settled, true, "close before connect must settle the connect promise");
  assert.equal(w.spawns(), 0);
  cases++;
}

{
  const w = await world();
  const client = await w.api.connectDaemon(options());
  w.outcomes.push({ kind: "error", code: "ECONNREFUSED" });
  w.sockets[0].emit("close");
  await until(() => w.timers.size === 1, "reconnect timer");
  w.fireTimer();
  await until(() => w.sockets.length === 2, "reconnect socket");
  await until(() => w.sockets[1].destroyed, "reconnect error destroy");
  assert.equal(w.spawns(), 0, "connectOnly reconnect must not spawn");
  client.close();
  w.sockets[1].releaseClose();
  await client.waitClosed();
  assert.equal(w.timers.size, 0);
  cases++;
}

{
  const w = await world();
  const client = await w.api.connectDaemon(options());
  w.outcomes.push({ kind: "pending" });
  w.sockets[0].emit("close");
  await until(() => w.timers.size === 1, "pending reconnect timer");
  w.fireTimer();
  await until(() => w.sockets.length === 2, "pending reconnect socket");
  client.close();
  assert.equal(w.sockets[1].destroyed, true, "close must destroy a registered pre-connect socket");
  let settled = false;
  const waiting = client.waitClosed().then(() => { settled = true; });
  w.sockets[1].emit("connect");
  await Promise.resolve();
  assert.equal(w.sockets[1].destroyed, true, "late connect cannot revive a socket after close");
  assert.equal(settled, false);
  w.sockets[1].releaseClose();
  await waiting;
  assert.equal(settled, true);
  cases++;
}

{
  const w = await world();
  w.outcomes.push({ kind: "error", code: "ENOENT" }, { kind: "success" });
  const connecting = w.api.connectDaemon(options(false));
  await until(() => w.sockets.length === 1 && w.sockets[0].destroyed, "default first socket failure");
  w.sockets[0].releaseClose();
  const client = await connecting;
  assert.equal(w.spawns(), 1, "default mode must retain its original spawn capability");
  client.close();
  w.sockets[1].releaseClose();
  await client.waitClosed();
  cases++;
}

assert.equal(cases, 6);
process.stdout.write(`daemon-client close VM: ${cases} cases PASS\n`);
