import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  GitPrerequisiteError,
  assertGitCurrent,
  checkGitVersion,
  parseMacOsAdminGroup,
  readMacOsAdminGroup,
  resolveHostGit,
  type HostGitBinding,
} from "../runtime/git-prerequisite.mjs";

const productRoot = fileURLToPath(new URL("../", import.meta.url));
const modulePath = fileURLToPath(new URL("../runtime/git-prerequisite.mjs", import.meta.url));
const temporaryRoots: string[] = [];

async function temporaryRoot(name: string) {
  const root = await mkdtemp(join(homedir(), `.pi-company-git-${name}-`));
  temporaryRoots.push(root);
  await chmod(root, 0o755);
  return root;
}

async function fakeGit(source: string, name = "valid") {
  const root = await temporaryRoot(name);
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o755 });
  const executable = join(bin, process.platform === "win32" ? "git.exe" : "git");
  await writeFile(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  await chmod(executable, 0o755);
  return { root, bin, executable };
}

function expectCode(action: () => unknown, code: string) {
  try {
    action();
    throw new Error("expected Git prerequisite failure");
  } catch (error) {
    expect(error).toBeInstanceOf(GitPrerequisiteError);
    expect((error as GitPrerequisiteError).code).toBe(code);
    expect((error as Error).message).toContain("必须预先安装Git并确保PATH可用");
    expect((error as Error).message.length).toBeLessThan(160);
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("共享 Git 前置检查", () => {
  test("从可信绝对 PATH 建立不可由 JSON 冒充的绑定并返回实际版本", async () => {
    const fake = await fakeGit(`
if (process.env.GIT_CONFIG_GLOBAL || process.env.LD_PRELOAD || process.env.DYLD_INSERT_LIBRARIES || process.env.SSH_AUTH_SOCK) {
  process.stderr.write("injected environment");
  process.exit(9);
}
process.stdout.write("git version 2.55.0\\n");`);
    const previous = {
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      LD_PRELOAD: process.env.LD_PRELOAD,
      DYLD_INSERT_LIBRARIES: process.env.DYLD_INSERT_LIBRARIES,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    };
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: "/untrusted/gitconfig",
      LD_PRELOAD: "/untrusted/loader",
      DYLD_INSERT_LIBRARIES: "/untrusted/dylib",
      SSH_AUTH_SOCK: "/untrusted/agent",
    });
    try {
      const binding = resolveHostGit({ path: fake.bin });
      expect(binding.entryPath).toBe(fake.executable);
      expect(binding.target.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(binding.directories.length).toBeGreaterThan(1);
      expect(checkGitVersion(binding).version).toBe("2.55.0");
      const serialized = JSON.parse(JSON.stringify(binding)) as HostGitBinding;
      expectCode(() => assertGitCurrent(serialized), "git_binding_untrusted");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("忽略空、相对及 node_modules/.bin PATH 项", async () => {
    const fake = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "path-filter");
    const moduleBin = join(fake.root, "node_modules", ".bin");
    await mkdir(moduleBin, { recursive: true, mode: 0o755 });
    await writeFile(join(moduleBin, process.platform === "win32" ? "git.exe" : "git"), await readFile(fake.executable), { mode: 0o755 });
    expectCode(
      () => resolveHostGit({ path: ["", "relative-bin", moduleBin].join(delimiter) }),
      "git_not_found",
    );
  });

  test("排除可信调用方提供的业务根，且不把目录候选当 Git", async () => {
    const fake = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "excluded");
    expectCode(() => resolveHostGit({ path: fake.bin, excludedRoots: [fake.root] }), "git_not_found");

    const root = await temporaryRoot("directory-candidate");
    const bin = join(root, "bin");
    await mkdir(join(bin, process.platform === "win32" ? "git.exe" : "git"), { recursive: true });
    expectCode(() => resolveHostGit({ path: bin }), "git_unsafe");
  });

  test.skipIf(process.platform === "win32")("保留可信文件及目录链接，并绑定目录链接身份", async () => {
    const target = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "trusted-link-target");
    const entryRoot = await temporaryRoot("trusted-directory-link");
    const aliasBin = join(entryRoot, "alias-bin");
    await symlink(target.bin, aliasBin);
    const binding = resolveHostGit({ path: aliasBin });
    expect(binding.canonicalEntryDirectory).toBe(target.bin);
    expect(binding.directoryLinks.some((link) => link.path === aliasBin && link.type === "symlink")).toBe(true);
    expect(checkGitVersion(binding).version).toBe("9.9.9");

    await unlink(aliasBin);
    await symlink(target.bin, aliasBin);
    expectCode(() => assertGitCurrent(binding), "git_changed");
  });

  test.skipIf(process.platform === "win32")("拒绝符号链接到被排除根内的目标或 canonical PATH 目录", async () => {
    const target = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "symlink-target");
    const entryRoot = await temporaryRoot("symlink-entry");
    const entryBin = join(entryRoot, "bin");
    await mkdir(entryBin, { mode: 0o755 });
    await symlink(target.executable, join(entryBin, "git"));
    expectCode(() => resolveHostGit({ path: entryBin, excludedRoots: [target.root] }), "git_unsafe");

    const businessRoot = await temporaryRoot("canonical-excluded");
    const businessBin = join(businessRoot, "node_modules", ".bin");
    await mkdir(businessBin, { recursive: true, mode: 0o755 });
    await symlink(target.executable, join(businessBin, "git"));
    const aliasRoot = await temporaryRoot("canonical-alias");
    const aliasBin = join(aliasRoot, "bin");
    await symlink(businessBin, aliasBin);
    expectCode(() => resolveHostGit({ path: aliasBin, excludedRoots: [businessRoot] }), "git_unsafe");
  });

  test.skipIf(process.platform === "win32")("坏目录链接循环有界拒绝", async () => {
    const root = await temporaryRoot("directory-loop");
    const loop = join(root, "loop");
    await symlink(loop, loop);
    const started = Date.now();
    expectCode(() => resolveHostGit({ path: loop }), "git_unsafe");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("拒绝组或全局可写二进制和目录", async () => {
    const writableBinary = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "writable-binary");
    await chmod(writableBinary.executable, 0o775);
    expectCode(() => resolveHostGit({ path: writableBinary.bin }), "git_unsafe");

    const writableDirectory = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "writable-directory");
    await chmod(writableDirectory.bin, 0o777);
    expectCode(() => resolveHostGit({ path: writableDirectory.bin }), "git_unsafe");

    if (process.platform === "darwin") {
      const ordinaryGroupDirectory = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "ordinary-group");
      await chmod(ordinaryGroupDirectory.bin, 0o775);
      expectCode(() => resolveHostGit({ path: ordinaryGroupDirectory.bin }), "git_unsafe");
    }
  });

  test.skipIf(process.platform === "win32")("链接到 FIFO 及预检后替换 FIFO 均快速拒绝且子进程自行收尾", async () => {
    const fifoRoot = await temporaryRoot("fifo-target");
    const fifoBin = join(fifoRoot, "bin");
    await mkdir(fifoBin, { mode: 0o755 });
    const fifo = join(fifoBin, "git");
    expect(spawnSync("/usr/bin/mkfifo", [fifo]).status).toBe(0);
    const entryRoot = await temporaryRoot("fifo-entry");
    const entryBin = join(entryRoot, "bin");
    await mkdir(entryBin, { mode: 0o755 });
    await symlink(fifo, join(entryBin, "git"));

    const importUrl = pathToFileURL(modulePath).href;
    const direct = spawnSync(process.execPath, ["--input-type=module", "-e", `
import { resolveHostGit } from ${JSON.stringify(importUrl)};
try { resolveHostGit({ path: process.argv[1] }); process.exit(91); }
catch (error) { process.stdout.write(String(error.code)); process.exit(error.code === "git_unsafe" ? 0 : 92); }
`, entryBin], { encoding: "utf8", timeout: 2_000 });
    expect(direct.error).toBeUndefined();
    expect(direct.status, direct.stderr).toBe(0);
    expect(direct.stdout).toBe("git_unsafe");

    const race = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "fifo-race");
    const raced = spawnSync(process.execPath, ["--input-type=module", "-e", `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { resolveHostGit } from ${JSON.stringify(importUrl)};
const fdRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
const before = fs.readdirSync(fdRoot).length;
const originalOpen = fs.openSync;
const target = process.argv[1] + "/git";
let replaced = false, code;
fs.openSync = function(path, ...args) {
  if (path === target && !replaced) {
    replaced = true;
    fs.unlinkSync(target);
    const made = spawnSync("/usr/bin/mkfifo", [target]);
    if (made.status !== 0) throw new Error("mkfifo failed");
  }
  return Reflect.apply(originalOpen, this, [path, ...args]);
};
syncBuiltinESMExports();
try {
  resolveHostGit({ path: process.argv[1] });
  code = "unexpected_success";
} catch (error) { code = error.code; }
finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
if (!replaced) process.exit(94);
const after = fs.readdirSync(fdRoot).length;
process.stdout.write(JSON.stringify({ code, before, after }));
process.exit(code === "git_unsafe" && after <= before ? 0 : 93);
`, race.bin], { encoding: "utf8", timeout: 2_000 });
    expect(raced.error).toBeUndefined();
    expect(raced.status, raced.stderr).toBe(0);
    expect(JSON.parse(raced.stdout)).toMatchObject({ code: "git_unsafe" });
  });

  test.skipIf(process.platform === "win32")("完整Git文件多跳链和中间目录链接均绑定，重建同目标也失效", async () => {
    const target = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "full-link-target");
    const root = await temporaryRoot("full-link-chain");
    const entry = join(root, "entry"), middle = join(root, "middle"), alias = join(root, "alias");
    await mkdir(entry); await mkdir(middle);
    await symlink(target.bin, alias);
    await symlink(join(alias, "git"), join(middle, "git"));
    await symlink(join(middle, "git"), join(entry, "git"));
    const binding = resolveHostGit({ path: entry });
    expect(checkGitVersion(binding).version).toBe("9.9.9");
    expect(binding.fileLinks.map((link) => link.path)).toContain(join(middle, "git"));
    expect(binding.directoryLinks.map((link) => link.path)).toContain(alias);
    await rm(join(middle, "git")); await symlink(join(alias, "git"), join(middle, "git"));
    expectCode(() => assertGitCurrent(binding), "git_changed");
    const next = resolveHostGit({ path: entry });
    await rm(alias); await symlink(target.bin, alias);
    expectCode(() => assertGitCurrent(next), "git_changed");
  });

  test.skipIf(process.platform === "win32")("中间业务根和中间或最终.bin不能由文件链接绕过", async () => {
    const target = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "excluded-chain-target");
    const root = await temporaryRoot("excluded-chain"), entry = join(root, "entry"), business = join(root, "business");
    await mkdir(entry); await mkdir(business);
    await symlink(target.executable, join(business, "git")); await symlink(join(business, "git"), join(entry, "git"));
    expectCode(() => resolveHostGit({ path: entry, excludedRoots: [business] }), "git_unsafe");
    await chmod(business, 0o777);
    expectCode(() => resolveHostGit({ path: entry }), "git_unsafe");
    const bin = join(root, "node_modules", ".bin"); await mkdir(bin, { recursive: true });
    await rm(join(entry, "git")); await symlink(join(bin, "git"), join(entry, "git"));
    await symlink(target.executable, join(bin, "git"));
    expectCode(() => resolveHostGit({ path: entry }), "git_unsafe");
    await rm(join(bin, "git")); await writeFile(join(bin, "git"), await readFile(target.executable), { mode: 0o755 });
    expectCode(() => resolveHostGit({ path: entry }), "git_unsafe");
  });

  test.skipIf(process.platform === "win32")("先解析目录链接再处理..，经过的排除目录不会被词法折叠跳过", async () => {
    const root = await temporaryRoot("dotdot-links"), entry = join(root, "entry"), actual = join(root, "real", "target");
    const deep = join(root, "real", "deep"), alias = join(root, "alias");
    await mkdir(entry); await mkdir(actual, { recursive: true }); await mkdir(deep);
    await writeFile(join(actual, "git"), `#!${process.execPath}\nprocess.stdout.write("git version 9.9.9\\n");\n`, { mode: 0o755 });
    await symlink(deep, alias); await symlink(`${alias}/../target/git`, join(entry, "git"));
    expect(checkGitVersion(resolveHostGit({ path: entry })).version).toBe("9.9.9");
    expectCode(() => resolveHostGit({ path: entry, excludedRoots: [deep] }), "git_unsafe");
  });

  test.skipIf(process.platform === "win32")("排除根的alias/..按真实语义解析，并在后续核验时重解原始路径", async () => {
    const source = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "excluded-root-source");
    const root = await temporaryRoot("excluded-root-alias");
    const actual = join(root, "actual"), other = join(root, "other"), lexical = join(root, "business");
    for (const parent of [actual, other]) { await mkdir(join(parent, "deep"), { recursive: true }); await mkdir(join(parent, "business")); }
    await mkdir(lexical);
    for (const bin of [join(actual, "business"), join(other, "business"), lexical]) {
      await writeFile(join(bin, "git"), await readFile(source.executable), { mode: 0o755 });
    }
    const alias = join(root, "alias"); await symlink(join(actual, "deep"), alias);
    const excluded = `${alias}/../business`;
    expectCode(() => resolveHostGit({ path: join(actual, "business"), excludedRoots: [excluded] }), "git_not_found");
    const current = resolveHostGit({ path: join(actual, "business") });
    expectCode(() => assertGitCurrent(current, [excluded]), "git_unsafe");
    const decoy = resolveHostGit({ path: lexical, excludedRoots: [excluded] });
    expect(checkGitVersion(decoy).version).toBe("9.9.9");
    expect(decoy.excludedRoots).toContain(join(actual, "business"));
    expect(decoy.excludedRoots).not.toContain(lexical);
    expect(decoy.excludedRootInputs).toContain(excluded);
    const changing = resolveHostGit({ path: join(other, "business"), excludedRoots: [excluded] });
    await rm(alias); await symlink(join(other, "deep"), alias);
    expectCode(() => assertGitCurrent(changing), "git_unsafe");
    const pending = resolveHostGit({ path: source.bin, excludedRoots: [`${alias}/../not-created/`] });
    expect(pending.excludedRoots).toContain(join(other, "not-created"));
    expectCode(() => resolveHostGit({ path: source.bin, excludedRoots: [`/bad${String.fromCharCode(0)}path`] }), "git_invalid_configuration");
  });

  test.skipIf(process.platform === "win32")("断链排除根不是普通缺失尾部，resolve与assert均明确拒绝", async () => {
    const target = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "dangling-excluded-target");
    const root = await temporaryRoot("dangling-excluded-root"), actual = join(root, "actual");
    await mkdir(actual);
    const dangling = join(root, "dangling");
    await symlink(join(actual, "not-created"), dangling);
    const binding = resolveHostGit({ path: target.bin });
    for (const excluded of [dangling, `${dangling}/`, `${dangling}/.`, `${dangling}/../business`, `${dangling}/../business/`]) {
      expectCode(() => resolveHostGit({ path: target.bin, excludedRoots: [excluded] }), "git_invalid_configuration");
      expectCode(() => assertGitCurrent(binding, [excluded]), "git_invalid_configuration");
    }
    const valid = resolveHostGit({ path: target.bin, excludedRoots: [join(actual, "new", "child")] });
    expect(checkGitVersion(valid).version).toBe("9.9.9");
    await mkdir(join(actual, "not-created"));
    const resolved = resolveHostGit({ path: target.bin, excludedRoots: [`${dangling}/../business`] });
    expect(resolved.excludedRoots).toContain(join(actual, "business"));
  });

  test("无关兄弟文件变更不废弃Git绑定，目录权限和测试选项仍严格拒绝", async () => {
    const fake = await fakeGit('process.stdout.write("git version 9.9.9\\n");', "sibling-change");
    const binding = resolveHostGit({ path: fake.bin });
    await writeFile(join(fake.root, "unrelated.txt"), "unrelated");
    expect(() => assertGitCurrent(binding)).not.toThrow();
    expect(checkGitVersion(binding).version).toBe("9.9.9");
    await rm(join(fake.root, "unrelated.txt"));
    expect(() => assertGitCurrent(binding)).not.toThrow();
    let callbackCalled = false;
    expectCode(() => resolveHostGit({ path: fake.bin, __testBeforeTargetOpen: () => { callbackCalled = true; } } as never), "git_invalid_configuration");
    expect(callbackCalled).toBe(false);
    await chmod(fake.bin, 0o777);
    expectCode(() => assertGitCurrent(binding), "git_unsafe");
  });

  test("macOS admin 组解析只接受恰好一条合法记录", () => {
    expect(parseMacOsAdminGroup("wheel:*:0:root\nadmin:*:80:root,user\n")).toBe(80);
    for (const contents of [
      "wheel:*:0:root\n",
      "admin:*:80:root\nadmin:*:80:user\n",
      "admin:*:80:root\nadmin:*:81:user\n",
      "admin:*:not-a-gid:root\n",
      "admin:*:2147483648:root\n",
      "admin:*:80\n",
    ]) expectCode(() => parseMacOsAdminGroup(contents), "git_unsafe");
    expectCode(() => readMacOsAdminGroup(() => { throw new Error("injected read failure"); }), "git_unsafe");
  });

  test("坏版本、超量输出和超时均返回固定有界错误", async () => {
    const invalid = await fakeGit('process.stdout.write("not git: attacker text\\n");', "invalid-output");
    expectCode(() => checkGitVersion(resolveHostGit({ path: invalid.bin })), "git_version_invalid");

    const excessive = await fakeGit('process.stdout.write("x".repeat(17 * 1024));', "excessive-output");
    expectCode(() => checkGitVersion(resolveHostGit({ path: excessive.bin })), "git_version_output_limit");

    const timeout = await fakeGit("setTimeout(() => process.stdout.write('git version 1.0.0\\n'), 6_000);", "timeout");
    expectCode(() => checkGitVersion(resolveHostGit({ path: timeout.bin })), "git_version_timeout");
  }, 10_000);

  test("运行中替换目标后拒绝结果，不沿 PATH 自动改选", async () => {
    const replacement = `#!${process.execPath}\nprocess.stdout.write("git version 8.8.8\\n");\n`;
    const fake = await fakeGit(`
require("node:fs").writeFileSync(process.argv[1], ${JSON.stringify(replacement)}, { mode: 0o755 });
process.stdout.write("git version 2.55.0\\n");`, "replacement");
    const binding = resolveHostGit({ path: fake.bin });
    expectCode(() => checkGitVersion(binding), "git_changed");
    expectCode(() => assertGitCurrent(binding), "git_changed");
  });

  test("CLI 缺 Git 时非零且不下载或安装", async () => {
    const root = await temporaryRoot("cli-missing");
    const bin = join(root, "empty-bin");
    await mkdir(bin, { mode: 0o755 });
    const before = await readFile(modulePath);
    const result = spawnSync(process.execPath, [modulePath, "--check"], {
      cwd: productRoot,
      env: { ...process.env, PATH: bin },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("必须预先安装Git并确保PATH可用");
    expect(result.stderr.length).toBeLessThan(200);
    expect(await readFile(modulePath)).toEqual(before);
  });

  test.skipIf(process.platform !== "darwin")("真实宿主 Git 通过绑定、版本和当前所需参数兼容检查", async () => {
    const binding = resolveHostGit();
    const checked = checkGitVersion(binding);
    expect(checked.version).toMatch(/^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:\.[0-9A-Za-z]+)*(?: \([0-9A-Za-z][0-9A-Za-z ._+():/-]{0,95}\))?$/u);
    const actual = spawnSync(binding.executablePath, ["--version"], {
      cwd: "/", env: { LANG: "C", LC_ALL: "C" }, encoding: "utf8", shell: false,
    });
    expect(actual.status, actual.stderr).toBe(0);
    expect(actual.stdout.trim()).toBe(`git version ${checked.version}`);
    const aliasRoot = await temporaryRoot("host-git-directory-alias");
    const aliasBin = join(aliasRoot, "bin");
    await symlink(dirname(binding.entryPath), aliasBin);
    const aliasBinding = resolveHostGit({ path: aliasBin });
    expect(checkGitVersion(aliasBinding).version).toBe(checked.version);
    console.log(JSON.stringify({
      hostGit: binding.executablePath,
      hostGitVersion: checked.version,
      directoryAlias: aliasBinding.entryPath,
    }));

    const root = await temporaryRoot("host-git-compatibility");
    const repository = join(root, "repo");
    const environment = { LANG: "C", LC_ALL: "C", HOME: join(root, "home") };
    await mkdir(environment.HOME, { mode: 0o700 });
    assertGitCurrent(binding);
    const initialized = spawnSync(binding.executablePath, ["-c", "core.hooksPath=/dev/null", "init", "-b", "main", repository], {
      cwd: "/", env: environment, encoding: "utf8", shell: false,
    });
    expect(initialized.status, initialized.stderr).toBe(0);
    assertGitCurrent(binding);
    const topLevel = spawnSync(binding.executablePath, ["-C", repository, "rev-parse", "--path-format=absolute", "--show-toplevel"], {
      cwd: "/", env: environment, encoding: "utf8", shell: false,
    });
    expect(topLevel.status, topLevel.stderr).toBe(0);
    expect(topLevel.stdout.trim()).toBe(repository);
    assertGitCurrent(binding);
  });
});
