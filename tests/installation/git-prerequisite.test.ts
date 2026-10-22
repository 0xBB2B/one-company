import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const productRoot = fileURLToPath(new URL("../../", import.meta.url));
const labelKey = "one-company.git-prerequisite-task";

type DockerResult = ReturnType<typeof spawnSync>;
type DockerRunner = (args: string[], timeout?: number) => DockerResult;

interface DockerFixtureState {
  readonly identity: string;
  readonly context: string;
  readonly imageTags: readonly string[];
  readonly containerNames: readonly string[];
  readonly imageIds: Map<string, string>;
  readonly containerIds: Map<string, string>;
  buildStateUnknown: boolean;
  commandSequence: number;
  readonly trackingErrors: Error[];
}

function systemDocker(args: string[], timeout = 180_000) {
  return spawnSync("docker", args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
}

const dockerAvailable = systemDocker(["info", "--format", "{{.ServerVersion}}"], 10_000).status === 0;

function createState(context: string, suffix = randomUUID()) : DockerFixtureState {
  const identity = `one-company-git-prerequisite-${process.pid}-${suffix}`;
  return {
    identity,
    context,
    imageTags: [`${identity}:missing`, `${identity}:valid`],
    containerNames: [`${identity}-missing`, `${identity}-valid`],
    imageIds: new Map(),
    containerIds: new Map(),
    buildStateUnknown: false,
    commandSequence: 0,
    trackingErrors: [],
  };
}

function errorCode(result: DockerResult) {
  return result.error && "code" in result.error ? String(result.error.code) : undefined;
}

function persistCommand(state: DockerFixtureState, phase: string, args: string[], result: DockerResult) {
  state.commandSequence += 1;
  const path = join(state.context, `docker-${String(state.commandSequence).padStart(2, "0")}-${phase}.json`);
  writeFileSync(path, JSON.stringify({
    args,
    status: result.status,
    signal: result.signal,
    errorCode: errorCode(result),
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  }, null, 2), { mode: 0o600 });
}

function trackedDocker(
  state: DockerFixtureState,
  runner: DockerRunner,
  phase: string,
  args: string[],
  timeout: number,
  resource?: { kind: "build" } | { kind: "run"; name: string; cidfile: string },
) {
  const alreadyUnknown = state.buildStateUnknown;
  if (resource?.kind === "build") state.buildStateUnknown = true;
  let result: DockerResult;
  try { result = runner(args, timeout); }
  catch (error) {
    state.trackingErrors.push(new Error(`${phase} runner threw; command completion unknown`, { cause: error }));
    throw error;
  }
  if (resource?.kind === "build" && !result.error && result.status !== null && result.signal === null) state.buildStateUnknown = alreadyUnknown;
  if (resource?.kind === "run") {
    try {
      if (existsSync(resource.cidfile)) {
        const id = readFileSync(resource.cidfile, "utf8").trim();
        if (id) state.containerIds.set(resource.name, id);
      }
    } catch (error) { state.trackingErrors.push(new Error(`${phase} container ID could not be recorded`, { cause: error })); }
  }
  try { persistCommand(state, phase, args, result); }
  catch (error) { state.trackingErrors.push(new Error(`${phase} command log could not be written`, { cause: error })); }
  return result;
}

function commandError(phase: string, result: DockerResult) {
  const code = errorCode(result);
  if (code) return new Error(`${phase} failed: ${code}`);
  return new Error(`${phase} failed: status=${String(result.status)} signal=${String(result.signal)}`);
}

function requireSuccess(phase: string, result: DockerResult) {
  if (result.error || result.status !== 0 || result.signal !== null) throw commandError(phase, result);
}

function parseInspect(result: DockerResult, kind: "container" | "image") {
  if (result.error) throw commandError(`${kind} inspect`, result);
  if (result.status !== 0) {
    if (/No such (?:object|container|image)/iu.test(String(result.stderr ?? ""))) return undefined;
    throw commandError(`${kind} inspect`, result);
  }
  let records: unknown;
  try {
    records = JSON.parse(String(result.stdout ?? ""));
  } catch {
    throw new Error(`${kind} inspect returned invalid JSON`);
  }
  if (!Array.isArray(records) || records.length !== 1 || records[0] === null || typeof records[0] !== "object") {
    throw new Error(`${kind} inspect returned an unexpected record set`);
  }
  return records[0] as { Id?: string; Name?: string; Config?: { Labels?: Record<string, string> } };
}

function assertOwned(
  state: DockerFixtureState,
  record: { Id?: string; Config?: { Labels?: Record<string, string> } },
  expectedId: string | undefined,
  kind: string,
) {
  if (record.Config?.Labels?.[labelKey] !== state.identity) throw new Error(`${kind} is not owned by this test`);
  if (typeof record.Id !== "string" || record.Id.length === 0) throw new Error(`${kind} has no inspectable ID`);
  if (expectedId && record.Id !== expectedId) throw new Error(`${kind} ID changed`);
  return record.Id;
}

function cleanupDockerResources(state: DockerFixtureState, runner: DockerRunner) {
  const errors: Error[] = [];
  const run = (phase: string, args: string[], timeout: number) => {
    const result = trackedDocker(state, runner, phase, args, timeout);
    return result;
  };

  for (const name of state.containerNames) {
    let record;
    try {
      const expectedId = state.containerIds.get(name);
      record = parseInspect(run("cleanup-container-inspect", ["container", "inspect", name], 20_000), "container");
      if (!record && expectedId) {
        record = parseInspect(run("cleanup-container-id-inspect", ["container", "inspect", expectedId], 20_000), "container");
      }
      if (!record) continue;
      const id = assertOwned(state, record, expectedId, `container ${name}`);
      const stopped = run("cleanup-container-stop", ["container", "stop", "--time", "5", id], 20_000);
      if (stopped.error || stopped.status !== 0) errors.push(commandError(`stop container ${id}`, stopped));
      const removed = run("cleanup-container-rm", ["container", "rm", "-f", id], 20_000);
      if (removed.error || removed.status !== 0) errors.push(commandError(`remove container ${id}`, removed));
      const after = parseInspect(run("cleanup-container-confirm", ["container", "inspect", id], 20_000), "container");
      if (after) errors.push(new Error(`container ${id} still exists after cleanup`));
    } catch (error) {
      errors.push(error as Error);
    }
  }

  if (state.buildStateUnknown) {
    errors.push(new Error("Docker build state is unknown after CLI timeout; context retained"));
  } else {
    const removedIds = new Set<string>();
    for (const tag of state.imageTags) {
      try {
        const expectedId = state.imageIds.get(tag);
        let record = parseInspect(run("cleanup-image-inspect", ["image", "inspect", tag], 20_000), "image");
        if (!record && expectedId) {
          record = parseInspect(run("cleanup-image-id-inspect", ["image", "inspect", expectedId], 20_000), "image");
        }
        if (!record) continue;
        const id = assertOwned(state, record, expectedId, `image ${tag}`);
        if (!removedIds.has(id)) {
          const removed = run("cleanup-image-rm", ["image", "rm", "--force", id], 30_000);
          if (removed.error || removed.status !== 0) errors.push(commandError(`remove image ${id}`, removed));
          removedIds.add(id);
        }
        const after = parseInspect(run("cleanup-image-confirm", ["image", "inspect", tag], 20_000), "image");
        if (after) errors.push(new Error(`image ${tag} still exists after cleanup`));
        const afterId = parseInspect(run("cleanup-image-id-confirm", ["image", "inspect", id], 20_000), "image");
        if (afterId) errors.push(new Error(`image ${id} still exists after cleanup`));
      } catch (error) {
        errors.push(error as Error);
      }
    }
  }

  for (const [kind, args] of [
    ["container", ["ps", "-aq", "--filter", `label=${labelKey}=${state.identity}`]],
    ["image", ["image", "ls", "-q", "--filter", `label=${labelKey}=${state.identity}`]],
  ] as const) {
    try {
      const result = run(`cleanup-${kind}-label-confirm`, [...args], 20_000);
      if (result.error || result.status !== 0) errors.push(commandError(`${kind} label query`, result));
      else if (String(result.stdout ?? "").trim()) errors.push(new Error(`${kind} resources with this test label remain`));
    } catch (error) { errors.push(error as Error); }
  }
  return errors;
}

async function withManagedDockerFixture(
  state: DockerFixtureState,
  runner: DockerRunner,
  body: () => Promise<void>,
  removeContext: (path: string) => Promise<void> = async (path) => rm(path, { recursive: true, force: true }),
) {
  let bodyError: unknown;
  try {
    await body();
  } catch (error) {
    bodyError = error;
  }
  let cleanupErrors: Error[];
  try { cleanupErrors = cleanupDockerResources(state, runner); }
  catch (error) { cleanupErrors = [error as Error]; }
  cleanupErrors.push(...state.trackingErrors);
  if (bodyError || cleanupErrors.length > 0) {
    console.error("Git 安装测试环境失败，保留现场：", state.context);
    if (bodyError && cleanupErrors.length > 0) throw new AggregateError([bodyError, ...cleanupErrors], "Docker fixture and cleanup failed");
    if (bodyError) throw bodyError;
    throw new AggregateError(cleanupErrors, "Docker fixture cleanup failed");
  }
  console.log(JSON.stringify({
    dockerFixture: state.identity,
    containerIds: Object.fromEntries(state.containerIds),
    imageIds: Object.fromEntries(state.imageIds),
    residualByExactLabel: { containers: [], images: [] },
  }));
  try {
    await removeContext(state.context);
  } catch (error) {
    throw new AggregateError([error], `Docker resources ended, but context cleanup failed: ${state.context}`);
  }
}

function inspectAndRecordImage(state: DockerFixtureState, runner: DockerRunner, tag: string) {
  const result = trackedDocker(state, runner, "image-record", ["image", "inspect", tag], 20_000);
  const record = parseInspect(result, "image");
  if (!record) throw new Error(`built image ${tag} is missing`);
  const id = assertOwned(state, record, undefined, `image ${tag}`);
  state.imageIds.set(tag, id);
}

function missingInspect(kind: "container" | "image"): DockerResult {
  return { status: 1, signal: null, output: [], pid: 1, stdout: "", stderr: `Error: No such ${kind}`, error: undefined } as DockerResult;
}

function successful(stdout = ""): DockerResult {
  return { status: 0, signal: null, output: [], pid: 1, stdout, stderr: "", error: undefined } as DockerResult;
}

function timedOut(): DockerResult {
  const error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  return { status: null, signal: "SIGTERM", output: [], pid: 1, stdout: "", stderr: "", error } as DockerResult;
}

describe("Git 安装 Docker 测试环境收尾", () => {
  test("build/run 超时及安装失败保留现场并传播错误", async () => {
    for (const mode of ["build-timeout", "run-timeout", "install-failure"] as const) {
      const context = await mkdtemp(join(tmpdir(), `one-company-git-cleanup-${mode}-`));
      const state = createState(context, `${mode}-${randomUUID()}`);
      let contextRemoved = false;
      const calls: string[][] = [];
      const runner: DockerRunner = (args) => {
        calls.push(args);
        if (args[0] === "build" && mode === "build-timeout") return timedOut();
        if (args[0] === "run" && mode === "run-timeout") return timedOut();
        if (args[0] === "run" && mode === "install-failure") {
          return { ...successful(), status: 1, stderr: "injected installation failure" } as DockerResult;
        }
        if (args[0] === "container" && args[1] === "inspect") return missingInspect("container");
        if (args[0] === "image" && args[1] === "inspect") return missingInspect("image");
        return successful();
      };
      let failure: unknown;
      try {
        await withManagedDockerFixture(state, runner, async () => {
          const result = trackedDocker(state, runner, mode, [mode === "build-timeout" ? "build" : "run"], 5, mode === "build-timeout"
            ? { kind: "build" }
            : { kind: "run", name: state.containerNames[0], cidfile: join(context, "missing.cid") });
          requireSuccess(mode === "install-failure" ? "valid installation" : mode, result);
        }, async () => { contextRemoved = true; });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      const failureMessages = failure instanceof AggregateError
        ? failure.errors.map((error) => String((error as Error).message)).join("\n")
        : String((failure as Error).message);
      expect(failureMessages).toContain(mode === "install-failure" ? "valid installation failed" : mode);
      expect(contextRemoved).toBe(false);
      expect(existsSync(context)).toBe(true);
      if (mode === "build-timeout") expect(calls.some((args) => args[0] === "image" && args[1] === "rm")).toBe(false);
      await rm(context, { recursive: true, force: true });
    }
  });

  test("build异常先保留unknown，日志失败不能改变安全状态或遮蔽原错误", async () => {
    for (const mode of ["timeout-log", "enobufs", "signal", "throw", "cleanup-log"] as const) {
      const context = await mkdtemp(join(tmpdir(), "one-company-git-build-state-")), state = createState(context);
      const calls: string[][] = [];
      let removed = false, imageExists = mode !== "cleanup-log";
      const id = "owned-image-id";
      if (imageExists) state.imageIds.set(state.imageTags[0], id);
      if (mode === "timeout-log") mkdirSync(join(context, "docker-01-build.json"));
      const runner: DockerRunner = (args) => {
        calls.push(args);
        if (args[0] === "build") {
          if (mode === "throw") throw new Error("original-build-exception");
          if (mode === "enobufs") return { ...timedOut(), error: Object.assign(new Error("full buffer"), { code: "ENOBUFS" }) } as DockerResult;
          if (mode === "signal") return { ...timedOut(), error: undefined } as DockerResult;
          return timedOut();
        }
        if (args[0] === "container" && args[1] === "inspect") return missingInspect("container");
        if (args[0] === "image" && args[1] === "inspect") {
          if (imageExists && (args[2] === state.imageTags[0] || args[2] === id)) return successful(JSON.stringify([{ Id: id, Config: { Labels: { [labelKey]: state.identity } } }]));
          return missingInspect("image");
        }
        if (args[0] === "image" && args[1] === "rm") { imageExists = false; return successful(); }
        if (args[0] === "ps" && mode === "cleanup-log") mkdirSync(join(context, `docker-${String(state.commandSequence + 1).padStart(2, "0")}-cleanup-container-label-confirm.json`));
        if (args[0] === "image" && args[1] === "ls") return successful(imageExists ? id : "");
        return successful();
      };
      try {
        let failure: unknown;
        try {
          await withManagedDockerFixture(state, runner, async () => {
            if (mode === "cleanup-log") throw new Error("original-install-failure");
            requireSuccess("original-build-result", trackedDocker(state, runner, "build", ["build"], 5, { kind: "build" }));
          }, async () => { removed = true; });
        } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(AggregateError);
        const messages = (failure as AggregateError).errors.map(String).join("\n");
        expect(messages).toContain(mode === "cleanup-log" ? "original-install-failure" : mode === "throw" ? "original-build-exception" : "original-build-result");
        if (mode !== "cleanup-log") { expect(state.buildStateUnknown).toBe(true); expect(calls.some((args) => args[0] === "image" && args[1] === "rm")).toBe(false); }
        if (mode === "timeout-log" || mode === "cleanup-log") expect(messages).toContain("command log could not be written");
        expect(removed).toBe(false); expect(existsSync(context)).toBe(true);
      } finally { await rm(context, { recursive: true, force: true }); }
    }
  });

  test("rm 超时或非零都显式失败、保留现场并完成归属核验", async () => {
    for (const mode of ["timeout", "nonzero"] as const) {
      const context = await mkdtemp(join(tmpdir(), `one-company-git-cleanup-rm-${mode}-`));
      const state = createState(context, `rm-${mode}-${randomUUID()}`);
      const name = state.containerNames[0];
      const id = `container-${mode}`;
      state.containerIds.set(name, id);
      let inspectCount = 0;
      let contextRemoved = false;
      const runner: DockerRunner = (args) => {
        if (args[0] === "container" && args[1] === "inspect" && args[2] === name) {
          inspectCount += 1;
          if (inspectCount === 1) return successful(JSON.stringify([{ Id: id, Name: `/${name}`, Config: { Labels: { [labelKey]: state.identity } } }]));
          return missingInspect("container");
        }
        if (args[0] === "container" && args[1] === "inspect") return missingInspect("container");
        if (args[0] === "container" && args[1] === "rm") return mode === "timeout" ? timedOut() : ({ ...successful(), status: 1, stderr: "injected rm failure" } as DockerResult);
        if (args[0] === "image" && args[1] === "inspect") return missingInspect("image");
        return successful();
      };
      await expect(withManagedDockerFixture(state, runner, async () => {}, async () => { contextRemoved = true; }))
        .rejects.toThrow("Docker fixture cleanup failed");
      expect(contextRemoved).toBe(false);
      expect(existsSync(context)).toBe(true);
      await rm(context, { recursive: true, force: true });
    }
  });
});

test.skipIf(!dockerAvailable)("Git 安装 hook 在 Linux 容器断网运行时真实拒绝缺失并接受预装 Git", async () => {
  const context = await mkdtemp(join(tmpdir(), "one-company-git-hook-docker-"));
  const state = createState(context);
  await withManagedDockerFixture(state, systemDocker, async () => {
    const packed = spawnSync("pnpm", ["--config.ignore-scripts=true", "pack", "--json", "--pack-destination", context], {
      cwd: productRoot,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    writeFileSync(join(context, "pnpm-pack.json"), JSON.stringify({
      status: packed.status, signal: packed.signal, errorCode: errorCode(packed), stdout: packed.stdout, stderr: packed.stderr,
    }, null, 2), { mode: 0o600 });
    requireSuccess("pnpm pack", packed);
    const packResult = JSON.parse(String(packed.stdout)) as { filename: string };
    const artifactName = basename(packResult.filename);
    const artifactPath = join(context, artifactName);
    expect((await readFile(artifactPath)).length).toBeGreaterThan(0);

    await writeFile(join(context, "Dockerfile"), `
FROM node:22-alpine AS cached
ARG TASK_LABEL
LABEL ${labelKey}=$TASK_LABEL
COPY ${artifactName} /opt/one-company.tgz
RUN mkdir -p /seed /work /tmp/test-home \\
 && cd /seed \\
 && npm install --ignore-scripts --omit=peer --legacy-peer-deps --no-audit --no-fund /opt/one-company.tgz
WORKDIR /work

FROM cached AS missing

FROM cached AS valid
RUN apk add --no-cache git
`);

    for (const [index, target] of ["missing", "valid"].entries()) {
      const built = trackedDocker(state, systemDocker, `build-${target}`, [
        "build", "--target", target, "--build-arg", `TASK_LABEL=${state.identity}`,
        "--label", `${labelKey}=${state.identity}`,
        "-t", state.imageTags[index], context,
      ], 180_000, { kind: "build" });
      requireSuccess(`build ${target}`, built);
      inspectAndRecordImage(state, systemDocker, state.imageTags[index]);
    }

    const installScript = `
const { existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const expectGit = process.argv[1] === "yes";
if (existsSync("/usr/bin/git") !== expectGit) process.exit(97);
const result = spawnSync("/usr/local/bin/npm", ["install", "--offline", "--omit=peer", "--legacy-peer-deps", "--no-audit", "--no-fund", "/opt/one-company.tgz"], {
  cwd: "/work",
  env: { ...process.env, HOME: "/tmp/test-home", npm_config_cache: "/root/.npm", npm_config_update_notifier: "false" },
  encoding: "utf8",
  timeout: 60_000,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
process.exit(result.status === null ? 98 : result.status);
`;
    const runInstall = (index: number, expectGit: "yes" | "no") => {
      const cidfile = join(context, `${expectGit}.cid`);
      const result = trackedDocker(state, systemDocker, `run-${expectGit}`, [
        "run", "--rm", "--network", "none", "--cidfile", cidfile,
        "--name", state.containerNames[index], "--label", `${labelKey}=${state.identity}`,
        state.imageTags[index], "node", "-e", installScript, expectGit,
      ], 90_000, { kind: "run", name: state.containerNames[index], cidfile });
      if (result.error || result.signal !== null) throw commandError(`run ${expectGit}`, result);
      return result;
    };

    const missing = runInstall(0, "no");
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}\n${missing.stderr}`).toContain("必须预先安装Git并确保PATH可用");

    const valid = runInstall(1, "yes");
    requireSuccess("valid offline installation", valid);

    console.log(JSON.stringify({
      linuxInstall: { missingStatus: missing.status, validStatus: valid.status, network: "none" },
    }));
  });
}, 300_000);
