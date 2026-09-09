import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readRoleDefinition, type RoleCatalogEntry } from "../../runtime/roles.ts";

export interface WriteRoleEntryFields {
  name: string;
  kind: string;
  tools: string[];
  body?: string;
}

export async function writeRoleEntry(fields: WriteRoleEntryFields, tempRoots: string[]): Promise<RoleCatalogEntry> {
  const dir = await mkdtemp(join(tmpdir(), "role-fixture-"));
  tempRoots.push(dir);
  const path = join(dir, `${fields.name}.md`);
  const lines = [
    `name: ${fields.name}`,
    `description: ${fields.name} 测试角色`,
    `kind: ${fields.kind}`,
    `tools: [${fields.tools.join(", ")}]`,
    "skills: false",
    "context_files: false",
    "prompt_mode: append",
  ];
  await writeFile(path, `---\n${lines.join("\n")}\n---\n${fields.body ?? "正文"}\n`);
  const definition = await readRoleDefinition(path, parseFrontmatter);
  return { name: fields.name, source: "project", path, available: true, definition };
}

export interface InlineRoleCatalogEntryFields {
  name: string;
  kind: string;
  tools: string[];
  description: string;
}

// 直接在内存里构造 RoleCatalogEntry，跳过 frontmatter 往返——frontmatter 的单行 YAML
// 标量装不下测试要注入的嵌入换行值，而这里要测的是渲染折叠而非 frontmatter 解析本身
export function buildInlineRoleCatalogEntry(fields: InlineRoleCatalogEntryFields): RoleCatalogEntry {
  return {
    name: fields.name,
    source: "project",
    path: `/virtual-role-fixture/${fields.name}.md`,
    available: true,
    definition: {
      name: fields.name,
      description: fields.description,
      kind: fields.kind as never,
      tools: fields.tools,
      skills: false,
      contextFiles: false,
      promptMode: "append",
      body: "占位正文",
    },
  };
}

export function createPassthroughGuards() {
  return {
    async checkWrite() {
      return { ok: true as const };
    },
    async fingerprint(paths: string[]): Promise<Record<string, string>> {
      return Object.fromEntries(paths.map((p) => [p, "unchanged"]));
    },
    async verifyFingerprint(): Promise<Array<{ path: string }>> {
      return [];
    },
  };
}
