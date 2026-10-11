import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

/** 测试专用Node预加载探针：拦截daemon对docs/prod、需求正文与会话目录的读取并计数，退出时落盘。 */
const reportPath = process.env.M3_ASSEMBLY_PROBE;
const repositoryRoot = process.env.M3_ASSEMBLY_REPOSITORY;
if (reportPath && repositoryRoot) {
  const write = fs.writeFileSync.bind(fs);
  const report = { pid: process.pid, node: process.execPath, nodeVersion: process.version, forbiddenReads: 0, exited: false };
  const publish = () => {
    const temporary = `${reportPath}.tmp`;
    write(temporary, JSON.stringify(report), { mode: 0o600 });
    fs.renameSync(temporary, reportPath);
  };
  const check = (input: unknown) => {
    if (typeof input === "number") return;
    const path = input instanceof URL ? fileURLToPath(input) : String(input);
    if (path.includes("/docs/prod/") || path.includes("/requirements/") || path.includes("/sessions/")) {
      report.forbiddenReads++;
      publish();
      throw new Error("M3 assembly probe: forbidden body read");
    }
  };
  for (const [target, names] of [[fs, ["readFile", "readFileSync", "open", "openSync", "createReadStream"]],
    [fsp, ["readFile", "open"]]] as const) {
    const methods = target as unknown as Record<string, unknown>;
    for (const name of names) {
      const original = methods[name] as (...args: unknown[]) => unknown;
      methods[name] = (...args: unknown[]) => { check(args[0]); return Reflect.apply(original, target, args); };
    }
  }
  syncBuiltinESMExports();
  process.once("exit", () => { report.exited = true; publish(); });
  publish();
}
