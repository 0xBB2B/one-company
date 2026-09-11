import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function temporaryRoot(): string {
  const root = fileURLToPath(new URL("../../.pi-company/.cache/", import.meta.url));
  mkdirSync(root, { recursive: true });
  writeFileSync(`${root}/.gitignore`, "*\n");
  return root;
}
