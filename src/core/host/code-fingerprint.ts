import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function installedPackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

async function collect(root: string, relative: string, into: string[]): Promise<void> {
  const info = await stat(join(root, relative)).catch(() => undefined);
  if (!info) return;
  if (info.isFile()) {
    into.push(relative);
    return;
  }
  for (const entry of await readdir(join(root, relative))) {
    await collect(root, `${relative}/${entry}`, into);
  }
}

export async function codeFingerprint(packageRoot: string): Promise<string> {
  const found: string[] = [];
  for (const dir of ["src", "resources"]) await collect(packageRoot, dir, found);
  found.sort();
  const hash = createHash("sha256");
  for (const relative of found) {
    hash.update(relative).update("\0").update(await readFile(join(packageRoot, relative))).update("\0");
  }
  hash.update(await readFile(join(packageRoot, "package.json"), "utf8"));
  return hash.digest("hex");
}
