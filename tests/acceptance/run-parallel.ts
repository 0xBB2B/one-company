import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const vitest = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "vitest");
const STAGGER_MS = 20_000, IDLE_MS = 10 * 60_000;

let repeat = 1;
const only: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--repeat") repeat = Number(args[++i]);
  else if (args[i] === "--only") while (args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) only.push(args[++i]!);
  else throw new Error(`不认识的参数：${args[i]}；可用 --repeat <次数>、--only <编号…>`);
}
if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat 须为正整数");
const output = process.env.ONE_COMPANY_ACCEPTANCE_OUTPUT;
if (!process.env.ONE_COMPANY_ACCEPTANCE_MODEL || !output) throw new Error("须先设置 ONE_COMPANY_ACCEPTANCE_MODEL 与 ONE_COMPANY_ACCEPTANCE_OUTPUT");
mkdirSync(output, { recursive: true });

const listFile = join(output, "tests.json");
execFileSync(vitest, ["list", "tests/acceptance", `--json=${listFile}`], { stdio: "ignore" });
// 用例名冒号前是编号，如“M9-AC2/AC3/AC11”；--only M9-AC2 只认第一个编号，不会误配 M9-AC12
const idOf = (name: string) => name.split("：")[0]!;
const all = (JSON.parse(readFileSync(listFile, "utf8")) as Array<{ name: string }>).map((test) => test.name);
const missing = only.filter((id) => !all.some((name) => idOf(name).split("/")[0] === id));
if (missing.length) throw new Error(`没有这些编号的验收：${missing.join("、")}`);
const tests = only.length ? all.filter((name) => only.includes(idOf(name).split("/")[0]!)) : all;

const summary = join(output, "summary.txt");
const log = (line: string) => { const text = `${new Date().toLocaleString("zh-CN", { hour12: false })} ${line}`; appendFileSync(summary, `${text}\n`); console.log(text); };
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const newest = (dir: string) => Math.max(0, ...readdirSync(dir, { recursive: true, encoding: "utf8" })
  .filter((path) => !path.endsWith("STOP")).map((path) => statSync(join(dir, path)).mtimeMs));

type Run = { id: string; n: number; dir: string; started: number; done: boolean };
const runs: Run[] = [];
const results: Array<Promise<{ run: Run; code: number; tests: string }>> = [];
log(`同时跑开始：${tests.length} 条 × ${repeat} 次`);
const watchdog = setInterval(() => {
  for (const run of runs.filter((r) => !r.done && existsSync(r.dir) && Date.now() - newest(r.dir) > IDLE_MS)) {
    for (const evidence of readdirSync(run.dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !existsSync(join(run.dir, e.name, "STOP")))) {
      writeFileSync(join(run.dir, evidence.name, "STOP"), "");
      log(`看门狗：${run.id} 第 ${run.n} 次 10 分钟没有任何更新，已放 STOP`);
    }
  }
}, 60_000);

for (let n = 1; n <= repeat; n++) {
  for (const name of tests) {
    if (runs.length) await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
    const id = idOf(name), dir = join(output, `${id.replaceAll("/", "_")}-${n}`);
    mkdirSync(dir, { recursive: true });
    const run: Run = { id, n, dir, started: Date.now(), done: false };
    runs.push(run);
    const out = openSync(`${dir}.log`, "w");
    const child = spawn(vitest, ["run", "tests/acceptance", "-t", `^${escape(name)}$`], { env: { ...process.env, ONE_COMPANY_ACCEPTANCE_OUTPUT: dir }, stdio: ["ignore", out, out] });
    results.push(new Promise((resolve) => child.on("close", (code) => {
      run.done = true;
      closeSync(out);
      const tests = [...readFileSync(`${dir}.log`, "utf8").matchAll(/^\s+Tests\s+(.+)$/gmu)].at(-1)?.[1]?.trim() ?? "没有测试结果";
      log(`${id} 第 ${n} 次 用时 ${Math.round((Date.now() - run.started) / 60_000)} 分钟 退出码 ${code} | ${tests}`);
      resolve({ run, code: code ?? 1, tests });
    })));
  }
}
const finished = await Promise.all(results);
clearInterval(watchdog);
const failed = finished.filter((r) => r.code !== 0 || !/1 passed/u.test(r.tests));
log(`同时跑结束：通过 ${finished.length - failed.length} / ${finished.length}${failed.length ? `；失败：${failed.map((r) => `${r.run.id} 第 ${r.run.n} 次`).join("、")}` : ""}`);
process.exit(failed.length ? 1 : 0);
