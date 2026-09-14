import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DaemonServer } from "../../daemon/server.ts";
import { controlToken } from "../../runtime/daemon-auth.ts";
import { daemonSocketPath, repositoryIdentity } from "../../runtime/identity.ts";
import { ProjectSyncGrantVerifier } from "../../runtime/project-sync-grants.ts";

// 独立 Node 进程使用真实 server/SQLite/verifier；不装配宿主、模型或后台索引。
const { repositoryRoot, dataRoot } = JSON.parse(process.argv[2]!) as { repositoryRoot: string; dataRoot: string };
const identity = await repositoryIdentity(repositoryRoot);
const server = new DaemonServer({ authToken: controlToken(dataRoot), repoId: identity.repoId, startedAt: new Date().toISOString() });
const verifier = new ProjectSyncGrantVerifier({ dataRoot, ...identity, daemonInstanceId: server.daemonInstanceId });
server.onHello = () => {};
server.registerHandler("index.sync", (params, client) => {
  if (!server.clients().includes(client)) throw Object.assign(new Error("当前连接已退役"), { code: "grant_invalid" });
  const result = verifier.validateForClient(params.grantId as string, client, {
    repoId: params.repoId as string, workspaceId: params.workspaceId as string,
    root: params.repositoryRoot as string, branch: params.branch as string,
  });
  return { verified: true, workspace: result.workspace, verifierPid: process.pid };
});
server.markHandlersReady();
const socketPath = daemonSocketPath(dataRoot, identity.repoId);
await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
await server.listen(socketPath);
process.send?.({ ready: true, pid: process.pid, daemonInstanceId: server.daemonInstanceId });
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.disconnect?.();
}
process.on("message", (message) => { if (message === "stop") void stop(); });
process.on("disconnect", () => { void stop(); });
