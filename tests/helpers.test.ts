import { afterEach, describe, expect, test } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createTempHome, removeTempHome } from "./helpers/temp-home.ts";
import { registerControlledProvider, requestLog, scriptReplies } from "./helpers/controlled-provider.ts";
import {
  addWorktree,
  createRepoFixture,
  createWorkspaceFixture,
  removeRepoFixture,
} from "./helpers/repo-fixture.ts";
import { pressKeys, renderComponent } from "./helpers/virtual-terminal.ts";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function createRuntime(): Promise<ModelRuntime> {
  const modelsDir = await mkdtemp(join(tmpdir(), "pi-company-models-"));
  tempRoots.push(modelsDir);
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(modelsDir, "models.json"),
    refreshOnCreate: false,
  });
}

async function findNodeModulesGit(root: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(root, entry.name);
    if (entry.name === "node_modules") {
      const nested = await readdir(full, { withFileTypes: true });
      for (const candidate of nested) {
        if (candidate.isDirectory() && (await pathExists(join(full, candidate.name, ".git")))) {
          return join(full, candidate.name);
        }
      }
      continue;
    }
    const found = await findNodeModulesGit(full);
    if (found) return found;
  }
  return null;
}

describe("temp-home", () => {
  test("每次调用返回互不重复的目录", async () => {
    const a = await createTempHome();
    const b = await createTempHome();
    tempRoots.push(a.home, b.home);
    expect(a.home).not.toBe(b.home);
  });

  test("返回值包含 HOME / agentDir / 数据根路径 / 环境变量映射，agentDir 下有空 settings.json", async () => {
    const home = await createTempHome();
    tempRoots.push(home.home);
    expect(home.agentDir.startsWith(home.home)).toBe(true);
    expect(home.dataRoot).toBe(join(home.agentDir, "pi-company"));
    expect(home.env.HOME).toBe(home.home);
    const raw = await readFile(join(home.agentDir, "settings.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({});
  });

  test("HOME 不指向真实用户目录", async () => {
    const home = await createTempHome();
    tempRoots.push(home.home);
    expect(home.home).not.toBe(homedir());
  });

  test("env 不携带调用方进程环境中与 HOME 隔离无关的变量", async () => {
    const sentinelKey = "PI_COMPANY_TEST_SECRET";
    process.env[sentinelKey] = "真实凭据泄漏探针";
    try {
      const home = await createTempHome();
      tempRoots.push(home.home);
      expect(home.env[sentinelKey]).toBeUndefined();
    } finally {
      delete process.env[sentinelKey];
    }
  });

  test("removeTempHome 后目录不存在", async () => {
    const home = await createTempHome();
    await removeTempHome(home);
    expect(await pathExists(home.home)).toBe(false);
  });

  test("对不存在的目录再次调用 removeTempHome 不抛错", async () => {
    const home = await createTempHome();
    await removeTempHome(home);
    await expect(removeTempHome(home)).resolves.toBeUndefined();
  });
});

describe("controlled-provider", () => {
  test("脚本化文本回复按排队顺序被取出", async () => {
    const runtime = await createRuntime();
    const provider = registerControlledProvider(runtime, { providerId: "controlled-text", modelId: "controlled-model" });
    scriptReplies(provider, [{ type: "text", text: "第一条" }]);
    const model = runtime.getModel("controlled-text", "controlled-model");
    expect(model).toBeTruthy();
    const context = { messages: [{ role: "user", content: "hi" }] } as any;
    const stream = runtime.streamSimple(model!, context, {});
    const message = await stream.result();
    expect(message.content.some((c: any) => c.type === "text" && c.text === "第一条")).toBe(true);
  });

  test("思考、工具调用与连接失败依次按排队顺序取出", async () => {
    const runtime = await createRuntime();
    const provider = registerControlledProvider(runtime, { providerId: "controlled-multi", modelId: "controlled-model" });
    scriptReplies(provider, [
      { type: "thinking", text: "分析中" },
      { type: "toolcall", name: "read_file", input: { path: "a.txt" } },
      { type: "error", message: "连接失败" },
    ]);
    const model = runtime.getModel("controlled-multi", "controlled-model")!;
    const context = { messages: [{ role: "user", content: "hi" }] } as any;

    const first = await runtime.streamSimple(model, context, {}).result();
    expect(first.content.some((c: any) => c.type === "thinking")).toBe(true);

    const second = await runtime.streamSimple(model, context, {}).result();
    expect(second.content.some((c: any) => c.type === "toolCall")).toBe(true);

    const third = await runtime.streamSimple(model, context, {}).result();
    expect(third.stopReason).toBe("error");
  });

  test("requestLog 按收到顺序返回请求序列", async () => {
    const runtime = await createRuntime();
    const provider = registerControlledProvider(runtime, { providerId: "controlled-log", modelId: "controlled-model" });
    scriptReplies(provider, [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    const model = runtime.getModel("controlled-log", "controlled-model")!;
    await runtime.streamSimple(model, { messages: [{ role: "user", content: "第一次" }] } as any, {}).result();
    await runtime.streamSimple(model, { messages: [{ role: "user", content: "第二次" }] } as any, {}).result();
    const log = requestLog(provider);
    expect(log.length).toBe(2);
  });

  test("同一 providerId 在不同 runtime 上重复注册时，脚本与请求互不串扰", async () => {
    const runtimeA = await createRuntime();
    const providerA = registerControlledProvider(runtimeA, { providerId: "controlled-dup", modelId: "controlled-model" });
    scriptReplies(providerA, [{ type: "text", text: "来自 A" }]);

    const runtimeB = await createRuntime();
    const providerB = registerControlledProvider(runtimeB, { providerId: "controlled-dup", modelId: "controlled-model" });
    scriptReplies(providerB, [{ type: "text", text: "来自 B" }]);

    const modelA = runtimeA.getModel("controlled-dup", "controlled-model")!;
    const modelB = runtimeB.getModel("controlled-dup", "controlled-model")!;
    const context = { messages: [{ role: "user", content: "hi" }] } as any;
    const resultA = await runtimeA.streamSimple(modelA, context, {}).result();
    expect(resultA.content.some((c: any) => c.type === "text" && c.text === "来自 A")).toBe(true);
    const resultB = await runtimeB.streamSimple(modelB, context, {}).result();
    expect(resultB.content.some((c: any) => c.type === "text" && c.text === "来自 B")).toBe(true);
    expect(requestLog(providerA).length).toBe(1);
    expect(requestLog(providerB).length).toBe(1);
  });

  test("同一 runtime 重复注册同名 provider 抛出明确错误", async () => {
    const runtime = await createRuntime();
    registerControlledProvider(runtime, { providerId: "controlled-twice", modelId: "controlled-model" });
    expect(() => registerControlledProvider(runtime, { providerId: "controlled-twice", modelId: "controlled-model" })).toThrow(
      "controlled-twice",
    );
  });

  test("未排队时请求得到明确错误而不是挂起", async () => {
    const runtime = await createRuntime();
    registerControlledProvider(runtime, { providerId: "controlled-empty", modelId: "controlled-model" });
    const model = runtime.getModel("controlled-empty", "controlled-model")!;
    const context = { messages: [{ role: "user", content: "hi" }] } as any;
    const message = await Promise.race([
      runtime.streamSimple(model, context, {}).result(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("超时挂起")), 2000)),
    ]);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toBeTruthy();
  });
});

describe("repo-fixture", () => {
  test("createRepoFixture 得到含一次提交的 Git 仓库", async () => {
    const repo = await createRepoFixture();
    tempRoots.push(repo.root);
    const log = await execFileAsync("git", ["log", "--oneline"], { cwd: repo.root });
    expect(log.stdout.trim().split("\n").length).toBe(1);
    const status = await execFileAsync("git", ["status", "--porcelain"], { cwd: repo.root });
    expect(status.stdout.trim()).toBe("");
  });

  test("addWorktree 创建的 linked worktree 可被 git worktree list 看到", async () => {
    const repo = await createRepoFixture();
    tempRoots.push(repo.root);
    const worktree = await addWorktree(repo);
    tempRoots.push(worktree.root);
    const list = await execFileAsync("git", ["worktree", "list"], { cwd: repo.root });
    expect(list.stdout).toContain(worktree.root);
    expect(list.stdout).toContain(`[${worktree.branch}]`);
  });

  test("并发 addWorktree 不因分支名冲突而互相报错", async () => {
    const repo = await createRepoFixture();
    tempRoots.push(repo.root);
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => addWorktree(repo)));
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") tempRoots.push(outcome.value.root);
    }
    expect(settled.filter((outcome) => outcome.status === "rejected")).toEqual([]);
    const created = settled.flatMap((outcome) => outcome.status === "fulfilled" ? [outcome.value] : []);
    expect(new Set(created.map((worktree) => worktree.branch)).size).toBe(5);
    const listed = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: repo.root });
    for (const worktree of created) {
      expect(listed.stdout).toContain(`worktree ${worktree.root}`);
      expect(listed.stdout).toContain(`branch refs/heads/${worktree.branch}`);
    }
  });

  test("在全局开启 commit.gpgsign 的环境下仍能创建夹具", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "pi-company-gitconfig-"));
    tempRoots.push(configDir);
    const configPath = join(configDir, "gitconfig");
    await writeFile(configPath, "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = configPath;
    try {
      const repo = await createRepoFixture();
      tempRoots.push(repo.root);
      const log = await execFileAsync("git", ["log", "--oneline"], { cwd: repo.root });
      expect(log.stdout.trim().split("\n").length).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
  });

  test("removeRepoFixture 清理 addWorktree 创建的 worktree 目录", async () => {
    const repo = await createRepoFixture();
    tempRoots.push(repo.root);
    const worktree = await addWorktree(repo);
    await removeRepoFixture(repo);
    const stillExists = await pathExists(worktree.root);
    if (stillExists) tempRoots.push(worktree.root);
    expect(stillExists).toBe(false);
  });

  test("createWorkspaceFixture 生成含两个独立仓库与一个 node_modules 伪仓库的父目录", async () => {
    const workspace = await createWorkspaceFixture();
    tempRoots.push(workspace.root);
    const entries = await readdir(workspace.root, { withFileTypes: true });
    let realRepoCount = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && (await pathExists(join(workspace.root, entry.name, ".git")))) {
        realRepoCount += 1;
      }
    }
    expect(realRepoCount).toBeGreaterThanOrEqual(2);
    expect(await findNodeModulesGit(workspace.root)).not.toBeNull();
  });

  test("removeRepoFixture 也能清理工作区夹具", async () => {
    const workspace = await createWorkspaceFixture();
    await removeRepoFixture(workspace);
    expect(await pathExists(workspace.root)).toBe(false);
  });

  test("removeRepoFixture 后全部不存在", async () => {
    const repo = await createRepoFixture();
    tempRoots.push(repo.root);
    await removeRepoFixture(repo);
    expect(await pathExists(repo.root)).toBe(false);
  });

  test("removeRepoFixture 对已不存在的 fixture 不抛错", async () => {
    const repo = await createRepoFixture();
    tempRoots.push(repo.root);
    await removeRepoFixture(repo);
    await expect(removeRepoFixture(repo)).resolves.toBeUndefined();
  });
});

describe("virtual-terminal", () => {
  function makeWideComponent() {
    return {
      render(width: number): string[] {
        return ["超过宽度限制的一整行内容用来测试裁剪或换行行为".repeat(3)];
      },
    };
  }

  function makeWideAsciiComponent() {
    return {
      render(): string[] {
        return ["x".repeat(50)];
      },
    };
  }

  function makeTallComponent() {
    return {
      render(): string[] {
        return Array.from({ length: 10 }, (_, i) => `line-${i}`);
      },
    };
  }

  function makeStatefulComponent() {
    const pressed: string[] = [];
    return {
      render(width: number): string[] {
        return [pressed.join(",").slice(0, width)];
      },
      handleInput(key: string): void {
        pressed.push(key);
      },
    };
  }

  test("renderComponent 返回逐行文本且每行可见宽度不超过给定宽度", async () => {
    const width = 10;
    const lines = await renderComponent(makeWideComponent(), width, 3);
    expect(Array.isArray(lines)).toBe(true);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  test("pressKeys 依次投递按键并返回每次之后的渲染结果", async () => {
    const width = 20;
    const results = await pressKeys(makeStatefulComponent(), ["a", "b", "c"], width, 5);
    expect(results.length).toBe(3);
    for (const lines of results) {
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
    expect(results[0].join("\n")).toContain("a");
    expect(results[2].join("\n")).toContain("c");
  });

  test("renderComponent 返回的行不含终端转义序列且 ASCII 长行被裁到给定宽度", async () => {
    const width = 10;
    const lines = await renderComponent(makeWideAsciiComponent(), width, 3);
    expect(lines[0]).toBe("x".repeat(width));
    for (const line of lines) {
      expect(line).not.toContain("\x1b");
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  test("pressKeys 重绘覆盖旧行而非追加", async () => {
    const results = await pressKeys(makeStatefulComponent(), ["a", "b"], 20, 5);
    expect(results[1].join("\n")).toContain("a,b");
    expect(results[1].filter((line) => line === "a")).toEqual([]);
  });

  test("renderComponent 返回的行数不超过给定高度可显示的行数", async () => {
    const lines = await renderComponent(makeTallComponent(), 20, 3);
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  test("pressKeys 空按键数组时返回空结果", async () => {
    const results = await pressKeys(makeStatefulComponent(), [], 20, 5);
    expect(results).toEqual([]);
  });
});
