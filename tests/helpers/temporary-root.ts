import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function temporaryRoot(): string {
  const root = fileURLToPath(new URL("../../.bb-spec/.cache/", import.meta.url));
  mkdirSync(root, { recursive: true });
  writeFileSync(`${root}/.gitignore`, "*\n");
  return root;
}
