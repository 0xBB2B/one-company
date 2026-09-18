// @ts-check
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createSdkTestScene,
  sdkTestSceneFailureReceipt,
  sdkTestSceneReceipt,
} from "./helpers/pm-sdk-private-scene.mjs";
import {
  FIXTURE, TEST_NAME, PRELOAD_URL, rejection, createFailureLatch,
  createControlWriter, createControlReader, installProcessGuard, assertEnvironment,
} from "./helpers/pm-sdk-ab-owner.mjs";

const ENTRY = fileURLToPath(import.meta.url);
const PROJECT = resolve(dirname(ENTRY), "..");
const NODE = "/opt/homebrew/Cellar/node/26.8.2/bin/node";
const DARWIN_USER_TEXT_ENCODING = "0x1F5:0:0";
const CONFIG_BYTES = 'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({\n  test: {\n    include: ["tests/**/*.test.ts"],\n    environment: "node",\n    pool: "forks",\n    isolate: true,\n    fileParallelism: false,\n    testTimeout: 5_000,\n    setupFiles: ["./tests/helpers/test-environment.ts"],\n  },\n});\n';
const CONFIG_HASH = hash(Buffer.from(CONFIG_BYTES));
const UNNAMED_PROJECT_CACHE_HASH = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
// Strong retention is deliberate: no resource or directory deletion API exists.
const scenes = new Set();
const runReceipts = new WeakMap();
const ownerRunReceipts = new WeakMap();
/**
 * @typedef {"guard-install" | "environment" | "fixture-check" | "scene-allocation" |
 *   "scene-receipt" | "scene-verification" | "child-launch" | "child-observation" |
 *   "handshake" | "child-wait" | "post-run-verification" | "candidate-record" |
 *   "candidate-output" | "complete"} OwnerRunPhase
 */
/** @typedef {Readonly<{scene: object | null}>} OwnerRunResult */
/** @typedef {ReturnType<typeof createControlReader>} ControlReader */
/** @typedef {{
 *   stdoutBytes: number,
 *   stderrBytes: number,
 *   totalBytes: number,
 *   nonBufferObserved: boolean,
 *   budgetExceeded: boolean,
 * }} OutputObservation */
/**
 * @typedef {Readonly<{
 *   status: "preserved",
 *   phase: string,
 *   allocationAttempted: boolean,
 *   projectRoot: string | null,
 *   root: string | null,
 *   rootIdentity: string | null,
 * }>} AllocationFailure
 */
/** @param {Uint8Array} bytes */
function hash(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

/** @param {readonly string[]} args */
export function authorized(args) {
  return args.length === 2 && args[0] === "--authorize=M4-PM-SDK-AB-OWNER" && args[1] === "--case=vitest-fork";
}

/** Only original Scene01 handles resolve; a copied receipt does not. @param {unknown} handle */
export function ownerReceipt(handle) {
  if (typeof handle !== "object" || handle === null || !scenes.has(handle)) return undefined;
  const scene = sdkTestSceneReceipt(handle);
  const run = runReceipts.get(handle);
  return scene && run ? Object.freeze({
    root: scene.root, preserved: true, ...run.facts,
    executionCandidate: run.facts.executionCandidate === true && !run.latch.snapshot().failed,
  }) : undefined;
}

/** @param {AllocationFailure | undefined} receipt */
function allocationFailureSnapshot(receipt) {
  return receipt === undefined ? undefined : Object.freeze({
    status: receipt.status,
    phase: receipt.phase,
    allocationAttempted: receipt.allocationAttempted,
    projectRoot: receipt.projectRoot,
    root: receipt.root,
    rootIdentity: receipt.rootIdentity,
  });
}

/** @param {any} observer */
function aObservationSnapshot(observer) {
  if (!observer) return null;
  const value = observer.snapshot();
  return Object.freeze({
    source: "O-original-A", exit: value.exit, close: value.close,
    disconnected: value.disconnected, streamsCaptured: value.streamsCaptured,
    ended: value.ended, exitCode: value.exitCode, signal: value.signal,
  });
}

/** @param {ControlReader | undefined} reader */
function controlObservationSnapshot(reader) {
  if (!reader) return null;
  const value = reader.snapshot();
  return Object.freeze({
    sequence: value.sequence, acceptedFrames: value.acceptedFrames,
    successPhase: value.successPhase, bytes: value.bytes,
    residualBytes: value.residualBytes, endObserved: value.endObserved,
    eof: value.eof, complete: value.complete,
  });
}

/** @param {OutputObservation | undefined} output */
function outputObservationSnapshot(output) {
  return output === undefined ? null : Object.freeze({
    stdoutBytes: output.stdoutBytes, stderrBytes: output.stderrBytes,
    totalBytes: output.totalBytes, nonBufferObserved: output.nonBufferObserved,
    budgetExceeded: output.budgetExceeded,
  });
}

/**
 * Queries only the original result identity. The phase is the last entry stage
 * reached; it is not a claim about the location of a later asynchronous error.
 * @param {unknown} originalResult
 */
export function ownerRunReceipt(originalResult) {
  if ((typeof originalResult !== "object" || originalResult === null) && typeof originalResult !== "function") return undefined;
  const run = ownerRunReceipts.get(originalResult);
  if (!run) return undefined;
  const failure = run.latch.snapshot();
  const control = run.reader?.snapshot();
  return Object.freeze({
    owner: ownerReceipt(run.scene),
    failure: Object.freeze({ failed: failure.failed, code: failure.code, phase: run.phase }),
    allocationFailure: allocationFailureSnapshot(run.allocationFailure),
    observations: Object.freeze({
      a: aObservationSnapshot(run.observer),
      waitResult: run.waitResult(),
      control: controlObservationSnapshot(run.reader),
      output: outputObservationSnapshot(run.output),
      aFailureReported: control?.aFailureReported ?? null,
    }),
  });
}

/** @typedef {{root: string, parentBinding: string, configHash: string, vitestTarget: string}} Coordinates */
/** @param {Coordinates} c */
function paths(c) {
  return Object.freeze({
    projectRoot: PROJECT, root: c.root, configPath: join(c.root, "vitest.config.ts"),
    cacheDir: join(c.root, "cache"), homeDir: join(c.root, "home"),
    agentDir: join(c.root, "home/.pi/agent"), xdgConfigHome: join(c.root, "home/.config"),
    xdgCacheHome: join(c.root, "home/.cache"), tmpDir: join(c.root, "tmp"),
  });
}
/** @param {Coordinates} c @returns {Record<string,string>} */
function environment(c) {
  const p = paths(c);
  return {
    HOME: p.homeDir, PI_CODING_AGENT_DIR: p.agentDir, XDG_CONFIG_HOME: p.xdgConfigHome,
    XDG_CACHE_HOME: p.xdgCacheHome, TMPDIR: p.tmpDir,
    PI_COMPANY_TEST_PARENT_BINDING: c.parentBinding, NODE_ENV: "test", LANG: "C", LC_ALL: "C",
    __CF_USER_TEXT_ENCODING: DARWIN_USER_TEXT_ENCODING,
  };
}

/** Coordinates are validated data, never Scene ownership or deletion authority. @param {Coordinates} c */
async function verifyCoordinates(c) {
  if (process.version !== "v26.8.2" || process.execPath !== NODE || process.platform !== "darwin" ||
      process.execArgv.length !== 0 || typeof process.getuid !== "function" || process.getuid() !== 501 ||
      process.env.__CF_USER_TEXT_ENCODING !== DARWIN_USER_TEXT_ENCODING ||
      await realpath(PROJECT) !== PROJECT) throw rejection();
  const tmp = await realpath("/tmp");
  if (dirname(c.root) !== tmp || !/^pi-s-[A-Za-z0-9]+$/u.test(c.root.slice(tmp.length + 1))) throw rejection();
  const root = await lstat(c.root, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink() || await realpath(c.root) !== c.root ||
      (root.mode & 0o7777n) !== 0o700n || typeof process.getuid !== "function" || root.uid !== BigInt(process.getuid())) throw rejection();
  if (c.parentBinding !== JSON.stringify({ path: c.root, dev: String(root.dev), ino: String(root.ino) })) throw rejection();
  if (c.configHash !== CONFIG_HASH) throw rejection();
  for (const file of [join(c.root, "vitest.config.ts"), join(PROJECT, "vitest.config.ts")]) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || hash(await readFile(file)) !== CONFIG_HASH) throw rejection();
  }
  if (c.vitestTarget !== await realpath(join(PROJECT, "node_modules/vitest")) ||
      !c.vitestTarget.startsWith(join(PROJECT, "node_modules") + "/")) throw rejection();
  for (const file of [join(PROJECT, FIXTURE), ENTRY, fileURLToPath(PRELOAD_URL)]) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(file) !== file) throw rejection();
  }
}

/** @param {unknown} value @param {string} nonce @returns {Coordinates} */
function handshakeValue(value, nonce) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw rejection();
  const d = Object.getOwnPropertyDescriptors(value);
  const names = ["v", "nonce", "root", "parentBinding", "configHash", "vitestTarget"];
  if (Reflect.ownKeys(value).length !== names.length || names.some((key) => !d[key] || !("value" in d[key]))) throw rejection();
  if (d.v.value !== 1 || d.nonce.value !== nonce) throw rejection();
  for (const key of names.slice(2)) if (typeof d[key].value !== "string" || d[key].value.length > 2048) throw rejection();
  return Object.freeze({ root: d.root.value, parentBinding: d.parentBinding.value, configHash: d.configHash.value, vitestTarget: d.vitestTarget.value });
}

/** @param {string} nonce */
async function receiveHandshake(nonce) {
  if (!/^[a-f0-9]{32}$/u.test(nonce) || !fstatSync(0).isSocket() || !fstatSync(3).isSocket()) throw rejection();
  return await new Promise((resolveHandshake, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => reject(rejection()), 5000);
    process.stdin.on("data", (chunk) => {
      if (!Buffer.isBuffer(chunk) || bytes.length + chunk.length > 8192) {
        clearTimeout(timer); process.stdin.pause(); reject(rejection()); return;
      }
      bytes = Buffer.concat([bytes, chunk]);
    });
    process.stdin.once("error", () => { clearTimeout(timer); reject(rejection()); });
    process.stdin.once("end", () => {
      clearTimeout(timer);
      try { resolveHandshake(handshakeValue(JSON.parse(bytes.toString("utf8")), nonce)); }
      catch { reject(rejection()); }
    });
  });
}

/**
 * Early config checks are before loadEnv/server creation. Resolved checks are
 * a second gate. Only the fixed reviewed config and installed library plugins
 * are trusted; this is not an arbitrary-file or native-network sandbox.
 * @param {any} config @param {Coordinates} c @param {boolean} resolved
 */
export function assertSafeConfig(config, c, resolved) {
  const p = paths(c);
  const expectedCacheDir = join(p.cacheDir, "vitest", UNNAMED_PROJECT_CACHE_HASH);
  const s = config.server;
  if (config.root !== PROJECT || config.cacheDir !== expectedCacheDir || config.envDir !== false ||
      config.publicDir !== (resolved ? "" : false) || !s || s.middlewareMode !== true ||
      s.ws !== false || s.hmr !== false || s.watch !== null || s.open !== false ||
      s.preTransformRequests !== false || s.https || config.configFile !== p.configPath) throw rejection();
  if (resolved) {
    const t = config._vitest;
    if (!t || t.include?.length !== 1 || t.include[0] !== FIXTURE || t.run !== true ||
        t.watch !== false || t.maxWorkers !== 1 || t.ui !== false ||
        t.api?.middlewareMode !== true || t.coverage?.enabled !== false || t.typecheck?.enabled !== false ||
        t.pool !== "forks" || t.isolate !== true || t.fileParallelism !== false ||
        t.environment !== "node" || t.testTimeout !== 5000 || t.projects?.length) throw rejection();
  }
}

/** @typedef {"handshake" | "coordinates" | "environment" | "import" | "vitest" |
 *   "early-config" | "resolved-config" | "spec" | "business" | "b-wait" |
 *   "post-run" | "final"} AFailurePhase */

/** Internal A path: stdin and fd3 are original O-created pipes, not user role claims. @param {string} nonce */
async function runA(nonce) {
  const baseLatch = createFailureLatch();
  /** @type {AFailurePhase} */ let currentPhase = "handshake";
  /** @type {AFailurePhase | null} */ let failurePhase = null;
  const latch = Object.freeze({
    /** @param {string} diagnostic @param {unknown} [error] */
    fail(diagnostic, error) {
      if (!baseLatch.snapshot().failed) failurePhase = currentPhase;
      baseLatch.fail(diagnostic, error);
    },
    assert() { baseLatch.assert(); },
    snapshot() { return baseLatch.snapshot(); },
  });
  /** @type {Coordinates | undefined} */ let coordinates;
  /** @type {string[] | undefined} */ let expectedArgs;
  /** @type {Record<string,string> | undefined} */ let expectedEnv;
  let ready = false;
  const writer = createControlWriter(nonce, latch);
  /** @template T @param {AFailurePhase} phase @param {() => T} operation @returns {T} */
  function atPhase(phase, operation) {
    const prior = currentPhase;
    currentPhase = phase;
    try { return operation(); }
    finally { currentPhase = prior; }
  }
  const guard = installProcessGuard("A", latch, (kind) => writer.send(kind), (file, args, options) => atPhase("spec", () => {
    try {
      if (!ready || !coordinates || !expectedArgs || !expectedEnv ||
          file !== join(coordinates.vitestTarget, "dist/workers/forks.js") ||
          !Array.isArray(args) || args.length !== 0 || !options || typeof options !== "object") throw rejection();
      const d = Object.getOwnPropertyDescriptors(options);
      if (Reflect.ownKeys(options).length !== 4 || d.stdio?.value !== "pipe" || d.serialization?.value !== "advanced") throw rejection();
      const argv = d.execArgv?.value;
      if (!Array.isArray(argv) || argv.length !== expectedArgs.length || argv.some((value, index) => value !== expectedArgs?.[index])) throw rejection();
      assertEnvironment(expectedEnv, d.env?.value);
    } catch (error) {
      latch.fail("fork-contract", error);
      throw error;
    }
  }));
  // Monitoring is active throughout startVitest, including its finally.close.
  const deadline = setTimeout(() => { guard.seal(); latch.fail("vitest-timeout"); }, 30000);
  try {
    coordinates = /** @type {Coordinates} */ (await receiveHandshake(nonce));
    const c = coordinates;
    currentPhase = "coordinates";
    await verifyCoordinates(c);
    currentPhase = "environment";
    assertEnvironment(environment(c), process.env);
    const p = paths(c);
    const fixture = join(PROJECT, FIXTURE);
    const bEnv = { PI_PM_AB_ROLE: "B", PI_PM_AB_PRELOAD: PRELOAD_URL };
    /** @type {import("vitest/node").Vitest | undefined} */ let ctx;
    let runStarted = false;
    let businessPass = false;
    /** @type {import("vitest/reporters").Reporter} */
    const reporter = {
      onInit(value) { ctx = value; },
      onTestRunStart(specs) { atPhase("spec", () => {
        try {
          guard.assert();
          if (runStarted || !ctx || specs.length !== 1 || specs[0].moduleId !== fixture ||
              specs[0].project !== ctx.getRootProject() || specs[0].pool !== "forks") throw rejection();
          runStarted = true;
          const project = specs[0].project;
          const vite = project.vite.config;
          const conditions = [...new Set(vite.ssr.resolve?.conditions ?? [])]
            .filter((value) => value !== "production" && (value !== "development" || !vite.isProduction))
            .map((value) => value === "development|production" ? "development" : value);
          if (conditions.some((value) => !["node", "module", "development"].includes(value))) throw rejection();
          expectedArgs = ["--experimental-import-meta-resolve", "--require", join(c.vitestTarget, "suppress-warnings.cjs"),
            ...conditions.flatMap((value) => ["--conditions", value]), "--import", PRELOAD_URL];
          expectedEnv = { ...environment(c), TEST: "true", VITEST: "true", VITEST_MODE: "RUN", FORCE_TTY: "",
            PROD: "", DEV: "1", BASE_URL: "/", MODE: "test", ...bEnv };
          assertEnvironment({ ...environment(c), TEST: "true", VITEST: "true", PROD: "", DEV: "1", BASE_URL: "/", MODE: "test" }, process.env);
          ready = true;
        } catch (error) { latch.fail("spec-or-worker-contract", error); throw rejection(); }
      }); },
      onTestRunEnd(modules, errors, reason) { atPhase("business", () => {
        try {
          guard.assert();
          if (!runStarted || businessPass || !ctx || reason !== "passed" || errors.length !== 0 || modules.length !== 1 ||
              modules[0].moduleId !== fixture || modules[0].project !== ctx.getRootProject() || modules[0].state() !== "passed") throw rejection();
          const tests = [...modules[0].children.allTests()];
          if (tests.length !== 1 || tests[0].name !== TEST_NAME || tests[0].result().state !== "passed") throw rejection();
          businessPass = true;
          writer.send("business-pass");
        } catch (error) { latch.fail("business-result", error); throw rejection(); }
      }); },
    };
    const plugin = {
      name: "pm-sdk-ab-owner-safety", enforce: /** @type {const} */ ("post"),
      config: { order: /** @type {const} */ ("post"),
        /** @param {any} config */
        handler(config) { atPhase("early-config", () => {
          try {
            // This post-order hook must be the last config hook in the fixed set.
            const plugins = config.plugins.flat(Infinity).filter(Boolean);
            const later = plugins.slice(plugins.indexOf(plugin) + 1);
            if (!plugins.includes(plugin) || later.some((/** @type {any} */ item) => item.config)) throw rejection();
            assertSafeConfig(config, c, false);
          }
          catch (error) { latch.fail("early-config", error); throw rejection(); }
        }); } },
      configResolved: { order: /** @type {const} */ ("post"),
        /** @param {any} config */
        handler(config) { atPhase("resolved-config", () => {
          try { assertSafeConfig(config, c, true); }
          catch (error) { latch.fail("resolved-config", error); throw rejection(); }
        }); } },
    };
    currentPhase = "import";
    writer.send("ready");
    const { startVitest } = await import("vitest/node");
    currentPhase = "vitest";
    await startVitest("test", [fixture], {
      root: PROJECT, config: p.configPath, include: [FIXTURE], run: true, watch: false,
      maxWorkers: 1, ui: false, api: false, coverage: { enabled: false }, typecheck: { enabled: false },
      reporters: [reporter], execArgv: ["--import", PRELOAD_URL], env: bEnv,
    }, {
      root: PROJECT, cacheDir: p.cacheDir, envDir: false, publicDir: false,
      server: { middlewareMode: true, ws: false, hmr: false, watch: null, open: false, preTransformRequests: false },
      plugins: [plugin],
    });
    currentPhase = "b-wait";
    guard.seal();
    const original = guard.original();
    if (!original || !await original.wait() || !businessPass || ctx?.state.getUnhandledErrors().length) throw rejection();
    currentPhase = "post-run";
    guard.assert();
    if (process.exitCode !== undefined && process.exitCode !== 0) throw rejection();
    writer.send("b-ended");
    await verifyCoordinates(c);
    currentPhase = "final";
    writer.send("final");
    closeSync(3);
  } catch (error) {
    latch.fail("a-failed", error);
    if (coordinates && failurePhase) writer.sendFailureOnce(failurePhase, latch.snapshot().code);
  } finally {
    guard.seal(); clearTimeout(deadline);
    // No second ctx.close and no synthetic stop on failure.
  }
}

/** Exact public gate is checked before filesystem work or guard installation. */
export async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--internal-pm-sdk-ab-owner-A") {
    await runA(args[1]); return;
  }
  if (!authorized(args)) { process.exitCode = 64; return; }
  const latch = createFailureLatch();
  /** @type {ReturnType<typeof installProcessGuard> | undefined} */ let guard;
  /** @type {ReturnType<ReturnType<typeof installProcessGuard>["original"]> | undefined} */ let observer;
  /** @type {ControlReader | undefined} */ let reader;
  /** @type {boolean | null} */ let waitResult = null;
  /** @type {OutputObservation | undefined} */ let output;
  /** @type {object | undefined} */ let scene;
  /** @type {AllocationFailure | undefined} */ let allocationFailure;
  /** @type {OwnerRunPhase} */ let phase = "guard-install";
  /** @param {boolean} executionCandidate */
  function preserveFacts(executionCandidate) {
    if (!scene) return;
    const prior = runReceipts.get(scene)?.facts;
    runReceipts.set(scene, Object.freeze({ latch, facts: Object.freeze({
      ...prior, executionCandidate,
      ...(observer ? { aEnded: prior?.aEnded === true || observer.snapshot().ended } : {}),
      ...(reader ? { bEndedReported: prior?.bEndedReported === true || reader.snapshot().complete } : {}),
      reclaim: "not-requested",
    }) }));
  }
  try {
    guard = installProcessGuard("O", latch, () => {}, () => { throw rejection(); });
    phase = "environment";
    if (process.execPath !== NODE || process.version !== "v26.8.2" || process.execArgv.length !== 0 ||
        process.platform !== "darwin" || typeof process.getuid !== "function" || process.getuid() !== 501 ||
        process.env.__CF_USER_TEXT_ENCODING !== DARWIN_USER_TEXT_ENCODING ||
        process.env.NODE_OPTIONS !== undefined || process.env.NODE_PATH !== undefined ||
        process.env.NODE_V8_COVERAGE !== undefined) throw rejection();
    assertEnvironment({ LANG: "C", LC_ALL: "C", __CF_USER_TEXT_ENCODING: DARWIN_USER_TEXT_ENCODING }, process.env);
    // Fixture existence is checked before allocation; no default-suite fallback.
    phase = "fixture-check";
    if (!(await lstat(join(PROJECT, FIXTURE))).isFile()) throw rejection();
    phase = "scene-allocation";
    try { scene = await createSdkTestScene(); }
    catch (error) {
      allocationFailure = /** @type {AllocationFailure | undefined} */ (sdkTestSceneFailureReceipt(error));
      throw error;
    }
    scenes.add(scene);
    phase = "scene-receipt";
    const receipt = sdkTestSceneReceipt(scene);
    if (!receipt) throw rejection();
    const c = { root: receipt.root, configHash: receipt.configHash, parentBinding: receipt.parentBinding, vitestTarget: receipt.vitestTarget };
    phase = "scene-verification";
    await verifyCoordinates(c);
    const nonce = randomBytes(16).toString("hex");
    phase = "child-launch";
    const child = guard.launch(NODE, [ENTRY, "--internal-pm-sdk-ab-owner-A", nonce], {
      cwd: PROJECT, env: environment(c), detached: false, stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    guard.seal();
    phase = "child-observation";
    const original = guard.original();
    const stream = child.stdio[3];
    if (!original || original.child !== child || !stream || !child.stdin || !child.stdout || !child.stderr) throw rejection();
    observer = original;
    reader = createControlReader(child, stream, nonce, latch);
    stream.on("data", (chunk) => reader?.accept(child, stream, chunk));
    stream.on("end", () => reader?.end(child, stream));
    stream.on("error", (error) => latch.fail("control-stream", error));
    output = { stdoutBytes: 0, stderrBytes: 0, totalBytes: 0, nonBufferObserved: false, budgetExceeded: false };
    for (const [key, outputStream] of /** @type {const} */ ([["stdoutBytes", child.stdout], ["stderrBytes", child.stderr]])) {
      outputStream.on("data", (chunk) => {
        if (!output) return;
        if (!Buffer.isBuffer(chunk)) {
          output.nonBufferObserved = true;
          latch.fail("library-output-non-buffer");
          return;
        }
        const length = chunk.length;
        output[key] = output[key] > Number.MAX_SAFE_INTEGER - length ? Number.MAX_SAFE_INTEGER : output[key] + length;
        output.totalBytes = output.totalBytes > Number.MAX_SAFE_INTEGER - length ? Number.MAX_SAFE_INTEGER : output.totalBytes + length;
        if (output.totalBytes > 1048576 || output.totalBytes === Number.MAX_SAFE_INTEGER) {
          output.budgetExceeded = true;
          latch.fail("library-output-budget");
        }
      });
    }
    phase = "handshake";
    const handshake = Buffer.from(JSON.stringify({ v: 1, nonce, ...c }));
    if (handshake.length > 8192) throw rejection();
    child.stdin.end(handshake);
    phase = "child-wait";
    waitResult = await original.wait();
    const observed = original.snapshot();
    preserveFacts(false);
    phase = "post-run-verification";
    await verifyCoordinates(c);
    const candidate = waitResult === true && reader.snapshot().complete && observed.exitCode === 0 && observed.signal === null && !latch.snapshot().failed;
    guard.assert();
    if (!scene) throw rejection();
    phase = "candidate-record";
    preserveFacts(candidate);
    if (!candidate) throw rejection();
    phase = "candidate-output";
    process.stdout.write("PM_SDK_AB_EXECUTION_CANDIDATE_PRESERVED\n");
    phase = "complete";
  } catch (error) {
    latch.fail("o-failed", error);
    preserveFacts(false);
  } finally {
    try { guard?.seal(); }
    catch (error) { latch.fail("o-guard-seal", error); }
  }
  const result = /** @type {OwnerRunResult} */ (Object.freeze({ scene: scene ?? null }));
  ownerRunReceipts.set(result, Object.freeze({
    scene: scene ?? null,
    latch,
    phase,
    allocationFailure: allocationFailureSnapshot(allocationFailure),
    observer,
    reader,
    output,
    waitResult: () => waitResult,
  }));
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { process.exitCode = 1; });
}
