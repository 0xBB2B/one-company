import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readPrototypeBoard } from "../../../runtime/requirement-prototypes.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { startMainPoint } from "../helpers/point-main.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const PAUSE_MENU = "我要给游戏加一个暂停菜单：游戏中按 Esc 弹出半透明的黑色遮罩，屏幕中间竖排“继续游戏”和“回到标题”两个按钮，用方向键切换时选中的按钮高亮；" +
  "再按 Esc 或选“继续游戏”就关闭菜单。不做设置项。请整理成需求草稿给我确认，先不要开始实施。";

/** 交稿后程序会用 open 在浏览器里打开原型；换成只记下路径的脚本，免得跑验收时弹出浏览器。 */
async function stubOpen() {
  const dir = await mkdtemp(join(tmpdir(), "pt-open-"));
  await writeFile(join(dir, "open"), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${join(dir, "opened.txt")}'\n`);
  await chmod(join(dir, "open"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path ?? ""}`;
  return async () => { process.env.PATH = path; await rm(dir, { recursive: true, force: true }); };
}

test.skipIf(!config || process.platform !== "darwin")("P13：用户提一个带界面的需求、要求先出草稿，主代理存好草稿后派原型设计师出原型", async () => {
  cleanups.push(await stubOpen());
  const point = await startMainPoint(config!, "p13");
  let judgement: unknown = null;
  cleanups.push(() => point.close(judgement));
  const dispatched = () => {
    const calls = point.calls(0), results = point.results(0).filter((result) => result.tool === "one_company_prototype");
    const prototypeCalls = calls.filter((call) => call.name === "one_company_prototype");
    return prototypeCalls.some((call, index) => (call.args.request as { action?: string } | undefined)?.action === "dispatch" && results[index]?.isError === false);
  };
  await point.say(PAUSE_MENU);
  if (!dispatched()) await point.say("按你的推荐继续。");
  const requirements = point.requirements();
  const boards = await Promise.all(requirements.map((item) => readPrototypeBoard(point, item.requirementId)));
  judgement = { requirements: requirements.length, dispatched: dispatched(), boards,
    calls: point.calls(0).map((call) => ({ name: call.name, args: call.args })),
    prototypeResults: point.results(0).filter((result) => result.tool === "one_company_prototype"),
    dialogs: point.host.dialogs.map((dialog) => dialog.title) };
  expect(requirements.length, "主代理没有保存需求草稿").toBeGreaterThan(0);
  expect(dispatched(), JSON.stringify(judgement)).toBe(true);
}, 20 * 60_000);
