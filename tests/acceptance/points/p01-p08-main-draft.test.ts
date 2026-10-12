import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { startMainPoint } from "../helpers/point-main.ts";

const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const SPRINT = "我要给角色加快跑：按住 Shift 并按方向键时，水平速度变为行走速度的 1.5 倍；松开 Shift 立即恢复行走速度；角色在空中时按 Shift 不改变水平速度。不做体力值，不改跳跃。";
const DRAFT_ONLY = "请整理成需求草稿给我确认，先不要开始实施。";
const APPROVE = "需求草稿我看过了，内容正确，批准这一版。";

test.skipIf(!config || process.platform !== "darwin")("P1：主代理存好草稿后，用户说批准这一版，解释器把原话解读成确认，批准登记生效", async () => {
  const point = await startMainPoint(config!, "p1");
  let judgement: unknown = null;
  cleanups.push(() => point.close(judgement));
  await point.say(SPRINT + DRAFT_ONLY);
  const drafted = point.requirements().length;
  const approved = () => point.requirements().some((item) => item.lifecycle === "active" && item.revision >= 1);
  let approvals = 0;
  // 主代理答完还没登记成功时，像真人一样再说一次，最多三次
  for (; approvals < 3 && drafted > 0 && !approved(); approvals++) await point.say(APPROVE);
  judgement = { drafted, approvals, requirements: point.requirements().map((item) => ({ lifecycle: item.lifecycle, revision: item.revision })) };
  expect(drafted, "主代理没有保存需求草稿").toBeGreaterThan(0);
  expect(approved(), JSON.stringify(judgement)).toBe(true);
}, 20 * 60_000);

test.skipIf(!config || process.platform !== "darwin")("P8：用户在需求里顺带定了一条长期规范，主代理把它提交为项目规范，弹出写入 AGENTS.md 的窗口", async () => {
  const point = await startMainPoint(config!, "p8");
  let judgement: unknown = null;
  cleanups.push(() => point.close(judgement));
  await point.say(SPRINT + "另外定一条项目规范：以后导出的常量一律用大写字母加下划线命名。" + DRAFT_ONLY);
  const windows = point.host.dialogs.filter((dialog) => dialog.title === "把这些改动写入项目规范 AGENTS.md？");
  const conventions = await readFile(join(point.repo, "AGENTS.md"), "utf8").catch(() => null);
  judgement = { windows: windows.map((dialog) => dialog.answer), conventions, calls: point.calls(0).map((call) => `${call.name}:${String(call.args.action ?? "")}`) };
  expect(windows.length, JSON.stringify(judgement)).toBeGreaterThan(0);
  expect(conventions, JSON.stringify(judgement)).toMatch(/大写|upper_?case|UPPER_SNAKE|SCREAMING_SNAKE/i);
}, 20 * 60_000);
