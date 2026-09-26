import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const root = new URL("../", import.meta.url);
const expectedPolicy = {
  "@google/genai@2.21.0": false,
  "esbuild@0.28.2": false,
  "protobufjs@7.6.6": false,
};

function parseAllowBuilds(source: string): Record<string, boolean> {
  const policy: Record<string, boolean> = {};
  let inAllowBuilds = false;

  for (const line of source.split(/\r?\n/u)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line === "allowBuilds:") {
      if (inAllowBuilds) throw new Error("duplicate allowBuilds section");
      inAllowBuilds = true;
      continue;
    }
    const entry = line.match(/^  (?:'([^']+)'|([^':][^:]*)): (true|false)$/u);
    if (!inAllowBuilds || !entry) throw new Error(`unexpected pnpm policy entry: ${line}`);
    const name = entry[1] ?? entry[2];
    if (name in policy) throw new Error(`duplicate build policy: ${name}`);
    policy[name] = entry[3] === "true";
  }

  if (!inAllowBuilds) throw new Error("missing allowBuilds section");
  return policy;
}

test("依赖安装脚本按精确版本显式拒绝且没有默认放宽", async () => {
  const source = await readFile(new URL("pnpm-workspace.yaml", root), "utf8");
  const policy = parseAllowBuilds(source);

  expect(policy).toEqual(expectedPolicy);
  expect(Object.values(policy)).toEqual([false, false, false]);
  expect(source).not.toMatch(/^\s*(?:dangerouslyAllowAllBuilds|strictDepBuilds|ignoreScripts):/mu);
});

test("拒绝安装脚本后使用当前平台 esbuild 二进制完成内存转换", async () => {
  const requireFromTest = createRequire(import.meta.url);
  const requireFromVitest = createRequire(requireFromTest.resolve("vitest"));
  const requireFromVite = createRequire(requireFromVitest.resolve("vite"));
  const esbuildEntry = requireFromVite.resolve("esbuild");
  const requireFromEsbuild = createRequire(esbuildEntry);
  const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
  const binarySubpath = process.platform === "win32" ? "esbuild.exe" : "bin/esbuild";
  const binaryPath = requireFromEsbuild.resolve(`${platformPackage}/${binarySubpath}`);

  expect((await stat(binaryPath)).isFile()).toBe(true);
  const probe = `
import { pathToFileURL } from "node:url";
const { transform } = await import(pathToFileURL(process.argv[1]).href);
const result = await transform("export const answer: number = 21 * 2;", { format: "esm", loader: "ts" });
const output = await import(\`data:text/javascript;base64,\${Buffer.from(result.code).toString("base64")}\`);
console.log(JSON.stringify({ answer: output.answer, warnings: result.warnings.length }));
`;
  const nodeArgs = ["--input-type=module", "-e", probe, esbuildEntry];
  const command = process.platform === "darwin" ? "/usr/bin/sandbox-exec" : process.execPath;
  const args = process.platform === "darwin"
    ? ["-p", "(version 1)(allow default)(deny network*)", process.execPath, ...nodeArgs]
    : nodeArgs;
  const { stdout } = await promisify(execFile)(command, args, {
    cwd: fileURLToPath(root),
    env: { ...process.env, ESBUILD_BINARY_PATH: binaryPath },
  });

  expect(JSON.parse(stdout)).toEqual({ answer: 42, warnings: 0 });
});
