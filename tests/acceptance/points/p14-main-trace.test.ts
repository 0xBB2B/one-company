import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { uuidv7 } from "../../../src/core/storage/database.ts";
import { acceptanceConfig } from "../helpers/installed-host.ts";
import { startMainPoint } from "../helpers/point-main.ts";

const exec = promisify(execFile);
const config = acceptanceConfig();
const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

const PRD_ID = uuidv7();
const ARCHIVE = `docs/prd/${PRD_ID}.登录页加上验证码登录.md`;
const LOGIN = [
  "export const CODE_TTL_MS = 5 * 60_000;",
  "",
  "export function isCodeExpired(issuedAt: number, now: number): boolean {",
  "  return now - issuedAt > CODE_TTL_MS;",
  "}",
  "",
].join("\n");
const PRD_REASON = "过期太久会被转发或截屏后冒用";
const PRD = `# 登录页加上验证码登录\n\n验证码 5 分钟过期。原因：验证码走短信发送，${PRD_REASON}，太短则用户来不及收短信填写。\n`;

test.skipIf(!config || process.platform !== "darwin")("P14：提交只有标题、正文为空，但新增了 docs/prd 归档，问代码为什么这样写时主代理读归档并说出需求编号", async () => {
  const point = await startMainPoint(config!, "p14", { seed: async ({ repo }) => {
    for (const [path, text] of [["src/login.ts", LOGIN], [ARCHIVE, PRD]] as const) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), text);
    }
    await exec("git", ["add", "src/login.ts", ARCHIVE], { cwd: repo });
    await exec("git", ["-c", "user.name=sample", "-c", "user.email=sample@localhost", "commit", "-qm", "fix login"], { cwd: repo });
  } });
  let judgement: unknown = null;
  cleanups.push(() => point.close(judgement));
  const since = point.host.session.messages.length;
  await point.say("src/login.ts 里验证码为什么 5 分钟过期？依据是什么？");
  const calls = point.calls(since);
  const results = point.results(since);
  const readArchive = results.some((result) => result.text.includes(PRD_REASON));
  const final = point.host.session.messages.slice(since).filter((message) => message.role === "assistant").at(-1);
  const answer = final && final.role === "assistant" ? final.content.map((block) => block.type === "text" ? block.text : "").join("") : "";
  judgement = { prdId: PRD_ID, readArchive, calls, answer: answer.slice(0, 1200) };
  expect(readArchive, JSON.stringify(calls)).toBe(true);
  expect(answer).toContain(PRD_ID);
}, 40 * 60_000);
