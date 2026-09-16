import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const require = createRequire(import.meta.url);
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");

function virtualHarness() {
  let now = 0;
  let timerId = 0;
  let inode = 100;
  let allocation = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  const files = new Map<string, ReturnType<typeof stat>>();
  const sockets: VirtualSocket[] = [];
  const children: VirtualChild[] = [];
  const log: unknown[][] = [];
  const tokenCalls: string[] = [];
  const repoReceipts = new WeakMap<object, object>();
  const root = join(repo, ".vm-only");
  const control = { autoConnect: true, closeSocket: true, reply: true, gateInvalid: false, groupAlive: false,
    afterToken: undefined as undefined | (() => void), afterReply: undefined as undefined | (() => void),
    eventAfterReply: false, afterRm: undefined as undefined | ((path: string) => void),
    identityGate: undefined as undefined | Promise<void>, allocationGate: undefined as undefined | Promise<void>,
    daemonPid: undefined as undefined | number, afterSocketClose: undefined as undefined | (() => void) };
  const setTimeout = (run: () => void, ms: number) => { const id = ++timerId; timers.set(id, { at: now + ms, run }); return id; };
  const clearTimeout = (id: number) => timers.delete(id);
  const stat = (ino = ++inode, type = "dir") => ({ dev: 1, ino, isDirectory: () => type === "dir", isSymbolicLink: () => type === "link" });
  const allocate = (path: string) => { files.set(path, stat()); return path; };

  class VirtualSocket extends EventEmitter {
    destroyed = false;
    writes: Array<Record<string, unknown>> = [];
    constructor(readonly path: string) { super(); sockets.push(this); }
    write(text: string, callback?: (error?: Error) => void) {
      const request = JSON.parse(text);
      this.writes.push(request);
      callback?.();
      if (control.reply) queueMicrotask(() => {
        const digit = this.writes.length === 1 ? "2" : "3";
        const result = {
          daemonPid: control.daemonPid ?? 700001,
          repoId: "a".repeat(64),
          protocolVersion: 2,
          daemonInstanceId: "11111111-1111-4111-8111-111111111111",
          connectionId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
          gitExpectation: request.params.gitExpectation,
        };
        const event = control.eventAfterReply ? `${JSON.stringify({ t: "evt", event: "cleanup", data: {} })}\n` : "";
        this.emit("data", Buffer.from(`${JSON.stringify({ t: "res", id: request.id, ok: true, result })}\n${event}`));
        control.afterReply?.();
      });
      return true;
    }
    end() {}
    destroy() {
      this.destroyed = true;
      if (control.closeSocket) queueMicrotask(() => { this.emit("close"); control.afterSocketClose?.(); });
      return this;
    }
  }
  class VirtualChild extends EventEmitter {
    pid = 700002 + children.length;
    exitCode: number | null = null;
    signalCode: string | null = null;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    constructor() { super(); children.push(this); }
    unref() {}
  }
  class VirtualSignal extends EventEmitter {
    aborted = false;
    reason?: Error;
    addEventListener(event: string, listener: () => void, options?: { once?: boolean }) { options?.once ? this.once(event, listener) : this.on(event, listener); }
    removeEventListener(event: string, listener: () => void) { this.off(event, listener); }
    abort() { this.aborted = true; this.reason = new Error("virtual abort"); this.emit("abort"); }
  }

  const virtualProcess = {
    execPath: "/virtual/node",
    platform: "darwin",
    pid: 700001,
    env: { PATH: "/virtual/bin" },
    cwd: () => root,
    kill(pid: number, signal: unknown) {
      log.push(["signal", pid, signal]);
      if (signal === 0) {
        if (control.groupAlive) return;
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      const child = children.find((item) => item.pid === -pid);
      if (!child) throw new Error("unknown virtual pid");
      queueMicrotask(() => { child.signalCode = String(signal); child.emit("close", null, signal); });
    },
  };
  const context = createContext({
    Buffer,
    console: { error: (...args: unknown[]) => log.push(["stderr", ...args]) },
    StringDecoder,
    queueMicrotask,
    process: virtualProcess,
    performance: { now: () => now },
    setTimeout,
    clearTimeout,
    AbortController: class { signal = new VirtualSignal(); abort() { this.signal.abort(); } },
    __moduleUrl: new URL(`file://${join(repo, "tests/helpers/daemon-harness.ts")}`).href,
  });

  function module<T extends object = Record<string, unknown>>(name: string, source: string, dependencies: Record<string, unknown>, extra = ""): T {
    const names: string[] = [];
    const stripped = stripTypeScriptTypes(`${source.replaceAll("import.meta.url", "__moduleUrl")}\n${extra}`, { mode: "strip" });
    const js = stripped
      .replace(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/g, (_match, imported, path) => `const ${imported} = require(${JSON.stringify(path)});`)
      .replace(/export\s+(async\s+)?(function|class|const|let)\s+(\w+)/g, (_match, asyncPart, kind, exported) => { names.push(exported); return `${asyncPart ?? ""}${kind} ${exported}`; })
      + `\nObject.assign(exports,{${names.join(",")}});`;
    const exports: Record<string, unknown> = {};
    runInContext(`(function(require,exports){${js}\n})`, context, { filename: name })((key: string) => {
      if (!(key in dependencies)) throw new Error(`Forbidden import ${key} in ${name}`);
      return dependencies[key];
    }, exports);
    return exports as T;
  }

  const prerequisite = {
    GitPrerequisiteError: class extends Error {},
    assertGitCurrent: () => { if (control.gateInvalid) throw new Error("virtual Git changed"); },
    checkGitVersion: () => {},
    resolveHostGit: ({ excludedRoots }: { excludedRoots: string[] }) => {
      const data = {
        entryPath: "/virtual/bin/git", executablePath: "/virtual/bin/git", platform: "darwin", uid: 1,
        excludedRootInputs: excludedRoots, excludedRoots: [],
        entry: { path: "/virtual/bin/git", type: "file", dev: "1", ino: "2", uid: 1, gid: 1, mode: 493, ctimeNs: "1" },
        target: { path: "/virtual/bin/git", type: "file", dev: "1", ino: "2", uid: 1, gid: 1, mode: 493, ctimeNs: "1", sha256: "b".repeat(64) },
        canonicalEntryDirectory: "/virtual/bin", directories: [], directoryLinks: [], fileLinks: [],
      };
      return runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(data))})`, context);
    },
  };
  const runtime = module<typeof import("../runtime/git-runtime.mjs")>("git-runtime.mjs", read("runtime/git-runtime.mjs"), { "node:crypto": { createHash }, "node:path": require("node:path"), "./git-prerequisite.mjs": prerequisite });
  const binding = module("git-daemon-binding.ts", read("runtime/git-daemon-binding.ts"), { "./git-runtime.mjs": runtime });
  const protocolSource = read("runtime/protocol.ts");
  const protocolSubset = `export const PROTOCOL_VERSION=2;\n${protocolSource.slice(protocolSource.indexOf("function isPlainObject"), protocolSource.indexOf("type ProtocolError"))}${protocolSource.slice(protocolSource.indexOf("export function decodeFrames"), protocolSource.indexOf("export function createResponse"))}`;
  const protocol = module("protocol.ts", protocolSubset, {});
  const io = {
    mkdtemp: async (prefix: string) => { await control.allocationGate; return allocate(`${prefix}${++allocation}`); },
    lstat: async (path: string) => { const value = files.get(path); if (!value) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" }); return value; },
    mkdir: async () => {}, writeFile: async () => {},
    rm: async (path: string) => { log.push(["rm", path]); files.delete(path); control.afterRm?.(path); },
  };
  const home = module<typeof import("./helpers/temp-home.ts")>("temp-home.ts", read("tests/helpers/temp-home.ts"), { "node:fs/promises": io, "node:os": { tmpdir: () => root }, "node:path": require("node:path") });
  const repoModule = {
    createRepoFixture: async () => {
      const fixture = { root: allocate(join(root, `repo-${++allocation}`)), worktrees: [] };
      const info = files.get(fixture.root)!;
      repoReceipts.set(fixture, { path: fixture.root, dev: info.dev, ino: info.ino });
      return fixture;
    },
    repoFixtureRootReceipt: (fixture: object) => repoReceipts.get(fixture),
  };
  const spawn = () => new VirtualChild();
  type Raw = import("./helpers/daemon-harness.ts").RawClient;
  type VmSocketRecord = { owner: { sockets: Set<object> }; closed: boolean };
  type Harness = typeof import("./helpers/daemon-harness.ts") & {
    __vm: { rawRecords: WeakMap<Raw, VmSocketRecord>; closeSocket(record: VmSocketRecord): Promise<void> };
  };
  const harness = module<Harness>("daemon-harness.ts", read("tests/helpers/daemon-harness.ts"), {
    "node:child_process": { spawn }, "node:string_decoder": { StringDecoder }, "node:fs": { lstatSync: (path: string) => {
      const value = files.get(path); if (!value) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" }); return value;
    } }, "node:fs/promises": io,
    "node:net": { createConnection: (path: string) => { const socket = new VirtualSocket(path); if (control.autoConnect) queueMicrotask(() => socket.emit("connect")); return socket; } },
    "node:path": require("node:path"), "node:url": require("node:url"), "../../daemon/lifecycle.ts": { socketPathByteLimit: () => 4096 },
    "../../runtime/daemon-auth.ts": { controlToken: (path: string) => { tokenCalls.push(path); control.afterToken?.(); return "c".repeat(64); } },
    "../../runtime/git-daemon-binding.ts": binding,
    "../../runtime/identity.ts": { daemonSocketPath: (path: string, id: string) => join(path, "sock", `${id.slice(0, 16)}.sock`), repositoryIdentity: async (path: string) => { await control.identityGate; return { repoId: "a".repeat(64), commonDir: path }; } },
    "../../runtime/protocol.ts": protocol, "./temporary-root.ts": { temporaryRoot: () => root }, "./temp-home.ts": home,
    "./repo-fixture.ts": repoModule, "./test-git-binding.ts": { initializeTestHostGit: runtime.initializeHostGit },
  }, "export const __vm={fixtureRecords,rawRecords,closeSocket};");
  runtime.initializeHostGit([]);
  const flush = async () => { for (let index = 0; index < 200; index++) await Promise.resolve(); };
  const tick = async (ms: number) => {
    now += ms;
    for (let round = 0; round < 50; round++) {
      const due = [...timers].filter(([, timer]) => timer.at <= now);
      if (!due.length) { await flush(); if (![...timers.values()].some((timer) => timer.at <= now)) break; }
      for (const [id, timer] of due) { timers.delete(id); timer.run(); }
      await flush();
    }
  };
  return { harness, home, control, sockets, children, tokenCalls, log, files, stat, flush, tick, VirtualSignal };
}

function observed(promise: Promise<unknown>) {
  const result: { state: "pending" | "fulfilled" | "rejected"; value?: unknown; error?: unknown } = { state: "pending" };
  void promise.then((value) => { result.state = "fulfilled"; result.value = value; }, (error) => { result.state = "rejected"; result.error = error; });
  return result;
}

test("纯 VM：预取消 RPC、便利重 hello 与默认 token 都按一次结算契约执行", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  const raw = await world.harness.connectRawClient(fixture.socketPath, { dataRoot: fixture.dataRoot });
  const signal = new world.VirtualSignal();
  signal.abort();
  const cancelled = observed(raw.call("ping", {}, { signal: signal as unknown as AbortSignal, timeoutMs: 20 }));
  await world.flush();
  expect(cancelled.state).toBe("rejected");
  expect(world.sockets[0]!.writes).toHaveLength(0);
  expect(signal.listenerCount("abort")).toBe(0);

  const client = await world.harness.connectTestClient(fixture.socketPath, { cwd: fixture.repoDir, workspaceRoot: fixture.repoDir });
  const first = client.helloResult.connectionId;
  const next = await world.harness.authenticateTestClient(client, { cwd: fixture.repoDir, workspaceRoot: fixture.repoDir });
  expect(world.sockets[1]!.writes).toHaveLength(2);
  expect(next.connectionId).not.toBe(first);
  expect(world.tokenCalls.length).toBeGreaterThan(0);
});

test("纯 VM：凭据后的 Git 变化在 hello 写出前拒绝", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  const raw = await world.harness.connectRawClient(fixture.socketPath);
  world.control.afterToken = () => { world.control.gateInvalid = true; };
  await expect(world.harness.authenticateTestClient(raw, { cwd: fixture.repoDir, workspaceRoot: fixture.repoDir })).rejects.toThrow("Git");
  expect(world.sockets[0]!.writes).toHaveLength(0);
});

test("纯 VM：remove 取消连接败方，迟到 connect 不会交付", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  world.control.autoConnect = false;
  const connecting = observed(world.harness.connectRawClient(fixture.socketPath, { timeoutMs: 10_000 }));
  await world.flush();
  const removing = observed(world.harness.removeDaemonFixture(fixture));
  await world.flush();
  world.sockets[0]!.emit("connect");
  await world.flush();
  expect(connecting.state).toBe("rejected");
  expect(removing.state).toBe("fulfilled");
});

test("纯 VM：未观察 close 时保留 socket 记录和所有根", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  const raw = await world.harness.connectRawClient(fixture.socketPath);
  world.control.closeSocket = false;
  const record = world.harness.__vm.rawRecords.get(raw)!;
  const closing = observed(world.harness.__vm.closeSocket(record));
  await world.tick(2_001);
  expect(closing.state).toBe("rejected");
  expect(record.owner.sockets.has(record)).toBe(true);
  const removing = observed(world.harness.removeDaemonFixture(fixture));
  await world.flush();
  await world.tick(4_001);
  expect(removing.state).toBe("rejected");
  expect(world.log.some(([kind]) => kind === "rm")).toBe(false);
});

test("纯 VM：硬输出预算在 spawn 前拒绝，原始 HOME 收据不授予克隆对象", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  expect(() => world.harness.spawnDaemonProcess({
    home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot,
    outputByteLimit: 2 * 1024 * 1024 + 1,
  })).toThrow("outputByteLimit");
  expect(world.home.tempHomeRootReceipt(fixture.home)).toMatchObject({ path: fixture.home.home });
  expect(world.home.tempHomeRootReceipt({ ...fixture.home, env: { ...fixture.home.env } })).toBeUndefined();
});

test("纯 VM：回复后调用方取消与同帧fence都拒绝迟到交付", async () => {
  for (const mode of ["abort", "fence"]) {
    const world = virtualHarness();
    const fixture = await world.harness.createDaemonFixture();
    const raw = await world.harness.connectRawClient(fixture.socketPath);
    const signal = new world.VirtualSignal();
    let removal: ReturnType<typeof observed> | undefined;
    if (mode === "abort") world.control.afterReply = () => signal.abort();
    else {
      world.control.eventAfterReply = true;
      raw.onEvent("cleanup", () => { removal = observed(world.harness.removeDaemonFixture(fixture)); });
    }
    const request = mode === "abort"
      ? world.harness.authenticateTestClient(raw, { cwd: fixture.repoDir }, { signal: signal as unknown as AbortSignal })
      : raw.call("ping");
    const result = observed(request);
    await world.flush();
    expect(result.state, mode).toBe("rejected");
    if (removal) { await world.flush(); expect(removal.state).toBe("fulfilled"); }
  }
});

test("纯 VM：手动close到close事件之间认证不能先写凭据", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  const raw = await world.harness.connectRawClient(fixture.socketPath);
  raw.close();
  await expect(world.harness.authenticateTestClient(raw)).rejects.toThrow();
  expect(world.tokenCalls).toHaveLength(0);
});

test("纯 VM：原根在使用前或逐根删除之间变化时不使用或删除替换者", async () => {
  for (const mode of ["spawn", "remove"]) {
    const world = virtualHarness();
    const fixture = await world.harness.createDaemonFixture();
    const changeHome = () => world.files.set(fixture.home.home, world.stat());
    if (mode === "spawn") {
      changeHome();
      expect(() => world.harness.spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot })).toThrow("身份已变化");
      expect(world.children).toHaveLength(0);
    } else {
      world.control.afterRm = (path) => { if (path === fixture.dataRoot) changeHome(); };
      await expect(world.harness.removeDaemonFixture(fixture)).rejects.toThrow();
      expect(world.log.some(([kind, path]) => kind === "rm" && path === fixture.home.home)).toBe(false);
    }
  }
});

test("纯 VM：捕获home快照与普通路径别名不能绕过原owner墓碑", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  const home = fixture.home.home;
  let reads = 0;
  Object.defineProperty(fixture.home, "home", { configurable: true, get() { return reads++ === 0 ? "/different-home" : home; } });
  expect(() => world.harness.spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot })).toThrow("不匹配");
  expect(world.children).toHaveLength(0);
  Object.defineProperty(fixture.home, "home", { value: home, writable: true, configurable: true });
  await world.harness.removeDaemonFixture(fixture);
  expect(() => world.harness.spawnDaemonProcess({
    home: { ...fixture.home, home: `${home}/.`, agentDir: `${fixture.home.agentDir}/.`, dataRoot: `${fixture.home.dataRoot}/.`, env: { ...fixture.home.env } },
    repoDir: `${fixture.repoDir}/.`, dataRoot: `${fixture.dataRoot}/.`,
  })).toThrow("清理");
  expect(world.children).toHaveLength(0);
});

test("纯 VM：identity期限失败先返回，原操作保留直到实际完成且不再spawn", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  let release!: () => void;
  world.control.identityGate = new Promise<void>((resolve) => { release = resolve; });
  const starting = observed(world.harness.startDaemonForTest(fixture, { waitTimeoutMs: 10 }));
  await world.flush();
  await world.tick(11);
  expect(starting.state).toBe("rejected");
  const removing = observed(world.harness.removeDaemonFixture(fixture));
  await world.flush();
  expect(removing.state).toBe("pending");
  expect(world.log.some(([kind]) => kind === "rm")).toBe(false);
  release();
  await world.flush();
  expect(removing.state).toBe("fulfilled");
  expect(world.children).toHaveLength(0);
});

test("纯 VM：创建期由外层取消，迟到分配只进入清理而不交付fixture", async () => {
  const world = virtualHarness();
  let release!: () => void;
  world.control.allocationGate = new Promise<void>((resolve) => { release = resolve; });
  const creating = observed(world.harness.createDaemonFixture());
  await world.flush();
  const cleaning = observed(world.harness.cleanupDaemonHarnessFixtures());
  await world.flush();
  expect(cleaning.state).toBe("pending");
  release();
  await world.flush();
  expect(creating.state).toBe("rejected");
  expect(cleaning.state).toBe("fulfilled");
  expect(world.children).toHaveLength(0);
  expect(world.files.size).toBe(0);
});

test("纯 VM：坏外观仍停止原child，已退出组状态恢复可安全重试", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  world.harness.spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir, dataRoot: fixture.dataRoot });
  fixture.repoId = "b".repeat(64);
  await expect(world.harness.removeDaemonFixture(fixture)).rejects.toThrow();
  expect(world.log.some(([kind, , signal]) => kind === "signal" && signal !== 0)).toBe(true);
  expect(world.log.some(([kind]) => kind === "rm")).toBe(false);
  fixture.repoId = "a".repeat(64);
  await world.harness.removeDaemonFixture(fixture);

  const retryWorld = virtualHarness();
  const retryFixture = await retryWorld.harness.createDaemonFixture();
  const handle = retryWorld.harness.spawnDaemonProcess({ home: retryFixture.home, repoDir: retryFixture.repoDir, dataRoot: retryFixture.dataRoot });
  retryWorld.control.groupAlive = true;
  const stopping = observed(retryWorld.harness.killDaemon(handle));
  await retryWorld.flush();
  await retryWorld.tick(2_001);
  expect(stopping.state).toBe("rejected");
  retryWorld.control.groupAlive = false;
  const signalCount = retryWorld.log.filter(([kind, , signal]) => kind === "signal" && signal !== 0).length;
  await retryWorld.harness.killDaemon(handle);
  expect(retryWorld.log.filter(([kind, , signal]) => kind === "signal" && signal !== 0)).toHaveLength(signalCount);
});

test("纯 VM：ownerless readiness关闭未知立即停止重试并带回资源", async () => {
  const world = virtualHarness();
  const home = await world.home.createTempHome();
  const dataRoot = join(home.home, "borrowed-data"), repoDir = join(home.home, "borrowed-repo");
  world.control.closeSocket = false;
  const starting = observed(world.harness.startDaemonForTest({ home, dataRoot, repoDir,
    socketPath: join(dataRoot, "sock", `${"a".repeat(16)}.sock`) }, { waitTimeoutMs: 8000 }));
  await world.flush();
  await world.tick(2001);
  await world.tick(2001);
  expect(starting.state).toBe("rejected");
  expect(world.sockets).toHaveLength(1);
  const error = starting.error as AggregateError;
  expect(error.errors.some((item: { preservedSockets?: unknown[] }) => item.preservedSockets?.length)).toBe(true);
  world.control.closeSocket = true;
  world.sockets[0]!.destroy();
  await world.flush();
});

test("纯 VM：认证后等待probe close期间Git变化不能交付daemon句柄", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  world.control.daemonPid = 700002;
  world.control.afterSocketClose = () => { world.control.gateInvalid = true; };
  const starting = observed(world.harness.startDaemonForTest(fixture));
  await world.flush();
  expect(starting.state).toBe("rejected");
  expect(world.children).toHaveLength(1);
  expect(world.log.filter(([kind, , signal]) => kind === "signal" && signal !== 0)).toHaveLength(1);
  await world.harness.removeDaemonFixture(fixture);
});

test("纯 VM：raw监听探测也不能吞未关闭连接后重试", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  world.control.closeSocket = false;
  const waiting = observed(world.harness.waitForSocketReady(fixture.socketPath, 5000));
  await world.flush();
  await world.tick(2001);
  expect(waiting.state).toBe("rejected");
  expect(world.sockets).toHaveLength(1);
  expect((waiting.error as { preservedSockets: unknown[] }).preservedSockets).toHaveLength(1);
  world.control.closeSocket = true;
  world.sockets[0]!.destroy();
  await world.flush();
  await world.harness.removeDaemonFixture(fixture);
});

test("纯 VM：解码导致文本越过预算时不能仍声称日志完整", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  const handle = world.harness.spawnDaemonProcess({ home: fixture.home, repoDir: fixture.repoDir,
    dataRoot: fixture.dataRoot, captureOutput: true, outputByteLimit: 1 });
  const child = world.children[0]!;
  child.stdout.emit("data", Buffer.from([255]));
  child.exitCode = 0;
  child.emit("close", 0, null);
  const result = await handle.exited;
  expect(result.outputTruncated).toBe(true);
  expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(1);
  await world.harness.removeDaemonFixture(fixture);
});

test("纯 VM：同批事件逐handler与逐frame遵守close/fence，正常批次完整交付", async () => {
  for (const mode of ["close", "fence", "normal"]) {
    const world = virtualHarness();
    const fixture = await world.harness.createDaemonFixture();
    const raw = await world.harness.connectRawClient(fixture.socketPath);
    const calls: string[] = [];
    let cleanup: Promise<void> | undefined;
    raw.onEvent("first", () => {
      calls.push("first");
      if (mode === "close") raw.close();
      if (mode === "fence") cleanup = world.harness.removeDaemonFixture(fixture);
    });
    raw.onEvent("first", () => calls.push("second"));
    raw.onEvent("late", () => calls.push("late"));
    const frames = ["first", "late"].map((event) => JSON.stringify({ t: "evt", event, data: {} })).join("\n") + "\n";
    world.sockets[0]!.emit("data", Buffer.from(frames));
    await world.flush();
    expect(calls, mode).toEqual(mode === "normal" ? ["first", "second", "late"] : ["first"]);
    if (cleanup) await cleanup;
    else await world.harness.removeDaemonFixture(fixture);
  }
});

test("纯 VM：参数快照或序列化取消后不访问新凭据、不尝试发送", async () => {
  for (const mode of ["snapshot-close", "snapshot-abort", "json-close", "json-abort", "normal"]) {
    const world = virtualHarness();
    const fixture = await world.harness.createDaemonFixture();
    const raw = await world.harness.connectRawClient(fixture.socketPath);
    const signal = new world.VirtualSignal();
    const stop = () => { if (mode.endsWith("close")) raw.close(); else if (mode.endsWith("abort")) signal.abort(); };
    const params = {
      get cwd() { if (mode.startsWith("snapshot")) stop(); return fixture.repoDir; },
      extra: { toJSON() { if (mode.startsWith("json")) stop(); return "value"; } },
    };
    const result = observed(raw.call("hello", params, { signal: signal as unknown as AbortSignal }));
    await world.flush();
    expect(result.state, mode).toBe(mode === "normal" ? "fulfilled" : "rejected");
    expect(world.tokenCalls.length, mode).toBe(mode.startsWith("snapshot") ? 0 : 1);
    expect(world.sockets[0]!.writes.length, mode).toBe(mode === "normal" ? 1 : 0);
    expect(signal.listenerCount("abort"), mode).toBe(0);
    await world.harness.removeDaemonFixture(fixture);
  }
});

test("纯 VM：正常raw最终响应后自然EOF不撤销已结算结果", async () => {
  const world = virtualHarness();
  const fixture = await world.harness.createDaemonFixture();
  world.control.reply = false;
  const raw = await world.harness.connectRawClient(fixture.socketPath);
  const pending = raw.call("ping");
  await world.flush();
  const request = world.sockets[0]!.writes[0]!;
  world.sockets[0]!.emit("data", Buffer.from(JSON.stringify({ t: "res", id: request.id, ok: true, result: { final: true } }) + "\n"));
  world.sockets[0]!.emit("close");
  await expect(pending).resolves.toEqual({ final: true });
  await world.harness.removeDaemonFixture(fixture);
});
