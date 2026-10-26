import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

export type ProjectTrust = "trusted" | "denied" | "unset";

export function readProjectTrust(agentDir: string, repositoryRoot: string): ProjectTrust {
  let recorded: boolean | null;
  try { recorded = new ProjectTrustStore(agentDir).get(repositoryRoot); } catch { recorded = null; }
  return recorded === true ? "trusted" : recorded === false ? "denied" : "unset";
}

export function trustProject(agentDir: string, repositoryRoot: string): void {
  new ProjectTrustStore(agentDir).set(repositoryRoot, true);
}
