import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

export type ProjectTrust = "trusted" | "denied" | "unset" | "unreadable";

export const trustFilePath = (agentDir: string): string => join(agentDir, "trust.json");

export function readProjectTrust(agentDir: string, repositoryRoot: string): { trust: ProjectTrust; reason?: string } {
  try {
    const recorded = new ProjectTrustStore(agentDir).get(repositoryRoot);
    return { trust: recorded === true ? "trusted" : recorded === false ? "denied" : "unset" };
  } catch (error) {
    return { trust: "unreadable", reason: (error instanceof Error ? error.message : String(error)).split("\n")[0] };
  }
}

export function trustProject(agentDir: string, repositoryRoot: string): void {
  new ProjectTrustStore(agentDir).set(repositoryRoot, true);
}

export function distrustProject(agentDir: string, repositoryRoot: string): void {
  new ProjectTrustStore(agentDir).set(repositoryRoot, false);
}
