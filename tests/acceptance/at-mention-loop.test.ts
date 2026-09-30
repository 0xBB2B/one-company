import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { expect, test } from "vitest";
import { repositoryDatabase, withDatabase } from "../../runtime/database.ts";
import { daemonSocketPath, repositoryIdentity } from "../../runtime/identity.ts";
import type { RequirementRecord } from "../../runtime/requirement-contracts.ts";
import { RequirementStateStore } from "../../runtime/requirement-state.ts";
import { RunStore } from "../../runtime/run-store.ts";
import { sessionFilePath } from "../../runtime/session-records.ts";
import { killUnder, mainSessionFacts, sumUsage, waitMissing } from "./helpers/evidence.ts";
import { acceptanceConfig, copyCredentials, installProduct, startInstalledHost } from "./helpers/installed-host.ts";
import type { InstalledHost } from "./helpers/installed-host.ts";
import { createSampleProject } from "./helpers/sample-project.ts";
import { driveUser } from "./helpers/user-driver.ts";
import type { DriverEvent, UserScript } from "./helpers/user-driver.ts";

const config = acceptanceConfig();
const DOWN = "\x1b[B", UP = "\x1b[A", ESCAPE = "\x1b";
const AUTHORIZE = "请整理成需求草稿给我确认。确认后授权你直接实施：创建独立工作区、派 PM 按计划实现、测试和验收，完成后由我验收报告。";
const APPROVE = { approve: "需求草稿我看过了，内容正确，批准这一版，按上面的授权直接实施。", proceed: "继续：创建工作区并派出 PM 开始实施。",
  accept: "先不验收。", close: "先不关闭。" };
const SPRINT: UserScript = { requirement: "我要给角色加快跑：按住 Shift 并按方向键时，水平速度变为行走速度的 1.5 倍；松开 Shift 立即恢复行走速度；角色在空中时按 Shift 不改变水平速度。不做体力值，不改跳跃。" + AUTHORIZE, ...APPROVE };
const JUMP: UserScript = { requirement: "我要调整跳跃：按住空格越久跳得越高，最长按住 0.3 秒，超过按 0.3 秒算；空中仍然不能再次起跳。不改快跑和水平移动。" + AUTHORIZE, ...APPROVE };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 像用户一样在 PM 面板里逐个按 p：暂停或恢复全部 PM，直到面板显示的状态一致。 */
async function togglePms(host: InstalledHost, paused: boolean): Promise<void> {
  const selectable = () => host.panelLines().filter((line) => /[├└]─ /u.test(line) || line.includes("⚑"));
  const pmIndexes = selectable().flatMap((line, index) => /[├└]─ /u.test(line) ? [index] : []);
  for (const index of pmIndexes) {
    const row = selectable()[index] ?? "";
    if (row.includes("⏸") === paused) continue;
    host.press(DOWN);
    for (let i = 0; i < 50; i++) host.press(UP);
    for (let i = 0; i < index; i++) host.press(DOWN);
    host.press("p");
    host.press(ESCAPE);
    await sleep(1_000);
  }
  for (let i = 0; i < 60; i++) {
    const rows = host.panelLines().filter((line) => /[├└]─ /u.test(line));
    if (rows.length && rows.every((line) => line.includes("⏸") === paused)) return;
    await sleep(1_000);
  }
  throw new Error(`PM 没能全部${paused ? "暂停" : "恢复"}：${host.panelLines().join("\n")}`);
}

test.skipIf(!config || process.platform !== "darwin")("M8D-AC6：@需求追加功能、转告 PM、同时 @ 两个需求、不带 @ 的新需求与跨两个需求的修正，主代理分别判断并由程序核对决定对象", async () => {
  const cfg = config!;
  const evidence = join(cfg.output, `at-mention-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  const record = (event: DriverEvent | { type: "phase"; phase: string; at: number } | { type: "check"; name: string; ok: boolean; detail: unknown; at: number }) => {
    void appendFile(join(evidence, "events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
  };
  const save = (name: string, value: unknown) => writeFile(join(evidence, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

  const root = await mkdtemp(join(tmpdir(), "m8d-"));
  const agentDir = join(root, "agent"), home = join(root, "home"), dataRoot = join(agentDir, "one-company");
  const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "HOME", "PI_TELEMETRY", "ONE_COMPANY_IDLE_TIMEOUT_MS"].map((key) => [key, process.env[key]]));
  let host: InstalledHost | undefined, socketPath: string | undefined;
  const started = Date.now(), checks: Array<{ name: string; ok: boolean; detail: unknown }> = [];
  const check = (name: string, ok: boolean, detail: unknown = null) => { checks.push({ name, ok, detail }); record({ type: "check", name, ok, detail, at: Date.now() }); };
  try {
    const installed = await installProduct(root);
    const repo = await createSampleProject(root);
    const { repoId } = await repositoryIdentity(repo);
    await mkdir(home, { recursive: true });
    await copyCredentials(cfg.credentialsDir, agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = home;
    process.env.PI_TELEMETRY = "0";
    process.env.ONE_COMPANY_IDLE_TIMEOUT_MS = "2000";
    socketPath = daemonSocketPath(dataRoot, repoId);
    host = await startInstalledHost({ installed, repo, agentDir, config: cfg });
    const h = host;
    const requirements = () => withDatabase(repositoryDatabase(dataRoot, repoId), (db) => db.list<RequirementRecord>("requirements").map((row) => row.data));
    const revision = (id: string) => requirements().find((item) => item.requirementId === id)!.revision;
    const state = await RequirementStateStore.open({ repositoryRoot: repo, dataRoot, repoId, authorize: () => true });
    const approvedEvent = (id: string, rev: number) => state.events(id).some((event) => event.data.kind === "prod.approved" && event.data.revision === rev);
    const runs = async () => {
      const store = new RunStore({ dataRoot, repoId, daemonStartedAt: new Date().toISOString() });
      return (await Promise.all((await store.list({ limit: 500 })).items.map(async (item) => { const got = await store.get(item.id); return got.ok ? [got.run] : []; }))).flat();
    };
    const pmOf = async (id: string) => (await runs()).find((run) => run.kind === "requirement" && run.requirement === id && run.role === undefined);
    const toolResults = (since: number) => h.session.messages.slice(since).flatMap((message) => message.role === "toolResult"
      ? [{ tool: message.toolName, isError: message.isError === true, text: message.content.map((block) => block.type === "text" ? block.text : "").join("") }] : []);
    const approvals = () => h.dialogs.filter((dialog) => dialog.title === "批准需求").length;
    const say = async (text: string) => {
      record({ type: "user", text, at: Date.now() });
      await h.session.prompt(text, { source: "interactive" });
      await h.session.waitForIdle();
    };
    /** 主代理没做到时，像用户一样按推荐再说一次，最多两次。 */
    const until = async (condition: () => boolean | Promise<boolean>, followUp: string) => {
      for (let i = 0; i < 2 && !(await condition()); i++) await say(followUp);
      return condition();
    };
    const limits = { userTurns: 12, wallMs: 30 * 60_000, sameMessage: 3, stopFile: join(evidence, "STOP") };

    record({ type: "phase", phase: "sprint", at: Date.now() });
    const sprint = await driveUser(h, SPRINT, limits, record, { until: async () => requirements().length > 0 && Boolean(await pmOf(requirements()[0]!.requirementId)) });
    expect(sprint, JSON.stringify(sprint)).toMatchObject({ status: "reached" });
    await togglePms(h, true);
    const a = requirements()[0]!.requirementId;
    check("不带 @ 的新需求建成草稿，批准时弹出批准窗口", approvals() >= 1, { dialogs: h.dialogs.map((d) => d.title) });

    record({ type: "phase", phase: "jump", at: Date.now() });
    // 快跑的 PM 已暂停但仍在面板上，驱动要在 PM 存在时照样回答主代理
    const jump = await driveUser(h, JUMP, limits, record, { since: h.session.messages.length, approveWhileRunning: true,
      until: async () => requirements().length > 1 && Boolean(await pmOf(requirements().find((item) => item.requirementId !== a)!.requirementId)) });
    expect(jump, JSON.stringify(jump)).toMatchObject({ status: "reached" });
    await togglePms(h, true);
    const b = requirements().find((item) => item.requirementId !== a)!.requirementId;
    const A = `@[快跑#${a.slice(-8)}]`, B = `@[跳跃#${b.slice(-8)}]`;

    record({ type: "phase", phase: "at-feature", at: Date.now() });
    let rev = revision(a), since = h.session.messages.length, dialogs = approvals();
    await say(`${A} 追加一条：快跑时角色头顶显示一个小箭头提示正在快跑；其余不变。请更新需求草稿给我确认。`);
    const updatedA = () => toolResults(since).some((r) => r.tool === "one_company_requirement_manage" && !r.isError && r.text.includes('"updateDraft"') && r.text.includes(a));
    check("@需求追加功能时主代理修改该需求草稿", await until(updatedA, `${A} 按你的推荐处理，更新草稿给我确认。`));
    await say(`${A} 更新后的草稿我确认，批准这一版。`);
    check("@到的需求直接批准不弹窗，批准后为 PM 记下批准版本变化", await until(() => revision(a) > rev, `${A} 这一版我确认，批准。`) && approvals() === dialogs && approvedEvent(a, revision(a)),
      { revision: revision(a), dialogs: approvals() - dialogs });

    record({ type: "phase", phase: "at-instruction", at: Date.now() });
    since = h.session.messages.length; rev = revision(a);
    await say(`${A} 转告 PM：先写测试再改代码，不要动跳跃相关的文件。这不是需求变更。`);
    const forwarded = () => toolResults(since).some((r) => r.tool === "one_company_agent_manage" && !r.isError && /"delivered":"(now|after_resume)"/u.test(r.text));
    check("@需求下指示时主代理用 message 转给 PM，不改需求", await until(forwarded, `${A} 请直接把这句话转给 PM。`) && revision(a) === rev);

    record({ type: "phase", phase: "at-two", at: Date.now() });
    since = h.session.messages.length; dialogs = approvals();
    const [ra, rb] = [revision(a), revision(b)];
    const updated = (id: string) => () => toolResults(since).some((r) => r.tool === "one_company_requirement_manage" && !r.isError && r.text.includes('"updateDraft"') && r.text.includes(id));
    await say(`${A} ${B} 两个需求都补一条：所有速度常量集中写在 src/config.ts 里。请分别更新草稿给我确认。`);
    check("一句话 @ 两个需求时两个草稿都修改", await until(async () => updated(a)() && updated(b)(), `${A} ${B} 按你的推荐处理，两个草稿都更新后给我确认。`));
    await say(`${A} ${B} 两处更新我都确认，批准。`);
    check("@ 到的两个需求都直接批准，不弹窗", await until(() => revision(a) > ra && revision(b) > rb, `${A} ${B} 两处我都批准。`) && approvals() === dialogs,
      { revisions: [revision(a), revision(b)], dialogs: approvals() - dialogs });

    record({ type: "phase", phase: "plain-two", at: Date.now() });
    since = h.session.messages.length; dialogs = approvals();
    const [pa, pb] = [revision(a), revision(b)];
    await say("快跑和跳跃这两个需求都再补一条：速度单位统一用像素每帧。请分别更新草稿给我确认。");
    check("不带 @ 时主代理判断出涉及两个现有需求并都修改", await until(async () => updated(a)() && updated(b)(), "按你的推荐处理，两个草稿都更新后给我确认。"));
    await say("两处更新我都确认，批准。");
    check("不带 @ 的批准逐个弹出批准窗口，确认后两个都生效", await until(() => revision(a) > pa && revision(b) > pb, "两处我都批准。") && approvals() - dialogs >= 2,
      { revisions: [revision(a), revision(b)], dialogs: approvals() - dialogs });

    record({ type: "phase", phase: "plain-new", at: Date.now() });
    const count = requirements().length;
    await say("我还有一个新需求：角色可以蹲下，按住 S 键时身高减半、水平速度减半，松开恢复。先整理成草稿给我看，暂时不批准。");
    check("不带 @ 说新需求时主代理新建草稿", await until(() => requirements().length > count && requirements().some((item) => item.lifecycle === "draft"), "请把蹲下这个新需求整理成草稿。"));

    record({ type: "phase", phase: "pm-receives", at: Date.now() });
    await togglePms(h, false);
    const pm = (await pmOf(a))!;
    let received = false;
    for (let i = 0; i < 300 && !received; i++) {
      received = (await readFile(sessionFilePath({ dataRoot, repoId, runId: pm.id }), "utf8").catch(() => "")).includes("【主代理转述】");
      if (!received) await sleep(1_000);
    }
    check("恢复后 PM 会话里收到标为主代理转述的消息", received);

    const all = await runs();
    await save("report.json", { elapsedMs: Date.now() - started, checks, main: mainSessionFacts(h), dialogs: h.dialogs.map((d) => ({ kind: d.kind, title: d.title, message: d.message })),
      runs: all.map((run) => ({ id: run.id, kind: run.kind, role: run.role, requirement: run.requirement, state: run.state, stopCause: run.stopCause, turns: run.turns, usage: run.usage })),
      runUsage: sumUsage(all.map((run) => run.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })),
      requirements: requirements().map((item) => ({ requirementId: item.requirementId, lifecycle: item.lifecycle, revision: item.revision })),
      modelEvents: h.modelEvents, notifications: h.notifications });
    expect(checks.filter((item) => !item.ok), JSON.stringify(checks)).toEqual([]);
  } finally {
    if (host) {
      await save("main-session.json", JSON.stringify(host.session.messages, null, 2)).catch(() => undefined);
      await save("side-calls.json", JSON.stringify(host.sideCalls, null, 2)).catch(() => undefined);
      await host.close().catch(() => undefined);
    }
    let daemonGone = socketPath ? await waitMissing(socketPath, 30_000) : true;
    if (!daemonGone && socketPath) { await killUnder(root); daemonGone = await waitMissing(socketPath, 10_000); }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const path of (await readdir(dataRoot, { recursive: true }).catch(() => [] as string[])).filter((name) => name.endsWith("session.jsonl"))) {
      await mkdir(join(evidence, "runs"), { recursive: true });
      await copyFile(join(dataRoot, path), join(evidence, "runs", `${basename(dirname(path))}.jsonl`)).catch(() => undefined);
    }
    for (const file of await readdir(join(dataRoot, "repos"), { recursive: true }).catch(() => [] as string[])) {
      if (/(^|\/)data\.db(-wal)?$/u.test(file)) await copyFile(join(dataRoot, "repos", file), join(evidence, basename(file))).catch(() => undefined);
    }
    await rm(join(agentDir, "auth.json"), { force: true });
    await rm(join(agentDir, "models.json"), { force: true });
    if (daemonGone) await rm(root, { recursive: true, force: true });
    else record({ type: "stop", reason: `守护进程未退出，保留现场：${root}`, at: Date.now() });
  }
}, 120 * 60_000);
