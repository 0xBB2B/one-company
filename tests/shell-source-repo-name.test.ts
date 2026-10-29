import { afterEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { createClock } from "../src/core/policy/clock.ts";
import { ShellRegistry } from "../src/core/host/shell-registry.ts";
import type { Host } from "../src/core/host/shell-registry.ts";
import { repoDisplayLabels } from "../src/core/storage/identity.ts";
import installShellUi, { openShellUiPage } from "../src/modules/shell/shell-ui-extension.ts";
import type { ShellPage } from "../src/modules/shell/shell-page.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

const KEY = { down: "\x1b[B", enter: "\r", escape: "\x1b" };

describe("repoDisplayLabels：来源行用的仓库显示名", () => {
  test("工作区里没有同名仓库时只写仓库名", () => {
    const result = repoDisplayLabels(["/w/企微BOT/.git", "/w/admin-web/.git"]);
    expect(result.get("/w/企微BOT/.git")).toBe("企微BOT");
    expect(result.get("/w/admin-web/.git")).toBe("admin-web");
  });

  test("同名仓库加上层目录到互不相同，名字不同的仓库仍只写仓库名", () => {
    const result = repoDisplayLabels(["/w/client/api/.git", "/w/server/api/.git", "/w/企微BOT/.git"]);
    expect(result.get("/w/client/api/.git")).toBe("client/api");
    expect(result.get("/w/server/api/.git")).toBe("server/api");
    expect(result.get("/w/企微BOT/.git")).toBe("企微BOT");
  });

  test("上一层仍相同时继续往上加", () => {
    const result = repoDisplayLabels(["/w/a/client/api/.git", "/w/b/client/api/.git"]);
    expect(result.get("/w/a/client/api/.git")).toBe("a/client/api");
    expect(result.get("/w/b/client/api/.git")).toBe("b/client/api");
  });

  test("同名组统一加同样多层，不同名的仓库不受影响", () => {
    const result = repoDisplayLabels(["/w/x/client/api/.git", "/w/y/client/api/.git", "/w/server/api/.git"]);
    expect(result.get("/w/x/client/api/.git")).toBe("x/client/api");
    expect(result.get("/w/y/client/api/.git")).toBe("y/client/api");
    expect(result.get("/w/server/api/.git")).toBe("w/server/api");
  });

  test("同一个 commonDir 出现多次算一个仓库，只写仓库名", () => {
    const result = repoDisplayLabels(["/w/client/api/.git", "/w/client/api/.git"]);
    expect(result.get("/w/client/api/.git")).toBe("api");
  });

  test("裸仓库取去掉 .git 后缀的名字", () => {
    expect(repoDisplayLabels(["/w/api.git"]).get("/w/api.git")).toBe("api");
  });

  test("仓库名里的控制字符被去掉", () => {
    const dir = "/w/a\nb\x1bc/.git";
    const value = repoDisplayLabels([dir]).get(dir)!;
    expect(value).toBe("abc");
  });

  test("上层目录名里的控制字符被去掉", () => {
    const dirs = ["/w/x\ny\x1bz/api/.git", "/w/other/api/.git"];
    const result = repoDisplayLabels(dirs);
    expect(result.get(dirs[0])).toBe("xyz/api");
    expect(result.get(dirs[1])).toBe("other/api");
  });
});

const spawnedPgids: number[] = [];

afterEach(() => {
  for (const pgid of spawnedPgids.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // 进程组已退出
    }
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待条件超时");
    await delay(20);
  }
}

function workerHost(): Host {
  return { kind: "role", id: "req-worker", role: "worker", runId: randomUUID() };
}

function workerTask(taskId: string, pid: number) {
  return { taskId, host: workerHost(), command: "cmd", cwd: "/repo", pid, startedAt: "0", status: "running", activity: "active", inWorkspace: true };
}

interface RepoSpec {
  repoId: string;
  commonDir: string;
  tasks: ReturnType<typeof workerTask>[];
}

async function withShellPage(
  specs: RepoSpec[],
  run: (page: ShellPage, registry: ShellRegistry) => Promise<void>,
): Promise<void> {
  const fakePi = createFakePi();
  const clients = new Map(specs.map((spec) => {
    const connectionId = randomUUID();
    return [spec.repoId, {
      connectionIdentity: () => ({ daemonInstanceId: "fake-daemon", connectionId, connectionSequence: 1 }),
      call: async (method: string) => (method === "shells.list" ? { tasks: spec.tasks } : {}),
      subscribe: () => () => {},
      state: () => ({ status: "connected" as const }),
      close: () => {},
    }];
  }));
  const window = {
    shellRegistry: new ShellRegistry({ clock: createClock() }),
    windowId: "window-source",
    sessionId: "session-source",
    workspace: {
      repos: specs.map((spec) => ({ repoId: spec.repoId, path: spec.commonDir.replace(/\/\.git$/, ""), commonDir: spec.commonDir })),
      skipped: [],
    },
    clients: {
      forRepo: (id: string) => clients.get(id),
      all: () => [...clients.values()],
      skipped: () => [],
      closeAll: () => {},
    },
  };
  installShellUi(fakePi.pi, { windowReady: () => Promise.resolve(window) as never, createClock: () => createClock() });
  const ctx = {
    mode: "tui", hasUI: true, cwd: process.cwd(), sessionManager: { getSessionId: () => window.sessionId },
    ui: {
      setStatus: () => {}, notify: () => {}, getEditorText: () => "", custom: () => Promise.reject(new Error("未使用")),
      setWidget: () => {}, onTerminalInput: () => () => {},
    },
  };
  let page: ShellPage | undefined;
  let opened: Promise<void> | undefined;
  try {
    await fakePi.trigger("session_start", { reason: "new" }, ctx);
    await delay(0);
    opened = openShellUiPage({ ui: { custom: (factory) => new Promise((resolve) => {
      page = factory({ requestRender: () => {}, terminal: { columns: 80, rows: 24 } }, {}, {}, resolve);
    }) } });
    await waitFor(() => page !== undefined);
    await page!.refresh();
    await run(page!, window.shellRegistry);
  } finally {
    page?.handleInput(KEY.escape);
    page?.handleInput(KEY.escape);
    await opened;
    await fakePi.trigger("session_shutdown", { reason: "quit" }, ctx);
  }
}

function sourceValueLines(rendered: string[]): string[] {
  const start = rendered.findIndex((line) => /^ {3}来源 /.test(line));
  if (start < 0) throw new Error("详情页没有来源行");
  const result = [rendered[start].replace(/^ {3}来源 +/, "")];
  for (let i = start + 1; i < rendered.length && rendered[i].startsWith(" ".repeat(11)); i += 1) result.push(rendered[i]);
  return result;
}

describe("Shell 任务详情页：来源行的仓库名", () => {
  test("单仓库时写仓库名，整页不出现仓库编号的前 7 位和后 4 位", async () => {
    const repoId = "3f9a1c2b7e5d4a8c9b0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c8d4e";
    await withShellPage(
      [{ repoId, commonDir: "/workspace/企微BOT/.git", tasks: [workerTask("t1", 4101)] }],
      async (page) => {
        page.handleInput(KEY.enter);
        const text = page.render(80).join("\n");
        expect(sourceValueLines(page.render(80)).join("")).toContain("（仓库 企微BOT）");
        expect(text).not.toContain(repoId.slice(0, 7));
        expect(text).not.toContain(repoId.slice(-4));
      },
    );
  });

  test("两个仓库同名时来源行分别写上层目录和仓库名", async () => {
    const idA = "a".repeat(64);
    const idB = "b".repeat(64);
    await withShellPage(
      [
        { repoId: idA, commonDir: "/workspace/client/api/.git", tasks: [workerTask("ta", 4201)] },
        { repoId: idB, commonDir: "/workspace/server/api/.git", tasks: [workerTask("tb", 4202)] },
      ],
      async (page) => {
        const sourceByPid = new Map<string, string>();
        for (const move of [[], [KEY.down]]) {
          for (const key of move) page.handleInput(key);
          page.handleInput(KEY.enter);
          const rendered = page.render(80);
          const pid = rendered.join("\n").match(/^ {3}进程 +(\d+)/m)?.[1];
          sourceByPid.set(pid ?? "", sourceValueLines(rendered).join(""));
          page.handleInput(KEY.escape);
        }
        expect(sourceByPid.get("4201")).toContain("（仓库 client/api）");
        expect(sourceByPid.get("4202")).toContain("（仓库 server/api）");
      },
    );
  });

  test("主会话开的 Shell 来源行仍是 主 agent（本窗口）", async () => {
    await withShellPage(
      [{ repoId: "c".repeat(64), commonDir: "/workspace/企微BOT/.git", tasks: [] }],
      async (page, registry) => {
        const result = await registry.spawn({
          taskId: randomUUID(),
          host: { kind: "main", id: "main" },
          command: "sh",
          args: ["-c", "sleep 30 # 来源标记"],
          mode: "background",
          runToken: randomUUID(),
        });
        if (!result.ok) throw new Error(`测试环境启动失败：${result.reason}`);
        spawnedPgids.push(result.task.pgid);
        await delay(150);
        await page.refresh();
        page.handleInput(KEY.enter);
        expect(sourceValueLines(page.render(80)).join("")).toBe("主 agent（本窗口）");
      },
    );
  });

  test("仓库名很长时来源值折成两行，续行以 11 个空格开头且文字不丢", async () => {
    const longName = "long-repo-name-".repeat(4);
    expect(longName.length).toBe(60);
    await withShellPage(
      [{ repoId: "d".repeat(64), commonDir: `/workspace/${longName}/.git`, tasks: [workerTask("tl", 4301)] }],
      async (page) => {
        page.handleInput(KEY.enter);
        const lines = sourceValueLines(page.render(80));
        expect(lines.length).toBe(2);
        expect(lines[1].startsWith(" ".repeat(11))).toBe(true);
        expect(lines.join("").replace(/\s/g, "")).toContain(`（仓库${longName}）`);
      },
    );
  });
});
