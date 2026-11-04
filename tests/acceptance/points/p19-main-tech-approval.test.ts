import { afterEach, expect, test } from "vitest";
import { RequirementService } from "../../../src/modules/requirement/requirement-service.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { startMainPoint } from "../helpers/point-main.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const DRAFT_ONLY = "请整理成需求草稿给我确认，先不要开始实施。";
const LIBRARY = "做一个网页版的图书馆借还系统，要有借书、还书、查书的页面、后端接口和保存借阅记录的数据库。";
const SPRINT = "我要给角色加快跑：按住 Shift 并按方向键时，水平速度变为行走速度的 1.5 倍；松开 Shift 立即恢复行走速度；角色在空中时按 Shift 不改变水平速度。不做体力值，不改跳跃。";
const TECH_TITLE = "要引入的新技术";
const SOURCES = ["用户点名", "项目规范", "AI 提议"];

type Point = Awaited<ReturnType<typeof startMainPoint>>;
const techWindows = (point: Point) => point.host.dialogs.filter((dialog) => dialog.message?.includes(TECH_TITLE));
const items = (text: string) => [...text.matchAll(/^ \d+\. (.+?) {2}(\S+) · (.+)$/gmu)].map(([, name, kind, source]) => ({ name: name!, kind: kind!, source: source!.trim() }));

async function implementationSection(point: Point): Promise<string> {
  const service = await RequirementService.open({ repositoryRoot: point.repo, dataRoot: point.dataRoot, repoId: point.repoId, authorize: () => true });
  const requirement = point.requirements()[0];
  if (!requirement) return "";
  const { body } = await service.read({ requirementId: requirement.requirementId, source: "saved" });
  return body.match(/^##[^\n]*\{#implementation\}[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/mu)?.[1] ?? "";
}

test.skipIf(!config || process.platform !== "darwin")("P19：要做一个需要前端、后端和数据库的新系统时，主代理请用户批准前弹技术清单窗口；用户全部同意后，草稿「实现」板块写进清单里每一项", async () => {
  const point = await startMainPoint(config!, "p19-new");
  let judgement: unknown = null;
  cleanups.push(() => point.close(judgement));
  await point.say(LIBRARY + DRAFT_ONLY);
  const written = async () => {
    const last = techWindows(point).at(-1), implementation = await implementationSection(point);
    return last !== undefined && items(last.message!).every((item) => implementation.includes(item.name));
  };
  // 主代理答完还没弹清单或还没写进草稿时，像真人一样催一次，最多两次
  for (let n = 0; n < 2 && !(await written()); n++) await point.say("请接着整理需求草稿。");
  const shown = techWindows(point), listed = shown.length ? items(shown.at(-1)!.message!) : [];
  const implementation = await implementationSection(point);
  judgement = { windows: shown.map((dialog) => ({ answer: dialog.answer, text: dialog.message })), listed, implementation,
    calls: point.calls(0).map((call) => `${call.name}:${String((call.args.request as { action?: string } | undefined)?.action ?? call.args.action ?? "")}`) };
  expect(shown.length, JSON.stringify(judgement)).toBeGreaterThan(0);
  expect(shown.at(-1)!.answer, JSON.stringify(judgement)).toBe("全部同意");
  expect(listed.some((item) => item.kind === "框架"), JSON.stringify(judgement)).toBe(true);
  expect(listed.some((item) => item.kind === "数据库"), JSON.stringify(judgement)).toBe(true);
  for (const item of listed) expect(SOURCES, JSON.stringify(item)).toContain(item.source);
  for (const item of listed) expect(implementation, `${item.name}：${JSON.stringify(judgement)}`).toContain(item.name);
}, 30 * 60_000);

test.skipIf(!config || process.platform !== "darwin")("P19：需求只用项目里已有的技术时（样例项目已有的 TypeScript 移动逻辑上加快跑），不弹技术清单窗口", async () => {
  const point = await startMainPoint(config!, "p19-existing");
  let judgement: unknown = null;
  cleanups.push(() => point.close(judgement));
  await point.say(SPRINT + DRAFT_ONLY);
  judgement = { windows: point.host.dialogs.map((dialog) => dialog.title), drafted: point.requirements().length };
  expect(point.requirements().length, JSON.stringify(judgement)).toBeGreaterThan(0);
  expect(techWindows(point), JSON.stringify(judgement)).toEqual([]);
}, 20 * 60_000);
