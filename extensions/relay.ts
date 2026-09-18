import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkspaceClientsHandle } from "../runtime/daemon-client.ts";
import type { WindowContextValue } from "./lifecycle.ts";

export interface RelayExtensionDeps { windowReady?: () => Promise<WindowContextValue> }

/** 旧中继不加载积压正文，不注入模型，不注册事件监听或回复工具。 */
export async function registerRelayInbox(
  _pi: ExtensionAPI, _clients: WorkspaceClientsHandle, _sessionId: string,
  _onSkipped?: (count: number) => void, _options: { now?: () => number } = {},
): Promise<() => void> { return () => {}; }

export default function relayExtension(_pi: ExtensionAPI, _deps: RelayExtensionDeps = {}): void {}
