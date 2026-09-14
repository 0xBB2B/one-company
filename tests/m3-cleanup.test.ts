import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cleanupOwnedScope } from "./helpers/m3-cleanup.ts";

const execute = promisify(execFile);

test("清理首个孩子失败仍逐个停止后续孩子，保留所有关联目录", async () => {
  const trace: string[] = [];
  await expect(cleanupOwnedScope({
    paths: ["/tmp/owned-fixture-a", "/tmp/owned-fixture-b"],
    stop: [
      { label: "child-a", run: () => { trace.push("a-stop-failed"); throw new Error("stop failure"); } },
      { label: "child-b", run: () => { trace.push("b-stopped"); } },
    ],
    diagnose: [
      { label: "evidence-a", run: () => { trace.push("a-evidence-failed"); throw new Error("evidence failure"); } },
      { label: "evidence-b", run: () => { trace.push("b-evidence"); } },
    ],
    remove: [{ label: "delete", run: () => { trace.push("deleted"); } }],
  })).rejects.toThrow("保留关联现场：/tmp/owned-fixture-a, /tmp/owned-fixture-b");
  expect(trace).toEqual(["a-stop-failed", "b-stopped", "a-evidence-failed", "b-evidence"]);
});

test("未知exited有界返回失败，迟到结束不补做删除且后续孩子仍收尾", async () => {
  const trace: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  try {
    await expect(cleanupOwnedScope({
      paths: ["/tmp/owned-unknown"],
      stop: [
        { label: "unknown-exited", timeoutMs: 20, run: () => pending },
        { label: "next-child", run: () => { trace.push("next-stopped"); } },
      ],
      remove: [{ label: "delete", run: () => { trace.push("deleted"); } }],
    })).rejects.toThrow("/tmp/owned-unknown");
  } finally { release(); await pending; }
  expect(trace).toEqual(["next-stopped"]);
});

test("所有资源停止但诊断失败仍保留；全部成功才允许进入删除阶段", async () => {
  for (const fail of [true, false]) {
    const trace: string[] = [];
    const result = cleanupOwnedScope({
      paths: ["/tmp/owned-scope"],
      stop: [{ label: "stop", run: () => { trace.push("stopped"); } }],
      diagnose: [{ label: "diagnose", run: () => { trace.push("diagnosed"); if (fail) throw new Error("read failure"); } }],
      remove: [{ label: "delete", run: () => { trace.push("deleted"); } }],
    });
    if (fail) await expect(result).rejects.toThrow("/tmp/owned-scope"); else await result;
    expect(trace).toEqual(fail ? ["stopped", "diagnosed"] : ["stopped", "diagnosed", "deleted"]);
  }
});

test("sleep探针只包装实际入口同目录模块，保持原Promise、拒绝结果和无正文错误类别", async () => {
  const root = await mkdtemp("/tmp/m3-test-lifecycle-wrapper-");
  const daemon = join(root, "daemon");
  const report = join(root, "probe.json");
  await mkdir(daemon);
  // 包装器单测使用真实产品bootstrap/loader；只有被观察的最小方法是夹具，不替代产品集成验证。
  await copyFile(new URL("../daemon/bootstrap.mjs", import.meta.url), join(daemon, "bootstrap.mjs"));
  await symlink(fileURLToPath(new URL("../daemon/loader.mjs", import.meta.url)), join(daemon, "loader.mjs"));
  await writeFile(join(daemon, "project-index-coordinator.ts"), `
    export class ProjectIndexCoordinator {
      result: Promise<unknown>;
      constructor(result: Promise<unknown>) { this.result = result; }
      onSleepGap() { return this.result; }
    }
  `, { mode: 0o600 });
  await writeFile(join(daemon, "main.ts"), `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { ProjectIndexCoordinator } from './project-index-coordinator.ts';
    let finish: () => void;
    const expected = new Promise<void>(resolve => { finish = resolve; });
    const returned = new ProjectIndexCoordinator(expected).onSleepGap();
    assert.equal(returned, expected);
    let report = JSON.parse(fs.readFileSync(process.env.M3_ASSEMBLY_PROBE, 'utf8'));
    assert.equal(report.sleep.started, 1);
    assert.equal(report.sleep.completed, 0);
    finish!();
    await returned;
    const originalError = Object.assign(new Error('BODY_MUST_NOT_ENTER_PROBE'), { code: 'authorization_denied' });
    const rejected = Promise.reject(originalError);
    const returnedRejection = new ProjectIndexCoordinator(rejected).onSleepGap();
    assert.equal(returnedRejection, rejected);
    await assert.rejects(returnedRejection, error => error === originalError);
  `, { mode: 0o600 });
  let closed = false;
  try {
    const child = execute(process.execPath, ["--import", fileURLToPath(new URL("./helpers/project-index-daemon-child.ts", import.meta.url)),
      join(daemon, "bootstrap.mjs")], { env: { ...process.env, M3_ASSEMBLY_REPOSITORY: root, M3_ASSEMBLY_PROBE: report }, timeout: 10_000 });
    child.child.once("close", () => { closed = true; });
    await child;
    const raw = await readFile(report, "utf8");
    const probe = JSON.parse(raw);
    expect(probe.sleep).toMatchObject({ installed: true, started: 2, completed: 1, failed: 1, observerErrors: 0 });
    expect(probe.sleep.module).toBe(new URL(`file://${await realpath(daemon)}/project-index-coordinator.ts`).href);
    expect(probe.sleep.events.map((event: { phase: string }) => event.phase)).toEqual(["started", "completed", "started", "failed"]);
    expect(probe.sleep.events[3].errorCode).toBe("authorization_denied");
    expect(raw).not.toContain("BODY_MUST_NOT_ENTER_PROBE");
  } finally {
    if (closed) await rm(root, { recursive: true, force: true });
    else throw new Error(`子进程未确认close；保留现场：${root}`);
  }
});

test("真实原生watcher的close调用不能计作close事件，同进程事件到达后才能归零", async () => {
  const root = await mkdtemp("/tmp/m3-test-lifecycle-probe-");
  const report = join(root, "probe.json");
  // execFile回调在close后完成；不在未知存活子进程路径删除目录。
  let closed = false;
  try {
    const child = execute(process.execPath, ["--import", fileURLToPath(new URL("./helpers/project-index-daemon-child.ts", import.meta.url)),
      "--input-type=module", "-e", `
        import fs from 'node:fs';
        import { once } from 'node:events';
        const watcher = fs.watch(process.env.M3_ASSEMBLY_REPOSITORY);
        let actual = 0;
        watcher.once('close', () => actual++);
        const done = once(watcher, 'close');
        watcher.close();
        const immediate = JSON.parse(fs.readFileSync(process.env.M3_ASSEMBLY_PROBE, 'utf8'));
        await done;
        const eventual = JSON.parse(fs.readFileSync(process.env.M3_ASSEMBLY_PROBE, 'utf8'));
        console.log(JSON.stringify({ immediate, eventual, actual }));
      `], { env: { ...process.env, M3_ASSEMBLY_REPOSITORY: root, M3_ASSEMBLY_PROBE: report }, timeout: 10_000 });
    child.child.once("close", () => { closed = true; });
    const { stdout } = await child;
    const data = JSON.parse(stdout);
    expect(data.immediate).toMatchObject({ closeCalls: 1, closeEvents: 0, watchers: 1, closedWatchers: 0, exited: false });
    expect(data.eventual).toMatchObject({ closeCalls: 1, closeEvents: 1, watchers: 0, closedWatchers: 1, exited: false });
    expect(data.actual).toBe(1);
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({ watchers: 0, closeEvents: 1, exited: true });
  } finally {
    if (closed) await rm(root, { recursive: true, force: true });
    else throw new Error(`子进程未确认close；保留现场：${root}`);
  }
});
