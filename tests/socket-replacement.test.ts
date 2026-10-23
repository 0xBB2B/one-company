import { expect, test, vi } from "vitest";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listenExclusive } from "../src/app/daemon/lifecycle.ts";
import { DaemonServer } from "../src/app/daemon/server.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

test("残留监听探测结束后目标被替换，失败竞争者不能删除新文件", async () => {
  const root = await mkdtemp(join(temporaryRoot(), "socket-race-"));
  const socketPath = join(root, "daemon.sock");
  await writeFile(socketPath, "stale");
  // 持有旧 inode，避免测试环境立即复用刚删除的 inode。
  const old = await open(socketPath, "r");
  const server = new DaemonServer({ authToken: "fixture", repoId: "fixture", startedAt: "fixture" });
  const close = server.close.bind(server);
  const hook = vi.spyOn(server, "close").mockImplementationOnce(async () => {
    await close();
    await rm(socketPath);
    await writeFile(socketPath, "replacement");
  });
  try {
    expect(await listenExclusive(server, socketPath)).toBe("retry");
    expect(await readFile(socketPath, "utf8")).toBe("replacement");
  } finally {
    hook.mockRestore();
    await close();
    await old.close();
    await rm(root, { recursive: true, force: true });
  }
});
