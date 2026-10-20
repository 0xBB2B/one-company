import { expect, test } from "vitest";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createClock } from "../../src/core/policy/clock.ts";
import { connectDaemon, DAEMON_CLIENT_LIFECYCLE_EVENTS } from "../../src/core/host/daemon-client.ts";
import { HostAuthorizationManager } from "../../src/modules/requirement/host-authorization.ts";
import { daemonSocketPath, repositoryIdentity } from "../../src/core/storage/identity.ts";
import { PM_INTAKE_NAMESPACES } from "../../src/modules/pm/pm-intake-store.ts";
import { uuidv7 } from "../../src/core/storage/database.ts";
import requirementManageExtension from "../../src/modules/interaction/requirement-manage-extension.ts";
import type { WindowContextValue } from "../../src/core/host/extension-lifecycle.ts";
import { createPmIntakeFixture } from "../helpers/pm-intake-fixture.ts";
import type { PmIntakeFixture } from "../helpers/pm-intake-fixture.ts";
import { registerControlledProvider, setReplies } from "../helpers/controlled-provider.ts";
import type { ControlledProvider, ScriptedReply } from "../helpers/controlled-provider.ts";
import { killDaemon, resolveSdkDir, spawnDaemonProcess, waitForSocketReady, startDaemonForTest } from "../helpers/daemon-harness.ts";
import { createTempHome, removeTempHome } from "../helpers/temp-home.ts";

type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];
type Daemon = Awaited<ReturnType<typeof startDaemonForTest>>;
type Client = Awaited<ReturnType<typeof connectDaemon>>;
type Home = Awaited<ReturnType<typeof createTempHome>>;
type Clock = ReturnType<typeof createClock>;

interface SdkWorld {
  fixture: PmIntakeFixture;
  session: Session;
  provider: ControlledProvider;
  authorization: HostAuthorizationManager;
  windowId: string;
  sessionManager: SessionManager;
}

function intakeResults(session: Session) {
  return session.messages.filter((message): message is Extract<typeof message, { role: "toolResult" }> => message.role === "toolResult" && message.toolName === "one_company_user_interact");
}

function visibleView(context: ControlledProvider["requests"][number]): Record<string, unknown> {
  const result = context.messages.filter((message): message is Extract<typeof message, { role: "toolResult" }> => message.role === "toolResult" && message.toolName === "one_company_user_interact").at(-1);
  if (!result) throw new Error("model_visible_tool_result_missing");
  const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  return JSON.parse(text) as Record<string, unknown>;
}

async function withSdkWorld(
  run: (world: SdkWorld) => Promise<void>,
  options: {
    extraExtension?: (pi: ExtensionAPI) => void;
    setupFaultAfter?: "fixture" | "home" | "daemon" | "before-client";
    cleanupFaultAt?: "session_shutdown";
    cleanupTrace?: string[];
    preservedCleanup?: Array<() => Promise<void>>;
  } = {},
): Promise<void> {
  let fixture: PmIntakeFixture | undefined;
  let home: Home | undefined;
  let daemon: Daemon | undefined;
  let clock: Clock | undefined;
  let client: Client | undefined;
  let authorization: HostAuthorizationManager | undefined;
  let session: Session | undefined;
  let primaryError: unknown, hasPrimaryError = false, daemonSpawnAttempted = false, connectionAttempted = false, connectionTrusted = false, closingClient = false;
  let clientCloseConfirmed = false;
  let assemblyCall: Promise<Record<string, unknown>> | undefined, assemblyCallState: "none" | "pending" | "settled" = "none";
  const connectionListeners: Array<() => void> = [];
  const lifecycleErrors: unknown[] = [];
  let lifecycleBlocked = false, cleanupRounds = 0, cleanupLifecycleConsumed = 0, lifecycleReported = 0;
  const runtimeRefreshes = new Set<Promise<unknown>>();
  const runtimeRefreshErrors: unknown[] = [];
  let unsubscribeRunnerErrors: (() => void) | undefined;
  const cleanupErrors: unknown[] = [];
  const clean = async (name: string, action: () => void | Promise<void>): Promise<boolean> => {
    options.cleanupTrace?.push(name);
    try { await action(); return true; }
    catch (error) { cleanupErrors.push(new Error(`cleanup_failed:${name}`, { cause: error })); return false; }
  };
  const cleanupWorld = async (inject: boolean): Promise<boolean> => {
    const lifecycleErrorStart = lifecycleErrors.length;
    if (cleanupRounds === 0) {
      if (lifecycleErrorStart > 0) lifecycleBlocked = true;
      cleanupLifecycleConsumed = lifecycleErrorStart;
    } else if (lifecycleErrorStart > cleanupLifecycleConsumed) {
      lifecycleBlocked = true;
      cleanupLifecycleConsumed = lifecycleErrorStart;
    }
    if (lifecycleErrorStart > lifecycleReported) {
      cleanupErrors.push(new AggregateError(lifecycleErrors.slice(lifecycleReported, lifecycleErrorStart), "sdk_lifecycle_handler_failed"));
      lifecycleReported = lifecycleErrorStart;
    }
    cleanupRounds++;
    let stopped = (!daemonSpawnAttempted || daemon !== undefined) && (!connectionAttempted || connectionTrusted) && !lifecycleBlocked;
    if (assemblyCall && assemblyCallState === "pending") stopped = false;
    const stop = async (name: string, action: () => void | Promise<void>) => { if (!await clean(name, action)) stopped = false; };
    if (session) {
      await stop("session.abort", () => session!.abort());
      await stop("session.waitForIdle", () => session!.waitForIdle());
      await stop("session_shutdown", async () => {
        await session!.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        if (inject && options.cleanupFaultAt === "session_shutdown") throw new Error("controlled_cleanup_failure:session_shutdown");
      });
      await stop("session.dispose", () => session!.dispose());
    }
    if (authorization) await stop("authorization", () => authorization!.shutdown());
    closingClient = true;
    if (!clientCloseConfirmed) {
      clientCloseConfirmed = !client || await clean("client.close", async () => { client!.close(); await client!.waitClosed(); });
    }
    if (!clientCloseConfirmed) stopped = false;
    // 关闭失败时继续观察原连接；只有确认关闭后才解除监听，失败句柄保留供恢复重试。
    if (clientCloseConfirmed) for (const unsubscribe of [...connectionListeners]) {
      if (await clean("client.unsubscribe", unsubscribe)) {
        const index = connectionListeners.indexOf(unsubscribe);
        if (index >= 0) connectionListeners.splice(index, 1);
      } else stopped = false;
    }
    if (clock) await stop("clock.stopGapWatcher", () => clock!.stopGapWatcher());
    if (daemon) await stop("daemon", async () => {
      await killDaemon(daemon!);
      await daemon!.exited;
      const pid = daemon!.proc.pid;
      if (!pid || pid <= 1) throw new Error("daemon_identity_unknown");
      try { process.kill(-pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
      throw new Error("daemon_group_not_gone");
    });
    for (;;) {
      const pending = [...runtimeRefreshes];
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    if (runtimeRefreshErrors.length) {
      stopped = false;
      cleanupErrors.push(new AggregateError([...runtimeRefreshErrors], "sdk_model_refresh_failed"));
    }
    if (lifecycleErrors.length > lifecycleErrorStart) {
      stopped = false;
      cleanupErrors.push(new AggregateError(lifecycleErrors.slice(lifecycleErrorStart), "sdk_lifecycle_handler_failed"));
      cleanupLifecycleConsumed = lifecycleErrors.length;
      lifecycleReported = lifecycleErrors.length;
    }
    if (connectionAttempted && !connectionTrusted) {
      stopped = false; cleanupErrors.push(new Error("sdk_connection_lost_during_cleanup"));
    }
    if (stopped && unsubscribeRunnerErrors) {
      if (await clean("session.error.unsubscribe", unsubscribeRunnerErrors)) unsubscribeRunnerErrors = undefined;
      else stopped = false;
    }
    if (!stopped) {
      console.error(JSON.stringify({ status: "pm_sdk_fixture_preserved", home: home?.home, fixtureRoot: fixture?.root,
        daemonPid: daemon?.proc.pid, daemonSpawnAttempted, errors: cleanupErrors.map(String) }));
      return false;
    }
    if (home) {
      if (await clean("home", () => removeTempHome(home!))) home = undefined;
      else stopped = false;
    }
    if (fixture) {
      if (await clean("fixture", () => fixture!.cleanup())) fixture = undefined;
      else stopped = false;
    }
    return stopped;
  };
  const failAfter = (point: "fixture" | "home" | "daemon" | "before-client") => {
    if (options.setupFaultAfter === point) throw new Error(`controlled_setup_failure:${point}`);
  };

  try {
    // createPmIntakeFixture若在返回句柄前内部失败，本文件无法安全识别其未知根目录或进程；不得猜路径删除。
    fixture = await createPmIntakeFixture();
    failAfter("fixture");
    home = await createTempHome();
    failAfter("home");
    const workspace = fixture.state.read(fixture.requirementId).data.workspace!;
    const identity = await repositoryIdentity(workspace.path);
    if (fixture.repoId !== identity.repoId) throw new Error("sdk_repository_identity_mismatch");
    const socketPath = daemonSocketPath(fixture.dataRoot, fixture.repoId);
    daemonSpawnAttempted = true;
    const spawned = spawnDaemonProcess({ home, repoDir: identity.commonDir, dataRoot: fixture.dataRoot });
    daemon = { ...spawned, socketPath };
    await Promise.race([waitForSocketReady(socketPath), daemon.exited.then(() => { throw new Error("daemon_exited_before_ready"); })]);
    failAfter("daemon");
    // 守护进程启动时会作废全部旧租约，PM 要在它就绪之后再取租约
    for (let waited = 0; fixture.state.pmOwner(fixture.requirementId)!.lease && waited < 30_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    await fixture.state.acquirePm({ requirementId: fixture.requirementId, version: fixture.state.read(fixture.requirementId).version, runId: uuidv7(),
      expectedFence: fixture.state.pmOwner(fixture.requirementId)!.fence });
    const sm = SessionManager.inMemory(workspace.path), windowId = uuidv7();
    clock = createClock();
    failAfter("before-client");
    connectionAttempted = true;
    client = await connectDaemon({ repoDir: workspace.path, dataRoot: fixture.dataRoot, sdkDir: resolveSdkDir(), clock,
      connectOnly: true,
      hello: { windowId, sessionId: sm.getSessionId() } });
    authorization = new HostAuthorizationManager({ dataRoot: fixture.dataRoot });
    expect(client.state().status).toBe("connected");
    const hello = await client.call("hello", {});
    const connectedIdentity = client.connectionIdentity();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    if (hello.repoId !== fixture.repoId || hello.daemonPid !== daemon.proc.pid || hello.connectionSequence !== 1
      || typeof hello.daemonInstanceId !== "string" || !uuid.test(hello.daemonInstanceId)
      || typeof hello.connectionId !== "string" || !uuid.test(hello.connectionId)
      || !connectedIdentity || typeof connectedIdentity.daemonInstanceId !== "string" || !uuid.test(connectedIdentity.daemonInstanceId)
      || typeof connectedIdentity.connectionId !== "string" || !uuid.test(connectedIdentity.connectionId)
      || connectedIdentity.connectionSequence !== 1 || connectedIdentity.daemonInstanceId !== hello.daemonInstanceId
      || connectedIdentity.connectionId !== hello.connectionId || connectedIdentity.connectionSequence !== hello.connectionSequence) {
      throw new Error("sdk_client_identity_unconfirmed");
    }
    const originalConnection = Object.freeze({ daemonInstanceId: connectedIdentity.daemonInstanceId,
      connectionId: connectedIdentity.connectionId, connectionSequence: connectedIdentity.connectionSequence });
    connectionTrusted = true;
    connectionListeners.push(client.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.disconnected, (event) => {
      const ownClose = closingClient && event.cause === "client_close" && event.willReconnect === false;
      if (!ownClose) connectionTrusted = false;
    }));
    connectionListeners.push(client.subscribe(DAEMON_CLIENT_LIFECYCLE_EVENTS.connected, () => {
      const current = client?.connectionIdentity();
      if (!current || current.daemonInstanceId !== originalConnection.daemonInstanceId
        || current.connectionId !== originalConnection.connectionId || current.connectionSequence !== originalConnection.connectionSequence) connectionTrusted = false;
    }));
    const sameTrustedConnection = () => {
      if (!connectionTrusted) return false;
      let current: ReturnType<Client["connectionIdentity"]> | undefined;
      try {
        if (client?.state().status !== "connected") {
          connectionTrusted = false;
          return false;
        }
        current = client.connectionIdentity();
      } catch (error) {
        connectionTrusted = false;
        throw error;
      }
      if (!current || current.daemonInstanceId !== originalConnection.daemonInstanceId
        || current.connectionId !== originalConnection.connectionId
        || current.connectionSequence !== originalConnection.connectionSequence) {
        connectionTrusted = false;
        return false;
      }
      return true;
    };
    if (!sameTrustedConnection()) throw new Error("sdk_daemon_assembly_connection_untrusted");
    assemblyCallState = "pending";
    assemblyCall = client.call("pm.overview", {});
    let assembly: Record<string, unknown>;
    try { assembly = await assemblyCall; }
    finally { assemblyCallState = "settled"; }
    if (!sameTrustedConnection()) throw new Error("sdk_daemon_assembly_connection_untrusted");
    if (!Array.isArray(assembly.items) || assembly.items.length !== 0) {
      throw new Error("sdk_daemon_assembly_unconfirmed");
    }
    const currentClient = client;
    const window = { windowId, sessionId: sm.getSessionId(),
      workspace: { repos: [{ repoId: fixture.repoId, path: workspace.path, commonDir: identity.commonDir }], skipped: [] },
      clients: { forRepo: (id: string) => id === fixture!.repoId ? currentClient : undefined, all: () => [currentClient], closeAll: () => currentClient.close() },
    } as unknown as WindowContextValue;
    const runtime = await ModelRuntime.create({ authPath: join(home.agentDir, "intake.auth.json"), modelsPath: null,
      modelsStorePath: join(home.agentDir, "intake.models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
    const originalRefresh = runtime.refresh.bind(runtime);
    runtime.refresh = ((refreshOptions = {}) => {
      let operation: ReturnType<typeof originalRefresh>;
      try { operation = originalRefresh({ ...refreshOptions, allowNetwork: false }); }
      catch (error) { runtimeRefreshErrors.push(error); throw error; }
      runtimeRefreshes.add(operation);
      void operation.then((result) => {
        try {
          if (result.aborted) runtimeRefreshErrors.push(new Error("sdk_model_refresh_aborted"));
          if (!(result.errors instanceof Map)) throw new Error("sdk_model_refresh_errors_invalid");
          for (const error of result.errors.values()) runtimeRefreshErrors.push(error);
        } catch (error) { runtimeRefreshErrors.push(new Error("sdk_model_refresh_observation_failed", { cause: error })); }
        runtimeRefreshes.delete(operation);
      }, (error) => {
        runtimeRefreshErrors.push(error);
        runtimeRefreshes.delete(operation);
      });
      return operation;
    }) as typeof runtime.refresh;
    const provider = registerControlledProvider(runtime, { providerId: "pm-intake-sdk", modelId: "controlled" });
    const extensions = [(pi: ExtensionAPI) => requirementManageExtension(pi, { dataRoot: fixture!.dataRoot, authorization,
      windowReady: async () => window, windowContext: () => window,
      pmIntakeProviders: { sourceDirectoryProvider: fixture!.sourceProvider, submissionProvider: fixture!.submissionProvider } })];
    if (options.extraExtension) extensions.push(options.extraExtension);
    const loader = new DefaultResourceLoader({ cwd: workspace.path, agentDir: home.agentDir,
      settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true, systemPrompt: "", appendSystemPrompt: [], extensionFactories: extensions });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd: workspace.path, agentDir: home.agentDir, sessionManager: sm,
      modelRuntime: runtime, model: runtime.getModels(provider.providerId)[0], resourceLoader: loader, noTools: "builtin",
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) }));
    unsubscribeRunnerErrors = session.extensionRunner.onError((error) => { lifecycleErrors.push(error); });
    const assertLifecycleHealthy = () => {
      if (!lifecycleErrors.length) return;
      lifecycleBlocked = true;
      throw lifecycleErrors[0];
    };
    await session.bindExtensions({ mode: "rpc", uiContext: { ...session.extensionRunner.getUIContext(), notify: () => {} } });
    assertLifecycleHealthy();
    await run({ fixture, session, provider, authorization, windowId, sessionManager: sm });
    assertLifecycleHealthy();
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    if (!await cleanupWorld(true)) {
      cleanupErrors.push(new Error("sdk_resources_unconfirmed_directories_preserved"));
      options.preservedCleanup?.push(async () => {
        const before = cleanupErrors.length;
        const stopped = await cleanupWorld(false);
        const recoveryErrors = cleanupErrors.slice(before);
        if (!stopped || recoveryErrors.length) {
          const cause = recoveryErrors.length ? new AggregateError(recoveryErrors, "sdk_recovery_cleanup_failures") : undefined;
          throw new Error("sdk_recovery_cleanup_unconfirmed", cause ? { cause } : undefined);
        }
      });
    }
  }
  if (hasPrimaryError && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], "sdk_test_and_cleanup_failed", { cause: primaryError });
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "sdk_cleanup_failed");
}

function ask(fixture: PmIntakeFixture) {
  return { purpose: "pm-intake", action: "ask", repoId: fixture.repoId,
    requirementId: fixture.requirementId } as const;
}

test.each([
  ["fixture", ["fixture"]],
  ["home", ["home", "fixture"]],
  ["daemon", ["daemon", "home", "fixture"]],
  ["before-client", ["clock.stopGapWatcher", "daemon", "home", "fixture"]],
] as const)("受控setup故障%s从首个await所在try倒序清理已登记句柄", async (point, expected) => {
  const cleanupTrace: string[] = [];
  const options = { cleanupTrace, setupFaultAfter: point };
  await expect(withSdkWorld(async () => { throw new Error("callback_must_not_run"); }, options)).rejects.toThrow(/controlled_/);
  expect(cleanupTrace).toEqual(expected);
}, 40_000);

test("session_shutdown未确认时继续停止其它资源但保全目录；恢复后重核才删除", async () => {
  const cleanupTrace: string[] = [], preservedCleanup: Array<() => Promise<void>> = [];
  try {
    await expect(withSdkWorld(async () => {}, { cleanupTrace, cleanupFaultAt: "session_shutdown", preservedCleanup })).rejects.toThrow(/sdk_cleanup_failed/);
    expect(cleanupTrace).toEqual(["session.abort", "session.waitForIdle", "session_shutdown", "session.dispose", "authorization",
      "client.close", "client.unsubscribe", "client.unsubscribe", "clock.stopGapWatcher", "daemon"]);
    expect(preservedCleanup).toHaveLength(1);
  } finally { for (const recover of preservedCleanup) await recover(); }
}, 40_000);

test("真实SDK吞掉shutdown handler异常时仍保全；handler恢复成功后才删除", async () => {
  const cleanupTrace: string[] = [], preservedCleanup: Array<() => Promise<void>> = [];
  let handlerFails = true, handlerCalls = 0;
  try {
    await expect(withSdkWorld(async () => {}, { cleanupTrace, preservedCleanup, extraExtension: (pi) => {
      pi.on("session_shutdown", () => { handlerCalls++; if (handlerFails) throw new Error("actual_handler_stop_unconfirmed"); });
    } })).rejects.toThrow(/sdk_cleanup_failed/);
    expect(handlerCalls).toBeGreaterThan(0);
    expect(cleanupTrace).not.toContain("home"); expect(cleanupTrace).not.toContain("fixture");
    expect(preservedCleanup).toHaveLength(1);
  } finally {
    handlerFails = false;
    const priorCalls = handlerCalls;
    for (const recover of preservedCleanup) await recover();
    if (preservedCleanup.length) expect(handlerCalls).toBeGreaterThan(priorCalls);
  }
}, 40_000);

test("真实SDK下一次模型请求只从tool content解析requestId并完成ask→forward→reply", async () => {
  await withSdkWorld(async ({ fixture, session, provider, windowId, sessionManager }) => {
    const beforeRequirement = fixture.state.read(fixture.requirementId);
    const beforeOwner = fixture.state.pmOwner(fixture.requirementId);
    const initialAsk = ask(fixture);
    let step = 0, modelRequestId: string | undefined;
    provider.queue.shift = (() => {
      const context = provider.requests.at(-1);
      if (step++ === 0) return { type: "toolcall", name: "one_company_user_interact", input: { request: initialAsk } } satisfies ScriptedReply;
      if (!context) throw new Error("controlled_context_missing");
      const view = visibleView(context);
      if (step === 2) {
        modelRequestId = String(view.requestId);
        expect(modelRequestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(JSON.stringify(view)).toContain("实现手机号登录");
        return { type: "toolcall", name: "one_company_user_interact", input: { request: { purpose: "pm-intake", action: "forward",
          repoId: fixture.repoId, requirementId: fixture.requirementId, requestId: modelRequestId } } } satisfies ScriptedReply;
      }
      if (step === 3) {
        expect(view.requestId).toBe(modelRequestId);
        return { type: "toolcall", name: "one_company_user_interact", input: { request: { purpose: "pm-intake", action: "reply",
          repoId: fixture.repoId, requirementId: fixture.requirementId, requestId: modelRequestId,
          result: "passed", shortIssues: [] } } } satisfies ScriptedReply;
      }
      expect((view.record as { requestId: string; result: string }).requestId).toBe(modelRequestId);
      expect((view.record as { requestId: string; result: string }).result).toBe("passed");
      return { type: "text", text: "done" } satisfies ScriptedReply;
    }) as typeof provider.queue.shift;

    await session.prompt("创建、重取并登记当前PM接手复核", { source: "rpc" });
    const results = intakeResults(session).slice(-3);
    expect(results).toHaveLength(3);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(results.map((result) => result.details)).toEqual([
      { format: "pm-intake-transport/v1", action: "ask" },
      { format: "pm-intake-transport/v1", action: "forward" },
      { format: "pm-intake-transport/v1", action: "reply" },
    ]);
    expect(results[0]!.content[0]!.type).toBe("text");
    expect((results[0]!.content[0] as { text: string }).text).toContain("实现手机号登录");
    expect(fixture.db((db) => db.list(PM_INTAKE_NAMESPACES.requests))).toHaveLength(1);
    expect(fixture.db((db) => db.list(PM_INTAKE_NAMESPACES.reviews))).toHaveLength(1);
    expect(fixture.state.read(fixture.requirementId)).toEqual(beforeRequirement);
    expect(fixture.state.pmOwner(fixture.requirementId)).toEqual(beforeOwner);
    expect(fixture.db((db) => db.list("receipts"))).toHaveLength(0);
    expect(fixture.db((db) => db.list("runs"))).toHaveLength(0);
    const review = JSON.parse((results[2]!.content[0] as { text: string }).text) as { record: { reviewer: { windowId: string; sessionId: string } } };
    expect(review.record.reviewer).toMatchObject({ windowId, sessionId: sessionManager.getSessionId() });
  });
}, 40_000);

test("真实SDK的后置block、preflight abort与execute failure各超过32次后仍回收容量并拒绝迟到旧结果", async () => {
  let phase: "block" | "abort" | "mutate" | "legal" = "block";
  const hookCounts = { block: 0, abort: 0, mutate: 0, legal: 0 };
  await withSdkWorld(async ({ fixture, session, provider }) => {
    const terminal: Array<{ toolCallId: string; phase: typeof phase; isError: boolean }> = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolName === "one_company_user_interact") {
        terminal.push({ toolCallId: event.toolCallId, phase, isError: event.isError });
      }
    });
    try {
      for (phase of ["block", "abort", "mutate"] as const) {
        let lastId = "";
        for (let index = 0; index < 33; index++) {
          const input = ask(fixture);
          setReplies(provider, [{ type: "toolcall", name: "one_company_user_interact", input: { request: input } }, { type: "text", text: "next" }]);
          await session.prompt(`${phase}-${index}`, { source: "rpc" });
          const result = intakeResults(session).at(-1)!;
          lastId = result.toolCallId;
          expect(JSON.stringify(result.content)).not.toContain("tool_call_limit");
          expect(result.isError).toBe(true);
        }
        if (phase === "block") {
          expect(hookCounts.block).toBe(0);
          const late = await session.extensionRunner.emitToolResult({ type: "tool_result", toolName: "one_company_user_interact",
            toolCallId: lastId, input: { request: ask(fixture) }, content: [{ type: "text", text: "late" }], details: {}, isError: true });
          // 出错结果由工具自己写好原因，扩展原样交出，不再改写
          expect(late).toBeUndefined();
        }
      }
      expect(terminal.filter((event) => event.phase === "block")).toHaveLength(33);
      expect(terminal.filter((event) => event.phase === "abort")).toHaveLength(33);
      expect(terminal.filter((event) => event.phase === "mutate")).toHaveLength(33);
      expect(hookCounts).toMatchObject({ block: 1, abort: 0, mutate: 33 });

      phase = "legal";
      const legal = ask(fixture);
      setReplies(provider, [{ type: "toolcall", name: "one_company_user_interact", input: { request: legal } }, { type: "text", text: "done" }]);
      await session.prompt("legal-after-terminal-recovery", { source: "rpc" });
      const result = intakeResults(session).at(-1)!;
      expect(result.isError, JSON.stringify(result.content)).toBe(false);
      expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ requestId: expect.any(String) });
    } finally { unsubscribe(); }
  }, { extraExtension: (pi) => {
    pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "one_company_user_interact" || event.input.request?.purpose !== "pm-intake") return;
      if (phase === "block") return { block: true, reason: "blocked-after-intake" };
      if (phase === "abort") { ctx.abort(); return; }
      if (phase === "mutate") event.input.request.action = "toString";
    });
    pi.on("tool_result", (event) => {
      if (event.toolName === "one_company_user_interact" && event.input.request?.purpose === "pm-intake") hookCounts[phase]++;
    });
  } });
}, 60_000);

