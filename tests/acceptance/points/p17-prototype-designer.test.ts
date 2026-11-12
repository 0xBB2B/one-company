import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { registerProtocolHandlers } from "../../../src/app/daemon/run-manager.ts";
import { uuidv7 } from "../../../src/core/storage/database.ts";
import { readPrototypeBoard } from "../../../src/modules/requirement/requirement-prototypes.ts";
import { createPmRunWorld } from "../../helpers/run-manager-fixture.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { pointEvidence } from "../helpers/point-pm.ts";
import { createRealModel } from "../helpers/real-model.ts";
import { checkDesignSpec } from "../../../src/modules/requirement/design-spec.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const NAME = "存档列表页";
const BRIEF = "游戏的存档列表页：列出每条存档的名称和保存时间，可以读取和删除；读取存档列表时要等待，读取可能失败，没有存档时给出提示。";
const STATES = [/正常/, /空|无|没有/, /加载中|读取中/, /出错|失败|错误/];
const NOTE_WORDS = /演示|原型|待确认/g;
type Handler = (params: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>;
interface Submitted { action?: string; html?: string; design?: string | string[]; pages?: Array<{ name: string; views: Array<{ name: string }> }> }

test.skipIf(!config || process.platform !== "darwin")("P17：原型设计师收到一个带界面的设计任务，按分开的格式交稿：四种状态都在页面清单里，页面里没有说明性字样", async () => {
  const evidence = await pointEvidence(config!, "p17");
  const w = await createPmRunWorld(cleanups);
  const real = await createRealModel(w.fixture.root, config!);
  cleanups.push(() => real.close(evidence));
  let turns = 0;
  w.provider.awaitReply = async (request) => (request.systemPrompt ?? "").includes("你是原型设计师") && turns++ < 25 ? real.answer(request) : { type: "text", text: "收到" };

  const handlers = new Map<string, Handler>();
  const server = { registerHandler: (method: string, handler: Handler) => handlers.set(method, handler), markHandlersReady: () => {},
    onHello: null as null | ((client: unknown) => unknown), onDisconnect: null as null | ((client: unknown) => unknown) };
  registerProtocolHandlers({ server: server as never, manager: w.manager, shellRegistry: {} as never });
  const client = { connectionId: "connection-a", sessionId: "session-a", windowId: "win" };
  await server.onHello!(client);
  const baseAnchor = w.db((db) => db.list<{ kind: string; sequence: number; requirementId: string; anchor: string }>("line_anchors")
    .map((row) => row.data).filter((record) => record.requirementId === w.fixture.requirementId && record.kind === "save").sort((a, b) => a.sequence - b.sequence)[0]!.anchor);
  const dispatchAnchor = uuidv7();
  await handlers.get("prototypes.dispatch")!({ requirementId: w.fixture.requirementId, name: NAME, brief: BRIEF, maxTurns: 20, model: { provider: "team-model", id: "test" }, thinking: "off", line: [baseAnchor], anchor: dispatchAnchor }, client);

  const ref = { dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId };
  const status = async () => (await readPrototypeBoard(ref, w.fixture.requirementId, [baseAnchor, dispatchAnchor])).entries.find((entry) => entry.name === NAME)?.inFlight?.status;
  for (let waited = 0; waited < 900 && await status() !== "awaiting"; waited++) await new Promise((resolve) => setTimeout(resolve, 1_000));

  const submits = real.toolCalls().filter((block) => block.name === "one_company_result_submit").map((block) => block.arguments as Submitted);
  const last = submits.at(-1);
  const views = (last?.pages ?? []).flatMap((page) => page.views.map((view) => view.name));
  const noteWords = (last?.html ?? "").match(NOTE_WORDS) ?? [];
  const missing = STATES.filter((state) => !views.some((view) => state.test(view))).map(String);
  const designs = last?.design === undefined ? [] : [last.design].flat();
  const designProblems = designs.length ? designs.map((text) => { try { checkDesignSpec(text); return null; } catch (error) { return (error as Error).message; } }).filter(Boolean) : ["交稿没带 DESIGN.md"];
  await writeFile(join(evidence, "judgement.json"), `${JSON.stringify({ realTurns: turns, status: await status(), submits: submits.length, pages: last?.pages, views, missing, noteWords, designProblems,
    calls: real.toolCalls().map((block) => block.name) }, null, 2)}\n`, { mode: 0o600 });
  expect(turns, "真实模型没有被调用：设计师没有派出").toBeGreaterThan(0);
  expect(await status(), "交稿没有被收下").toBe("awaiting");
  expect(missing, "页面清单缺状态").toEqual([]);
  expect(noteWords, "页面里有说明性字样").toEqual([]);
  expect(designProblems, "交稿里的 DESIGN.md 没通过检查").toEqual([]);
}, 20 * 60_000);
