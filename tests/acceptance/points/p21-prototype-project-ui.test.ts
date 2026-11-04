import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { registerProtocolHandlers } from "../../../src/app/daemon/run-manager.ts";
import { readPrototypeBoard } from "../../../src/modules/requirement/requirement-prototypes.ts";
import { createPmRunWorld } from "../../helpers/run-manager-fixture.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { pointEvidence } from "../helpers/point-pm.ts";
import { createRealModel } from "../helpers/real-model.ts";
import { designChapters } from "../../../src/modules/requirement/design-spec.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const NAME = "设置页每日提醒";
const BRIEF = "在设置页里加一个\"每日提醒时间\"设置项：管理员选一个时间，每天这个时间给成员发提醒；保存时要等待，保存可能失败。";
const PROJECT_FILES: Record<string, string> = {
  "src/layout/AppShell.html": '<header class="topbar"><nav><a>工作台</a><a>订单</a><a>客户</a><a class="active">设置</a></nav></header>\n<main class="content"><slot></slot></main>\n',
  "src/styles/tokens.css": ":root { --color-primary: #0f766e; --color-text: #1f2933; --radius: 6px; --space: 8px; }\n",
  "src/pages/settings.html": "<section><h2>账号安全</h2><p>修改密码、绑定手机</p></section>\n<section><h2>通知</h2><p>邮件通知、站内信</p></section>\n",
};
const LAYOUT_WORDS = ["工作台", "订单", "客户", "设置", "账号安全", "通知"];
type Handler = (params: Record<string, unknown>, client: unknown) => Promise<Record<string, unknown>>;
interface Submitted { html?: string; design?: string | string[] }

test.skipIf(!config || process.platform !== "darwin")("P21：样例项目已有整体布局和样式，原型设计师交的稿带着现有导航、已有页面内容和主题色", async () => {
  const evidence = await pointEvidence(config!, "p20");
  const w = await createPmRunWorld(cleanups);
  for (const [path, content] of Object.entries(PROJECT_FILES)) {
    await mkdir(dirname(join(w.fixture.repositoryRoot, path)), { recursive: true });
    await writeFile(join(w.fixture.repositoryRoot, path), content);
  }
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
  await handlers.get("prototypes.dispatch")!({ requirementId: w.fixture.requirementId, name: NAME, brief: BRIEF, maxTurns: 20, model: { provider: "team-model", id: "test" }, thinking: "off" }, client);

  const ref = { dataRoot: w.fixture.dataRoot, repoId: w.fixture.repoId };
  const status = async () => (await readPrototypeBoard(ref, w.fixture.requirementId)).entries.find((entry) => entry.name === NAME)?.inFlight?.status;
  for (let waited = 0; waited < 900 && await status() !== "awaiting"; waited++) await new Promise((resolve) => setTimeout(resolve, 1_000));

  const submits = real.toolCalls().filter((block) => block.name === "one_company_result_submit").map((block) => block.arguments as Submitted);
  const last = submits.at(-1);
  const html = last?.html ?? "";
  const missingWords = LAYOUT_WORDS.filter((word) => !html.includes(word));
  const hasPrimary = /#0f766e/i.test(html);
  const design = last?.design === undefined ? "" : [last.design].flat()[0] ?? "";
  const lightSection = (designChapters(design).get("颜色") ?? "").split(/^### /m).find((part) => part.startsWith("明亮")) ?? "";
  const lightPrimary = /^- 主色[：:]\s*(\S+)/m.exec(lightSection)?.[1] ?? null;
  await writeFile(join(evidence, "judgement.json"), `${JSON.stringify({ realTurns: turns, status: await status(), submits: submits.length, missingWords, hasPrimary, lightPrimary,
    calls: real.toolCalls().map((block) => block.name) }, null, 2)}\n`, { mode: 0o600 });
  expect(turns, "真实模型没有被调用：设计师没有派出").toBeGreaterThan(0);
  expect(await status(), "交稿没有被收下").toBe("awaiting");
  expect(missingWords, "稿子里缺现有布局或页面里的字").toEqual([]);
  expect(hasPrimary, "稿子里没有用现有主题色").toBe(true);
  expect(lightPrimary?.toLowerCase(), "DESIGN.md 明亮一节的主色不是项目主色").toBe("#0f766e");
}, 20 * 60_000);
