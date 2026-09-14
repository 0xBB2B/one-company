import { afterEach, expect, test } from "vitest";
import { lstat, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BaselineWatchFixture } from "./helpers/project-baseline-watch-fixture.ts";
import { ProjectBaselineError, RequestBaselineGate } from "../runtime/project-baseline.ts";
import type { ProjectBaselineCapture, ProjectBaselineSeal, RequestBaselineGateOptions } from "../runtime/project-baseline.ts";
import { BaselineFixture, baselineHash, deferred } from "./helpers/project-baseline-fixture.ts";

const fixtures: Array<BaselineFixture | BaselineWatchFixture> = [];
async function watchedWorld() {
  const provider = await BaselineWatchFixture.create();
  fixtures.push(provider);
  const gate = new RequestBaselineGate(provider);
  gates.push(gate);
  return { provider, gate };
}
const gates: RequestBaselineGate[] = [];
async function world(options?: RequestBaselineGateOptions, recursive = false) {
  const provider = await BaselineFixture.create(recursive);
  fixtures.push(provider);
  const gate = new RequestBaselineGate(provider, options);
  gates.push(gate);
  return { provider, gate };
}
const known = (path: string, content: string) => ({ paths: [path], expectedWrites: [{ path, hash: baselineHash(content) }] });
const error = (code: string) => expect.objectContaining({ code });
afterEach(async () => {
  for (const gate of gates.splice(0)) gate.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

for (const { name, executable, version } of [
  { name: "宿主Node", executable: process.execPath, version: process.version },
  { name: "Node22.19", executable: process.env.M3_BASELINE_NODE22, version: "v22.19.0" },
]) {
  test.skipIf(!executable)(`${name}直接import生产模块，不依赖TypeScript语法转换flags`, async () => {
    const { stdout } = await promisify(execFile)(executable!, ["-e",
      "import(process.argv[1]).then(m=>console.log(JSON.stringify({version:process.version,code:new m.ProjectBaselineError('stale').code,gate:typeof m.RequestBaselineGate})))",
      new URL("../runtime/project-baseline.ts", import.meta.url).href], { timeout: 10000 });
    expect(JSON.parse(stdout)).toEqual({ version, code: "stale", gate: "function" });
  });
}

test("同步call守卫绑定原State/head，fresh新请求和已验证自写都不能复活旧查询", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["query", "write"], request);
  const guard = gate.captureCallGuard("query", request);
  expect(() => guard()).not.toThrow();
  expect(() => gate.captureCallGuard("query", { ...request })).toThrow();
  const mutation = gate.withMutation("write", known("a.ts", "C"), async () => provider.write("a.ts", "C"));
  expect(() => guard()).toThrow();
  await mutation;
  expect(gate.diagnostics.stale).toBe(false);
  expect(() => guard()).toThrow();
  const currentHeadGuard = gate.captureCallGuard("query", request);
  expect(() => currentHeadGuard()).not.toThrow();
  await gate.beginRequest();
  expect(gate.diagnostics.stale).toBe(false);
  expect(() => currentHeadGuard()).toThrow();
});

test("真实watch受管自写观察期间及完成后，旧query同步守卫均拒绝", async () => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["query", "write"], request);
  const guard = gate.captureCallGuard("query", request);
  await gate.withMutation("write", known("a.ts", "C"), async () => {
    await provider.writeObserved("a.ts", "C");
    expect(gate.diagnostics.stale).toBe(false);
    expect(() => guard()).toThrow();
  });
  expect(gate.diagnostics.stale).toBe(false);
  expect(() => guard()).toThrow();
});

test("消息seal无须伪造工具调用，工具与消息metadata字段互斥", async () => {
  const { gate } = await world();
  const request = await gate.beginRequest();
  const message = await gate.sealMessage(request, "assistant-completed-1");
  expect(message.metadata).toEqual({ format: "project-baseline-seal/v1", requestId: request.requestId,
    messageId: "assistant-completed-1", origin: request.origin, executionHead: request.origin });
  expect(Object.hasOwn(message.metadata, "callId")).toBe(false);
  expect(gate.diagnostics).toMatchObject({ calls: 0, seenCalls: 0, issuedSeals: 1 });
  expect(Object.isFrozen(message.metadata)).toBe(true);
  expect(message.metadata.origin).toBe(request.origin);
  expect(await gate.assertDelivery(message)).toBe(message.metadata);
  gate.bindCalls(["actual-tool-call"], request);
  const tool = await gate.sealResult("actual-tool-call");
  expect(tool.metadata.callId).toBe("actual-tool-call");
  expect(Object.hasOwn(tool.metadata, "messageId")).toBe(false);
  expect(() => gate.assertDelivery({ ...message })).toThrowError(error("invalid_seal"));
  expect(() => gate.assertDelivery(JSON.parse(JSON.stringify(message)) as ProjectBaselineSeal)).toThrowError(error("invalid_seal"));
});

test("消息seal只接受当前原request对象，拒绝伪对象、旧请求及跨gate对象", async () => {
  const { gate, provider } = await world();
  const original = await gate.beginRequest();
  expect(() => gate.sealMessage({ ...original }, "copy")).toThrowError(error("stale"));
  expect(() => gate.sealMessage(JSON.parse(JSON.stringify(original)), "json")).toThrowError(error("stale"));
  const oldSeal = await gate.sealMessage(original, "old-message");
  const current = await gate.beginRequest();
  expect(() => gate.sealMessage(original, "late-message")).toThrowError(error("stale"));
  expect(() => gate.assertDelivery(oldSeal)).toThrowError(error("invalid_seal"));
  const other = new RequestBaselineGate(provider); gates.push(other);
  await other.beginRequest();
  expect(() => other.sealMessage(current, "cross-gate")).toThrowError(error("stale"));
  const fresh = await gate.sealMessage(current, "current-message");
  expect(fresh.metadata.requestId).toBe(current.requestId);
  expect(() => other.assertDelivery(fresh)).toThrowError(error("invalid_seal"));
});

test("消息seal在排队及实际写入时busy，合法写入后只签当前head，旧seal不换绑", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  const old = await gate.sealMessage(request, "before-write");
  gate.bindCalls(["write"], request);
  const entered = deferred<void>(), release = deferred<void>();
  const mutation = gate.withMutation("write", known("a.ts", "C"), async () => { entered.resolve(); await release.promise; await provider.write("a.ts", "C"); });
  expect(() => gate.sealMessage(request, "queued")).toThrowError(error("busy"));
  await entered.promise;
  expect(() => gate.sealMessage(request, "writing")).toThrowError(error("busy"));
  release.resolve(); await mutation;
  const current = await gate.sealMessage(request, "after-write");
  expect(current.metadata.origin).toBe(request.origin);
  expect(current.metadata.executionHead.files.find((file) => file.path === "a.ts")!.hash).toBe(baselineHash("C"));
  expect(old.metadata.executionHead).toBe(request.origin);
  expect(() => gate.assertDelivery(old)).toThrowError(error("invalid_seal"));
  await gate.assertDelivery(current);
});

test.each(["authority", "bytes", "notification"])("消息seal遇到%s失效不能签发旧epoch结果", async (kind) => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  if (kind === "notification") {
    provider.notify();
    expect(() => gate.sealMessage(request, "stale-message")).toThrowError(error("stale"));
  } else {
    if (kind === "authority") provider.authority = "new-epoch";
    else await provider.write("a.ts", "EXTERNAL");
    await expect(gate.sealMessage(request, "stale-message")).rejects.toMatchObject({ code: "stale" });
  }
  expect(gate.diagnostics.issuedSeals).toBe(0);
});

test("消息seal拒绝未管理现场及非法messageId，不创建工具调用记录", async () => {
  const { gate, provider } = await world();
  provider.unmanaged = true;
  const request = await gate.beginRequest();
  for (const id of ["", "bad\nmessage", "x".repeat(4097)]) {
    expect(() => gate.sealMessage(request, id)).toThrowError(error("invalid_input"));
  }
  await expect(gate.sealMessage(request, "valid-message")).rejects.toMatchObject({ code: "unmanaged" });
  expect(gate.diagnostics).toMatchObject({ issuedSeals: 0, calls: 0, seenCalls: 0 });
});

test("消息seal异步核对期间切换请求，迟到结果不能绑定新请求", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  const entered = deferred<void>(), release = deferred<void>();
  provider.assertHook = async () => { entered.resolve(); await release.promise; };
  const pending = gate.sealMessage(request, "slow-message");
  const rejected = expect(pending).rejects.toMatchObject({ code: "stale" });
  await entered.promise;
  const next = await gate.beginRequest();
  release.resolve(); await rejected;
  provider.assertHook = undefined;
  const current = await gate.sealMessage(next, "fresh-message");
  expect(current.metadata.origin).toBe(next.origin);
  expect(current.metadata.executionHead).toBe(next.origin);
  expect(gate.diagnostics.issuedSeals).toBe(1);
});

test.each(["message", "tool"])("%s先签发后共用seal总额度，不能换入口绕过", async (first) => {
  const { gate } = await world({ maxSeals: 1 });
  const request = await gate.beginRequest();
  gate.bindCalls(["tool"], request);
  if (first === "message") {
    await gate.sealMessage(request, "message");
    await expect(gate.sealResult("tool")).rejects.toMatchObject({ code: "resource_limit" });
  } else {
    await gate.sealResult("tool");
    await expect(gate.sealMessage(request, "message")).rejects.toMatchObject({ code: "resource_limit" });
  }
});

test("真实fs.watch：连续精确写入及read_before汇总可推进原请求，旧seal不换绑", async () => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["one", "two", "result"], request);
  const originalSeal = await gate.sealResult("result");
  const one = gate.withMutation("one", known("a.ts", "C"), async () => {
    await provider.writeObserved("a.ts", "C");
    expect(gate.diagnostics.stale).toBe(false);
    expect(() => gate.sealResult("result")).toThrowError(error("busy"));
    return "one";
  });
  const two = gate.withMutation("two", known("b.ts", "D"), async () => {
    await provider.writeObserved("b.ts", "D"); return "two";
  });
  expect(await Promise.all([one, two])).toEqual(["one", "two"]);
  expect(gate.diagnostics.stale).toBe(false);
  const seal = await gate.sealResult("result");
  expect(seal.metadata.origin).toBe(request.origin);
  expect(seal.metadata.executionHead.observedSequence).toBeGreaterThan(request.origin!.observedSequence);
  expect(seal.metadata.executionHead.files.map((file) => file.hash)).toEqual([baselineHash("C"), baselineHash("D")]);
  expect(provider.events.filter((event) => event.reason === "watch").map((event) => event.path)).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
  expect(provider.events.filter((event) => event.reason === "reconciled_change")).toHaveLength(2);
  expect(() => gate.assertDelivery(originalSeal)).toThrowError(error("invalid_seal"));
  await gate.assertDelivery(seal);
});

test.each(["external-stays", "external-A-B-A"])("真实fs.watch：其他文件%s事件立即撤权，最终恢复也不能放行", async (kind) => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["write", "result"], request);
  expect(await gate.withMutation("write", known("a.ts", "C"), async () => {
    await provider.writeObserved("a.ts", "C");
    await provider.writeObserved("b.ts", "EXTERNAL");
    expect(gate.diagnostics.stale).toBe(true);
    if (kind === "external-A-B-A") await provider.writeObserved("b.ts", "B");
    return "actual";
  })).toBe("actual");
  expect(provider.events.some((event) => event.reason === "watch" && event.path === "b.ts")).toBe(true);
  expect(() => gate.sealResult("result")).toThrowError(error("stale"));
});

test.each(["unknown-path", "overflow", "watcher_failure", "authority", "sequence-gap"])("真实watch写入混入%s元数据不能归因", async (kind) => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  await gate.withMutation("write", known("a.ts", "C"), async () => {
    await provider.writeObserved("a.ts", "C");
    if (kind === "unknown-path") provider.inject("watch", { source: "watch", requiresFullReconcile: false, eventType: "change" });
    else if (kind === "authority") provider.inject("watch", { source: "watch", path: "a.ts", eventType: "change", requiresFullReconcile: false, authorityEpoch: "other" });
    else if (kind === "sequence-gap") provider.inject("watch", { source: "watch", path: "a.ts", eventType: "change", requiresFullReconcile: false, observedSequence: provider.base.sequence + 2 });
    else provider.inject(kind);
    expect(gate.diagnostics.stale).toBe(true);
  });
  expect(provider.events.some((event) => event.reason === "watch" && event.path === "a.ts")).toBe(true);
});

test("真实fs.watch：目标路径相同但实际字节不是预期值仍拒绝", async () => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  await gate.withMutation("write", known("a.ts", "C"), async () => provider.writeObserved("a.ts", "EXTERNAL"));
  expect(provider.events.some((event) => event.reason === "watch" && event.path === "a.ts")).toBe(true);
  expect(gate.diagnostics.stale).toBe(true);
});

test("真实fs.watch：自动watch对账只暂存，仍须完整post-write核验", async () => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["write", "result"], request);
  await gate.withMutation("write", known("a.ts", "C"), async () => {
    await provider.writeObserved("a.ts", "C");
    const watchSequence = provider.base.sequence;
    const snapshot = await provider.reconcile("watch");
    expect(snapshot.observedSequence).toBe(watchSequence + 1);
    expect(provider.events.at(-1)).toMatchObject({ reason: "reconciled_change", source: "watch", observedSequence: watchSequence + 1 });
    expect(() => gate.sealResult("result")).toThrowError(error("busy"));
  });
  await gate.assertDelivery(await gate.sealResult("result"));
});

test.each(["self-reported-range", "foreign-id", "wrong-hash"])("真实watch后对账%s不能用最终清单或自报证明补造通知", async (kind) => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  if (kind === "wrong-hash") provider.reconcileHashOverride = baselineHash("unrelated-baseline");
  else {
    const capture = provider.captureFresh.bind(provider);
    provider.captureFresh = async (signal) => {
      const captured = await capture(signal);
      if (captured.kind !== "fresh") return captured;
      const fromSequence = captured.snapshot.observedSequence;
      // 适配器自己的 assert 也会认可这个伪造序号；缺口必须由 gate 独立拒绝。
      provider.base.sequence++;
      return { ...captured, snapshot: { ...captured.snapshot, observedSequence: provider.base.sequence },
        reconciliation: { id: kind, fromSequence, toSequence: fromSequence + 1 } };
    };
  }
  await gate.withMutation("write", known("a.ts", "C"), async () => provider.writeObserved("a.ts", "C"));
  expect(provider.events.some((event) => event.reason === "watch")).toBe(true);
  expect(provider.events.some((event) => event.reason === "reconciled_change")).toBe(true);
  expect(gate.diagnostics.stale).toBe(true);
  expect(provider.base.assertions).toBe(1); // 仅操作前校验；gate 未让伪造快照进入操作后 assert。
});

test("真实fs.watch：Shell没有目标事件例外，原字节恢复仍拒绝", async () => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["shell"], request);
  expect(await gate.withMutation("shell", { paths: ["a.ts"] }, async () => {
    await provider.writeObserved("a.ts", "temporary");
    await provider.writeObserved("a.ts", "A");
    return { exitCode: 3 };
  })).toEqual({ exitCode: 3 });
  expect(gate.diagnostics.stale).toBe(true);
});

test("真实fs.watch：登记不变目标的A→B→A不能冒充合法写入", async () => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  await gate.withMutation("write", known("a.ts", "A"), async () => {
    await provider.writeObserved("a.ts", "temporary");
    expect(gate.diagnostics.stale).toBe(true);
    await provider.writeObserved("a.ts", "A");
  });
  expect(gate.diagnostics.stale).toBe(true);
});

test.each(["watch", "read_before"] as const)("HOST通知计数：目标watch N+1→%s汇总 N+2，每条收到后才推进", async (source) => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["write", "result"], request);
  const oldSeal = await gate.sealResult("result");
  const n = request.origin!.observedSequence;
  await gate.withMutation("write", known("a.ts", "C"), async () => {
    await provider.write("a.ts", "C");
    const snapshot = await provider.snapshot();
    const identity = { repoId: snapshot.repoId, workspaceId: snapshot.workspaceId, authorityEpoch: snapshot.authorityEpoch, archiveMetadataOnly: false };
    provider.sequence++;
    for (const listener of provider.listeners) listener({ ...identity, reason: "watch", source: "watch", path: "a.ts", eventType: "change",
      requiresFullReconcile: false, observedSequence: provider.sequence });
    expect(provider.sequence).toBe(n + 1);
    expect(gate.diagnostics.stale).toBe(false);
    provider.sequence++;
    for (const listener of provider.listeners) listener({ ...identity, reason: "reconciled_change", source, path: null, eventType: null,
      requiresFullReconcile: true, observedSequence: provider.sequence, baselineHash: snapshot.baselineHash });
    expect(provider.sequence).toBe(n + 2);
    expect(gate.diagnostics.stale).toBe(false);
    expect(() => gate.sealResult("result")).toThrowError(error("busy"));
  });
  const seal = await gate.sealResult("result");
  expect(seal.metadata.executionHead.observedSequence).toBe(n + 2);
  expect(seal.metadata.origin).toBe(request.origin);
  expect(oldSeal.metadata.executionHead).toBe(request.origin);
  expect(() => gate.assertDelivery(oldSeal)).toThrowError(error("invalid_seal"));
  await gate.assertDelivery(seal);
});

test("真实fs.watch：无通知的ensureFresh/capture/assert查询不增加观察序号", async () => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["result"], request);
  const events = provider.events.length;
  const checks = provider.freshnessChecks;
  for (let i = 0; i < 3; i++) {
    const current = await provider.captureFresh();
    expect(current.kind === "fresh" && current.snapshot.observedSequence).toBe(request.origin!.observedSequence);
    await gate.validateRequest(request);
  }
  await gate.assertDelivery(await gate.sealResult("result"));
  expect(provider.freshnessChecks).toBeGreaterThan(checks);
  expect(provider.events).toHaveLength(events);
  expect(provider.base.sequence).toBe(request.origin!.observedSequence);
});

test.each(["watch", "read_before"] as const)("没有合法目标watch时%s汇总不构成写入授权", async (source) => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  await gate.withMutation("write", known("a.ts", "C"), async () => {
    await provider.write("a.ts", "C");
    const snapshot = await provider.snapshot();
    for (const listener of provider.listeners) listener({ reason: "reconciled_change", source,
      repoId: snapshot.repoId, workspaceId: snapshot.workspaceId, authorityEpoch: snapshot.authorityEpoch,
      path: null, eventType: null, archiveMetadataOnly: false, requiresFullReconcile: true,
      observedSequence: ++provider.sequence, baselineHash: snapshot.baselineHash });
    expect(gate.diagnostics.stale).toBe(true);
  });
});

test.each(["gap", "same-sequence", "old-sequence", "unknown-source"])("真实watch后汇总%s即刻撤权，不接受自报关联信息", async (kind) => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  await gate.withMutation("write", known("a.ts", "C"), async () => {
    await provider.writeObserved("a.ts", "C");
    const sequence = provider.base.sequence;
    const event = { reason: "reconciled_change", source: kind === "unknown-source" ? "manual" : "read_before",
      repoId: "repo", workspaceId: "workspace", authorityEpoch: provider.base.authority,
      path: null, eventType: null, archiveMetadataOnly: false, requiresFullReconcile: true,
      observedSequence: sequence + (kind === "gap" ? 2 : kind === "old-sequence" ? -1 : kind === "same-sequence" ? 0 : 1),
      baselineHash: (await provider.base.snapshot()).baselineHash,
      reconciliationId: "self-reported", reconciliation: { id: "self-reported", fromSequence: sequence, toSequence: sequence + 2 } };
    provider.emit(event);
    expect(gate.diagnostics.stale).toBe(true);
  });
});

test("真实watch汇总暂存后外部路径事件仍即刻撤权，恢复字节无效", async () => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  await gate.withMutation("write", known("a.ts", "C"), async () => {
    await provider.writeObserved("a.ts", "C");
    await provider.reconcile("watch");
    expect(gate.diagnostics.stale).toBe(false);
    await provider.writeObserved("b.ts", "EXTERNAL");
    expect(gate.diagnostics.stale).toBe(true);
    await provider.writeObserved("b.ts", "B");
  });
  expect(gate.diagnostics.stale).toBe(true);
});

test("真实递归fs.watch：受控mkdir与精确新文件同窗口，目录不进入文件manifest", async () => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["write", "result"], request);
  await expect(lstat(join(provider.root, "new"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(join(provider.root, "new/deep"))).rejects.toMatchObject({ code: "ENOENT" });
  await gate.withMutation("write", { ...known("new/deep/file.ts", "NEW"), expectedDirectories: ["new", "new/deep"] }, async () => {
    await mkdir(join(provider.root, "new/deep"), { recursive: true });
    await provider.writeObserved("new/deep/file.ts", "NEW");
    expect(gate.diagnostics.stale).toBe(false);
  });
  expect(provider.events.some((event) => event.reason === "watch" && event.path === "new" && event.eventType === "rename")).toBe(true);
  const seal = await gate.sealResult("result");
  expect(seal.metadata.origin).toBe(request.origin);
  expect(seal.metadata.executionHead.files.map((file) => file.path)).toEqual(["a.ts", "b.ts", "new/deep/file.ts"]);
  expect(seal.metadata.executionHead.files.find((file) => file.path === "new/deep/file.ts")!.hash).toBe(baselineHash("NEW"));
  await gate.assertDelivery(seal);
});

test.each(["outside", "equal-target", "non-ancestor", "duplicate", "prod", "unchanged-leaf", "delete-leaf", "file-parent", "shell"])("目录声明%s不合法时operation不能运行", async (kind) => {
  const { gate, provider } = await world(undefined, true);
  await mkdir(join(provider.root, "dir"));
  await provider.write("dir/file.ts", "ORIGINAL");
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  let ran = false;
  const target = kind === "file-parent" ? "a.ts/file.ts" : "dir/file.ts";
  const directories = kind === "outside" ? ["../dir"] : kind === "equal-target" ? [target] : kind === "non-ancestor" ? ["other"]
    : kind === "duplicate" ? ["dir", "dir"] : kind === "prod" ? ["docs/prod"] : kind === "file-parent" ? ["a.ts"] : ["dir"];
  const mutation = { paths: [target], expectedDirectories: directories, ...(kind === "shell" ? {} : {
    expectedWrites: [{ path: target, hash: kind === "delete-leaf" ? null : baselineHash(kind === "unchanged-leaf" ? "ORIGINAL" : "NEW") }],
  }) };
  expect(() => gate.withMutation("write", mutation, async () => { ran = true; })).toThrowError(error("invalid_input"));
  expect(ran).toBe(false);
  expect(await readFile(join(provider.root, "dir/file.ts"), "utf8")).toBe("ORIGINAL");
});

test.each(["directory-change", "undeclared-directory", "outside-leaf", "overflow"])("真实新目录写入混入%s仍立即撤权", async (kind) => {
  const { gate, provider } = await watchedWorld();
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  await gate.withMutation("write", { ...known("new/file.ts", "NEW"), expectedDirectories: ["new"] }, async () => {
    await mkdir(join(provider.root, "new"));
    await provider.writeObserved("new/file.ts", "NEW");
    expect(gate.diagnostics.stale).toBe(false);
    if (kind === "directory-change") provider.inject("watch", { source: "watch", path: "new", eventType: "change", requiresFullReconcile: false });
    else if (kind === "undeclared-directory") {
      await mkdir(join(provider.root, "other"));
      await provider.writeObserved("other/file.ts", "EXTERNAL");
    } else if (kind === "outside-leaf") await provider.writeObserved("new/other.ts", "EXTERNAL");
    else provider.inject("overflow");
    expect(gate.diagnostics.stale).toBe(true);
  });
  expect(gate.diagnostics.stale).toBe(true);
});

test("目录例外不掩盖完整manifest差异，未通知的额外新文件仍拒绝", async () => {
  const { gate, provider } = await world(undefined, true);
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  await gate.withMutation("write", { ...known("new/file.ts", "NEW"), expectedDirectories: ["new"] }, async () => {
    await mkdir(join(provider.root, "new"));
    await provider.write("new/file.ts", "NEW");
    await provider.write("new/unplanned.ts", "EXTERNAL");
  });
  expect(gate.diagnostics.stale).toBe(true);
});

test("capture失败先撤销旧请求、工具和seal，异常不泄露底层正文", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["one"], request);
  const seal = await gate.sealResult("one");
  provider.captureFailure = true;
  const next = gate.beginRequest();
  expect(() => gate.withMutation("one", known("a.ts", "C"), async () => 1)).toThrowError(error("stale"));
  expect(() => gate.assertDelivery(seal)).toThrowError(error("invalid_seal"));
  await expect(next).rejects.toEqual(new ProjectBaselineError("unavailable"));
  expect(gate.diagnostics.stale).toBe(true);
});

test("旧capture迟到不覆盖新request，旧失败也不撤销新许可", async () => {
  const { gate, provider } = await world();
  const first = deferred<ProjectBaselineCapture>();
  provider.captureHook = async () => first.promise;
  const old = gate.beginRequest();
  const oldRejected = expect(old).rejects.toMatchObject({ code: "stale" });
  provider.captureHook = undefined;
  const current = await gate.beginRequest();
  first.resolve({ kind: "fresh", snapshot: await provider.snapshot() });
  await oldRejected;
  await gate.validateRequest(current);
  expect(provider.signals[0].aborted).toBe(true);
  const failed = deferred<ProjectBaselineCapture>();
  provider.captureHook = async () => failed.promise;
  const pending = gate.beginRequest();
  const pendingRejected = expect(pending).rejects.toMatchObject({ code: "unavailable" });
  provider.captureHook = undefined;
  const final = await gate.beginRequest();
  failed.reject(new Error("offline"));
  await pendingRejected;
  await gate.validateRequest(final);
});

test("capture中发生通知，即使返回相同字节也不重新放行", async () => {
  const { gate, provider } = await world();
  const capture = deferred<ProjectBaselineCapture>();
  provider.captureHook = async () => capture.promise;
  const pending = gate.beginRequest();
  const rejected = expect(pending).rejects.toMatchObject({ code: "stale" });
  provider.notify();
  capture.resolve({ kind: "fresh", snapshot: await provider.snapshot() });
  await rejected;
  expect(gate.diagnostics.stale).toBe(true);
});

test("从未管理允许legacy，不扫描后续操作；managed后unmanaged永久拒绝", async () => {
  const { gate, provider } = await world();
  provider.unmanaged = true;
  const legacy = await gate.beginRequest();
  expect(legacy.kind).toBe("unmanaged");
  gate.bindCalls(["legacy"], legacy);
  await gate.withMutation("legacy", { paths: [] }, async () => "legacy-result");
  await gate.validateRequest(legacy);
  expect(provider.assertions).toBe(0);
  expect(provider.captures).toBe(4); // 请求开始、写入前后、请求核验均确认仍未管理；不扫描正文。
  await expect(gate.sealResult("legacy")).rejects.toMatchObject({ code: "unmanaged" });
  provider.unmanaged = false;
  await gate.beginRequest();
  provider.unmanaged = true;
  await expect(gate.beginRequest()).rejects.toMatchObject({ code: "unavailable" });
  await expect(gate.beginRequest()).rejects.toMatchObject({ code: "unavailable" });
});

test.each(["managed", "unknown"])("unmanaged旧请求实际写入前发现%s即撤销，不升级origin", async (kind) => {
  const { gate, provider } = await world();
  provider.unmanaged = true;
  const request = await gate.beginRequest();
  gate.bindCalls(["late-write"], request);
  if (kind === "managed") provider.unmanaged = false;
  else provider.captureFailure = true;
  let ran = false;
  await expect(gate.withMutation("late-write", { paths: ["a.ts"] }, async () => { ran = true; })).rejects.toMatchObject({ code: "stale" });
  expect(ran).toBe(false);
  expect(request.origin).toBeNull();
  expect(request.kind).toBe("unmanaged");
  expect(gate.diagnostics.stale).toBe(true);
});

test("预检后无通知外部变化在实际执行边界拒绝，不运行operation", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  await gate.validateRequest(request);
  await provider.write("b.ts", "external");
  let ran = false;
  await expect(gate.withMutation("write", known("a.ts", "C"), async () => { ran = true; })).rejects.toMatchObject({ code: "stale" });
  expect(ran).toBe(false);
  expect(await readFile(join(provider.root, "a.ts"), "utf8")).toBe("A");
});

test("同请求同批已知写入串行，精确字节核对推进executionHead且origin不变", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  const origin = request.origin!;
  gate.bindCalls(["first", "second", "result"], request);
  const started = deferred<void>();
  const finish = deferred<void>();
  const order: string[] = [];
  const first = gate.withMutation("first", known("a.ts", "C"), async () => {
    order.push("first"); started.resolve(); await finish.promise;
    await provider.write("a.ts", "C"); provider.generation++;
    return 10;
  });
  await started.promise;
  const second = gate.withMutation("second", known("a.ts", "D"), async () => {
    order.push("second"); await provider.write("a.ts", "D"); provider.generation++; return 20;
  });
  expect(() => gate.sealResult("result")).toThrowError(error("busy"));
  expect(order).toEqual(["first"]);
  finish.resolve();
  expect(await Promise.all([first, second])).toEqual([10, 20]);
  const seal = await gate.sealResult("result");
  expect(seal.metadata.origin).toBe(origin);
  expect(seal.metadata.origin.files.find((file) => file.path === "a.ts")!.hash).toBe(baselineHash("A"));
  expect(seal.metadata.executionHead.files.find((file) => file.path === "a.ts")!.hash).toBe(baselineHash("D"));
  expect(seal.metadata.executionHead.generation).toBe(3);
  await expect(gate.assertDelivery(seal)).resolves.toBe(seal.metadata);
  expect(gate.diagnostics.pending).toBe(0);
});

test.each(["other-file", "same-target", "new-file", "authority", "branch"])("明确目标写入混入未知变化%s，只保留实际结果，不签发seal", async (kind) => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["write", "result"], request);
  const result = await gate.withMutation("write", known("a.ts", "C"), async () => {
    await provider.write("a.ts", kind === "same-target" ? "UNKNOWN" : "C");
    if (kind === "other-file") await provider.write("b.ts", "UNKNOWN");
    if (kind === "new-file") await provider.write("new.ts", "UNKNOWN");
    if (kind === "authority") provider.authority = "connection-2";
    if (kind === "branch") provider.branch = "refs/heads/other";
    return { exitCode: 0, actual: "done" };
  });
  expect(result).toEqual({ exitCode: 0, actual: "done" });
  expect(gate.diagnostics.stale).toBe(true);
  expect(() => gate.sealResult("result")).toThrowError(error("stale"));
});

test("删除/新增目标须符合准确hash清单，不能仅按授权路径放行", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["change", "result"], request);
  await gate.withMutation("change", { paths: ["a.ts", "new.ts"], expectedWrites: [
    { path: "a.ts", hash: null }, { path: "new.ts", hash: baselineHash("NEW") },
  ] }, async () => { await provider.remove("a.ts"); await provider.write("new.ts", "NEW"); });
  const seal = await gate.sealResult("result");
  expect(seal.metadata.executionHead.files.map((file) => file.path)).toEqual(["b.ts", "new.ts"]);
  await gate.assertDelivery(seal);
});

test("已知写入期间通知立即撤权，内容恢复或新通知均不能恢复旧许可", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["write", "later"], request);
  const result = await gate.withMutation("write", known("a.ts", "C"), async () => {
    provider.notify(); await provider.write("a.ts", "C"); return "written";
  });
  expect(result).toBe("written");
  await provider.write("a.ts", "A");
  provider.notify("reconnected");
  expect(() => gate.validateRequest(request)).toThrowError(error("stale"));
  expect(() => gate.withMutation("later", known("b.ts", "X"), async () => 1)).toThrowError(error("stale"));
});

test("Shell spawn前核验，输入改变后失效后续许可且保留真实退出结果", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["shell", "later"], request);
  const returned = await gate.withMutation("shell", { paths: [] }, async () => {
    await provider.write("a.ts", "generated"); return { exitCode: 7, stdout: "actual output" };
  });
  expect(returned).toEqual({ exitCode: 7, stdout: "actual output" });
  expect(gate.diagnostics.stale).toBe(true);
  expect(() => gate.sealResult("later")).toThrowError(error("stale"));
  const next = await gate.beginRequest();
  expect(next.origin!.files[0].hash).toBe(baselineHash("generated"));
});

test("Shell未改输入保留许可；操作异常保留原异常并撤权", async () => {
  const { gate } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["shell", "throws", "result"], request);
  expect(await gate.withMutation("shell", { paths: [] }, async () => ({ exitCode: 0 }))).toEqual({ exitCode: 0 });
  await gate.assertDelivery(await gate.sealResult("result"));
  const actual = new Error("operation actual failure");
  await expect(gate.withMutation("throws", { paths: [] }, async () => { throw actual; })).rejects.toBe(actual);
  expect(gate.diagnostics.stale).toBe(true);
});

test("晚到旧调用和旧seal永不绑定新request，相同toolCallId不复用", async () => {
  const { gate } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["old"], request);
  const started = deferred<void>();
  const finish = deferred<void>();
  const mutation = gate.withMutation("old", { paths: [] }, async () => { started.resolve(); await finish.promise; return "late"; });
  await started.promise;
  const next = await gate.beginRequest();
  gate.bindCalls(["next"], next);
  expect(() => gate.sealResult("old")).toThrowError(error("stale"));
  expect(() => gate.sealResult("next")).toThrowError(error("busy"));
  expect(() => gate.bindCalls(["late-assistant"], request)).toThrowError(error("stale"));
  expect(() => gate.bindCalls(["old"], next)).toThrowError(error("invalid_input"));
  finish.resolve();
  expect(await mutation).toBe("late");
  await gate.validateRequest(next);
  await gate.assertDelivery(await gate.sealResult("next"));
});

test("seal异步核对期间新request不能令旧结果换绑；伪造JSON/跨gate拒绝", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["result"], request);
  const seal = await gate.sealResult("result");
  expect(() => gate.assertDelivery({ ...seal })).toThrowError(error("invalid_seal"));
  expect(() => gate.assertDelivery(JSON.parse(JSON.stringify(seal)) as ProjectBaselineSeal)).toThrowError(error("invalid_seal"));
  const other = new RequestBaselineGate(provider);
  gates.push(other);
  expect(() => other.assertDelivery(seal)).toThrowError(error("invalid_seal"));
  const entered = deferred<void>();
  const finish = deferred<void>();
  provider.assertHook = async () => { entered.resolve(); await finish.promise; };
  const pending = gate.sealResult("result");
  const rejected = expect(pending).rejects.toMatchObject({ code: "stale" });
  await entered.promise;
  await gate.beginRequest();
  finish.resolve();
  await rejected;
});

test("seal签发后当前字节变化在交付前复核，不能靠capture换绑", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["result"], request);
  const seal = await gate.sealResult("result");
  const captures = provider.captures;
  await provider.write("a.ts", "changed after result");
  await expect(gate.assertDelivery(seal)).rejects.toMatchObject({ code: "stale" });
  expect(provider.captures).toBe(captures);
  expect(seal.metadata.origin).toBe(request.origin);
});

test("后续合法写入不能让先前seal自动绑定新executionHead", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["result", "write"], request);
  const old = await gate.sealResult("result");
  await gate.withMutation("write", known("a.ts", "C"), async () => provider.write("a.ts", "C"));
  expect(() => gate.assertDelivery(old)).toThrowError(error("invalid_seal"));
  expect(old.metadata.executionHead).toBe(request.origin);
});

test("dispose取消订阅和在途capture，晚到任务拒绝且资源归零", async () => {
  const { gate, provider } = await world();
  const capture = deferred<ProjectBaselineCapture>();
  provider.captureHook = async () => capture.promise;
  const pending = gate.beginRequest();
  const rejected = expect(pending).rejects.toMatchObject({ code: "stale" });
  gate.dispose(); gate.close();
  expect(provider.listeners.size).toBe(0);
  expect(provider.signals[0].aborted).toBe(true);
  capture.resolve({ kind: "fresh", snapshot: await provider.snapshot() });
  await rejected;
  await expect(gate.beginRequest()).rejects.toMatchObject({ code: "stale" });
  expect(gate.diagnostics).toMatchObject({ closed: true, requests: 0, calls: 0, seenCalls: 0, seals: 0, pending: 0 });
});

test("资源上限：慢capture/排队操作有界；ID和seal不淘汰复用", async () => {
  const { gate, provider } = await world({ maxPending: 2, maxCalls: 2, maxSeals: 1 });
  const capture = deferred<ProjectBaselineCapture>();
  provider.captureHook = async () => capture.promise;
  const p1 = gate.beginRequest();
  const p2 = gate.beginRequest();
  const r1 = expect(p1).rejects.toMatchObject({ code: "stale" });
  const r2 = expect(p2).rejects.toMatchObject({ code: "stale" });
  await expect(gate.beginRequest()).rejects.toMatchObject({ code: "resource_limit" });
  expect(gate.diagnostics.pending).toBe(2);
  capture.resolve({ kind: "fresh", snapshot: await provider.snapshot() });
  await Promise.all([r1, r2]);
  provider.captureHook = undefined;
  const request = await gate.beginRequest();
  gate.bindCalls(["one", "two"], request);
  expect(() => gate.bindCalls(["three"], request)).toThrowError(error("resource_limit"));
  await gate.sealResult("one");
  await expect(gate.sealResult("two")).rejects.toMatchObject({ code: "resource_limit" });
  const next = await gate.beginRequest();
  expect(() => gate.bindCalls(["three"], next)).toThrowError(error("resource_limit"));
  expect(gate.diagnostics).toMatchObject({ requests: 1, calls: 0, seenCalls: 2, seals: 0, issuedSeals: 1, pending: 0 });
});

test("已观察但通知未送达的A→B→A代次不能靠已知写入推进抹除", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  await gate.withMutation("write", known("a.ts", "C"), async () => {
    await provider.write("b.ts", "temporary");
    provider.sequence++;
    await provider.write("b.ts", "B");
    await provider.write("a.ts", "C");
  });
  expect(gate.diagnostics.stale).toBe(true);
});

test("旧managed capture晚到会撤销尚未管理的当前legacy许可", async () => {
  const { gate, provider } = await world();
  const capture = deferred<ProjectBaselineCapture>();
  provider.captureHook = async () => capture.promise;
  const pending = gate.beginRequest();
  const rejected = expect(pending).rejects.toMatchObject({ code: "stale" });
  provider.captureHook = undefined;
  provider.unmanaged = true;
  const legacy = await gate.beginRequest();
  gate.bindCalls(["legacy"], legacy);
  capture.resolve({ kind: "fresh", snapshot: await provider.snapshot() });
  await rejected;
  expect(() => gate.withMutation("legacy", { paths: [] }, async () => 1)).toThrowError(error("stale"));
  await expect(gate.beginRequest()).rejects.toMatchObject({ code: "unavailable" });
});

test("同toolCallId写操作只执行一次；晚到post-write capture不能覆盖新request", async () => {
  const { gate, provider } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["write"], request);
  const entered = deferred<void>();
  const capture = deferred<ProjectBaselineCapture>();
  provider.captureHook = async () => { entered.resolve(); return capture.promise; };
  const pending = gate.withMutation("write", known("a.ts", "C"), async () => { await provider.write("a.ts", "C"); return "written"; });
  await entered.promise;
  expect(() => gate.withMutation("write", known("a.ts", "D"), async () => 1)).toThrowError(error("stale"));
  provider.captureHook = undefined;
  const next = await gate.beginRequest();
  gate.bindCalls(["result"], next);
  capture.resolve({ kind: "fresh", snapshot: await provider.snapshot() });
  expect(await pending).toBe("written");
  const seal = await gate.sealResult("result");
  expect(seal.metadata.origin).toBe(next.origin);
  expect(seal.metadata.executionHead).toBe(next.origin);
});

test("在途写入dispose收到取消信号，真实结果保留但任何seal和排队写入拒绝", async () => {
  const { gate } = await world();
  const request = await gate.beginRequest();
  gate.bindCalls(["one", "two"], request);
  const entered = deferred<AbortSignal>();
  const finish = deferred<void>();
  const active = gate.withMutation("one", { paths: [] }, async (signal) => { entered.resolve(signal); await finish.promise; return "actual"; });
  const signal = await entered.promise;
  let ran = false;
  const queued = gate.withMutation("two", { paths: [] }, async () => { ran = true; });
  const rejected = expect(queued).rejects.toMatchObject({ code: "stale" });
  gate.dispose();
  expect(signal.aborted).toBe(true);
  finish.resolve();
  expect(await active).toBe("actual");
  await rejected;
  expect(ran).toBe(false);
  expect(gate.diagnostics).toMatchObject({ pending: 0, mutations: 0, seals: 0 });
});

test("排队操作达到上限不积累额外队列，拒绝项准确释放写入计数", async () => {
  const { gate, provider } = await world({ maxPending: 1 });
  const request = await gate.beginRequest();
  gate.bindCalls(["one", "two"], request);
  const entered = deferred<void>();
  const finish = deferred<void>();
  provider.assertHook = async () => { entered.resolve(); await finish.promise; };
  const first = gate.withMutation("one", { paths: [] }, async () => 1);
  await entered.promise;
  await expect(gate.withMutation("two", { paths: [] }, async () => 2)).rejects.toMatchObject({ code: "resource_limit" });
  expect(gate.diagnostics).toMatchObject({ pending: 1, mutations: 1 });
  finish.resolve();
  expect(await first).toBe(1);
  expect(gate.diagnostics).toMatchObject({ pending: 0, mutations: 0 });
});

test("不可变元数据、prod目录先排除及输入清单预算", async () => {
  const { gate, provider } = await world();
  await mkdir(join(provider.root, "docs/prod"), { recursive: true });
  await provider.write("docs/prod/private.md", "must-not-read");
  expect((await stat(provider.root)).mode & 0o777).toBe(0o700);
  const raw = await provider.snapshot();
  provider.captureHook = async () => ({ kind: "fresh", snapshot: raw });
  const request = await gate.beginRequest();
  (raw.files as { path: string; hash: string }[])[0].hash = baselineHash("mutated");
  expect(request.origin!.files[0].hash).toBe(baselineHash("A"));
  expect(Object.isFrozen(request.origin!.files[0])).toBe(true);
  expect(Object.isFrozen(request.origin!.coverage.roots)).toBe(true);
  expect(JSON.stringify(request.origin)).not.toContain("must-not-read");
  gate.bindCalls(["write"], request);
  expect(() => gate.withMutation("write", known("docs/prod/private.md", "x"), async () => 1)).toThrowError(error("invalid_input"));
  expect(() => gate.withMutation("write", known("../outside", "x"), async () => 1)).toThrowError(error("invalid_input"));
  const limited = new RequestBaselineGate(provider, { maxFiles: 1 });
  gates.push(limited);
  await expect(limited.beginRequest()).rejects.toMatchObject({ code: "invalid_input" });
});
