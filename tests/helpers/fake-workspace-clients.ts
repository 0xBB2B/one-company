import type { Workspace } from "../../src/core/storage/identity.ts";

export interface FakeDaemonClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  subscribe(event: string, listener: (data: Record<string, unknown>) => void): () => void;
  state(): { status: "connected" };
  close(): void;
}

export interface FakeWorkspaceClientsHandle {
  forRepo(repoId: string): FakeDaemonClient | undefined;
  all(): FakeDaemonClient[];
  skipped(): [];
  closeAll(): void;
  workspace(): Workspace;
}

export interface FakeWorkspaceClients {
  handle: FakeWorkspaceClientsHandle;
  client: FakeDaemonClient;
  callLog: { method: string; params: Record<string, unknown> }[];
  closeAllCallCount(): number;
  clientCloseCallCount(): number;
}

export function createFakeWorkspaceClients(workspace: Workspace): FakeWorkspaceClients {
  const callLog: { method: string; params: Record<string, unknown> }[] = [];
  let closeAllCount = 0;
  let clientCloseCount = 0;

  const client: FakeDaemonClient = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      callLog.push({ method, params });
      return {};
    },
    subscribe: () => () => {},
    state: () => ({ status: "connected" }),
    close: () => {
      clientCloseCount++;
    },
  };

  const handle: FakeWorkspaceClientsHandle = {
    forRepo: () => client,
    all: () => [client],
    skipped: () => [],
    closeAll: () => {
      closeAllCount++;
    },
    workspace: () => workspace,
  };

  return {
    handle,
    client,
    callLog,
    closeAllCallCount: () => closeAllCount,
    clientCloseCallCount: () => clientCloseCount,
  };
}
