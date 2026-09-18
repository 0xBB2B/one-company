import { expect, test } from "vitest";
import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { classifySleep } from "./helpers/project-index-daemon-child.ts";
import type { SleepEvidence } from "./helpers/project-index-daemon-child.ts";
import { resolveSdkDir } from "./helpers/daemon-harness.ts";

function revokedSleep(): SleepEvidence {
  return {
    installed: true, module: "fixture", started: 1, completed: 0, failed: 1, observerErrors: 0,
    events: [{ call: 1, phase: "started", sequence: 1 },
      { call: 1, phase: "failed", sequence: 5, errorCode: "authorization_denied" }],
    authority: { installed: true, revocations: [{ entry: 1, holder: 2, sequence: 3 }],
      calls: [{ call: 1, selections: 1, lastAuthorized: [{ entry: 1, holder: 2, sequence: 2 }],
        denied: [{ entry: 1, sequence: 4, lastAuthorized: { entry: 1, holder: 2, sequence: 2 } }] }] },
  };
}

test("额外sleep持权→撤权→拒绝只分类cancelled，原始failed及错误保持不变", () => {
  const raw = revokedSleep(); const before = structuredClone(raw);
  expect(classifySleep(raw, [], true)).toEqual({ successful: [], cancelled: [1], pending: [], required: [] });
  expect(raw).toEqual(before);
  expect(() => classifySleep(raw, [1], true)).toThrow("持权必测call1被拒绝");
});

test.each([
  ["没有撤权", (raw: SleepEvidence) => { raw.authority.revocations = []; }],
  ["错误持有者", (raw: SleepEvidence) => { raw.authority.revocations[0].holder = 3; }],
  ["另一entry", (raw: SleepEvidence) => { raw.authority.revocations[0].entry = 3; }],
  ["开始前的旧撤权", (raw: SleepEvidence) => { raw.authority.revocations[0].sequence = 0; }],
  ["拒绝后的撤权", (raw: SleepEvidence) => { raw.authority.revocations[0].sequence = 6; }],
  ["从未持权", (raw: SleepEvidence) => { delete raw.authority.calls[0].denied[0].lastAuthorized; }],
  ["另一拒绝没有归因", (raw: SleepEvidence) => { raw.authority.calls[0].denied.push({ entry: 9, sequence: 4 }); }],
  ["非授权错误", (raw: SleepEvidence) => { raw.events[1].errorCode = "index_not_fresh"; }],
  ["缺授权探针", (raw: SleepEvidence) => { raw.authority.installed = false; }],
] as const)("%s不能把原始失败算作cancelled", (_label, mutate) => {
  const raw = revokedSleep(); mutate(raw);
  expect(() => classifySleep(raw)).toThrow("没有匹配");
});

test("持权sleep失败即使错误码为authorization_denied仍保持失败", () => {
  const raw = revokedSleep(); raw.authority.revocations = [];
  expect(() => classifySleep(raw, [1])).toThrow("持权必测");
  expect(() => classifySleep(raw)).toThrow("没有匹配");
});

test("原始计数、事件缺失和观察器错误不能被分类掩盖", () => {
  for (const mutate of [
    (raw: SleepEvidence) => { raw.failed = 0; },
    (raw: SleepEvidence) => { raw.events.pop(); },
    (raw: SleepEvidence) => { raw.observerErrors = 1; },
    (raw: SleepEvidence) => { raw.events[1].sequence = 0; },
  ]) {
    const raw = revokedSleep(); mutate(raw);
    expect(() => classifySleep(raw)).toThrow("真实sleep失败/无归因");
  }
});

test("真实loader探针：原Promise结束后继承async context的timer拒绝不污染已完成sleep", async () => {
  const root = await mkdtemp("/tmp/m3-sleep-evidence-wrapper-");
  await chmod(root, 0o700);
  const daemon = join(root, "daemon"); await mkdir(daemon, { mode: 0o700 });
  await copyFile(new URL("../daemon/bootstrap.mjs", import.meta.url), join(daemon, "bootstrap.mjs"));
  await symlink(fileURLToPath(new URL("../daemon/loader.mjs", import.meta.url)), join(daemon, "loader.mjs"));
  await symlink(fileURLToPath(new URL("../runtime", import.meta.url)), join(root, "runtime"));
  await writeFile(join(daemon, "project-index-coordinator.ts"), `
    export class ProjectIndexCoordinator {
      attachment = { active: true, client: {} };
      entry = { clients: new Map() };
      constructor(public expected: Promise<void>, public afterTimer: () => void) { this.entry.clients.set(this.attachment.client, this.attachment); }
      selectAuthorized(entry: object) { return this.attachment.active ? this.attachment : null; }
      deactivate() { this.attachment.active = false; this.entry.clients.clear(); return [{ entry: this.entry, attachment: this.attachment }]; }
      onSleepGap() {
        this.selectAuthorized(this.entry);
        setTimeout(() => { this.selectAuthorized(this.entry); this.afterTimer(); }, 30);
        return this.expected;
      }
    }
  `, { mode: 0o600 });
  await writeFile(join(daemon, "main.ts"), `
    import assert from 'node:assert/strict';
    import { ProjectIndexCoordinator } from './project-index-coordinator.ts';
    let finish!: () => void, afterTimer!: () => void;
    const expected = new Promise<void>(resolve => { finish = resolve; });
    const timer = new Promise<void>(resolve => { afterTimer = resolve; });
    const coordinator = new ProjectIndexCoordinator(expected, afterTimer);
    const returned = coordinator.onSleepGap(); assert.equal(returned, expected);
    finish(); await returned; coordinator.deactivate(); await timer;
  `, { mode: 0o600 });
  let closed = false, passed = false;
  try {
    const child = promisify(execFile)(process.execPath, ["--import", fileURLToPath(new URL("./helpers/project-index-daemon-child.ts", import.meta.url)), join(daemon, "bootstrap.mjs")],
      { env: { ...process.env, PI_COMPANY_SDK_DIR: resolveSdkDir(), PI_COMPANY_REPO_DIR: root, M3_ASSEMBLY_REPOSITORY: root, M3_ASSEMBLY_PROBE: join(root, "probe.json") }, timeout: 10_000 });
    child.child.once("close", () => { closed = true; });
    await child;
    const raw = JSON.parse(await readFile(join(root, "probe.json"), "utf8"));
    expect(raw.sleep).toMatchObject({ started: 1, completed: 1, failed: 0, observerErrors: 0 });
    expect(raw.sleep.authority.revocations).toHaveLength(1);
    expect(raw.sleep.authority.calls[0].denied).toEqual([]);
    expect(classifySleep(raw.sleep, [1], true).successful).toEqual([1]);
    passed = true;
  } finally {
    if (closed && passed) await rm(root, { recursive: true, force: true });
    else throw new Error(`探针测试失败或close未知；保留现场：${root}`);
  }
});

test("原Promise成功且有持续持权证据才能满足目标；未调用/在途不算完成", () => {
  const raw = revokedSleep(); raw.events.pop(); raw.failed = 0;
  expect(classifySleep(raw, [1]).pending).toEqual([1]);
  expect(() => classifySleep(raw, [1], true)).toThrow("仍有在途");
  raw.authority.calls[0].denied = []; raw.authority.revocations = [];
  raw.events.push({ call: 1, phase: "completed", sequence: 3 }); raw.completed = 1;
  expect(classifySleep(raw, [1], true).successful).toEqual([1]);
  expect(() => classifySleep(raw, [2], true)).toThrow("必测调用未成功");
  raw.authority.calls[0].selections = 0;
  expect(() => classifySleep(raw, [1], true)).toThrow("缺少持续持权证据");
});
