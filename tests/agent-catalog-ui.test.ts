import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { AgentCatalogView } from "../runtime/agent-catalog-ui.ts";
import { AgentCopyError, copyAgentDefinition } from "../runtime/agent-copy.ts";
import { defaultRoleDir, loadRoleCatalog } from "../runtime/roles.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function dirs() {
  const root = await mkdtemp(join(tmpdir(), "agent-ui-")); roots.push(root);
  return { defaultDir: defaultRoleDir(), userDir: join(root, "u"), projectDir: join(root, "p") };
}
const RIGHT = "\x1b[C", DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";

test("←→ 按职责分类、↑↓ 选择、回车详情、C 复制、Esc 返回或退出；无效定义列在问题分类", async () => {
  const d = await dirs();
  await mkdir(d.userDir, { recursive: true });
  await writeFile(join(d.userDir, "ui-dev.md"), "---\nname: ui-dev\ndescription: 界面实现\nrole: worker\nmodel: openai/gpt-x\n---\n正文\n");
  await writeFile(join(d.userDir, "broken.md"), "---\nname: broken\ndescription: 坏\nrole: worker\nthinking: extreme\n---\n");
  const catalog = await loadRoleCatalog({ ...d, parseFrontmatter, projectTrusted: false });
  const copied: string[] = []; let closed = false;
  const view = new AgentCatalogView({ catalog, onCopy: (entry) => copied.push(entry.name), onClose: () => { closed = true; } });
  expect(view.render(120)[0]).toContain("[pm]");
  view.handleInput(RIGHT);
  const worker = view.render(120).join("\n");
  expect(worker).toContain("[worker]");
  expect(worker).toMatch(/├ (worker|ui-dev)/u);
  view.handleInput(DOWN); view.handleInput(ENTER);
  const detail = view.render(120).join("\n");
  expect(detail).toMatch(/职责：worker/u);
  expect(detail).toContain("文件：");
  view.handleInput("c");
  expect(copied).toHaveLength(1);
  view.handleInput(ESC); expect(closed).toBe(false);
  for (let i = 0; i < 4; i++) view.handleInput(RIGHT);
  expect(view.render(120).join("\n")).toMatch(/\[问题\][\s\S]*broken/u);
  view.handleInput(ESC); expect(closed).toBe(true);
});

test("复制：新名称三层不重复，pm 只能同名复制到尚无 pm 的层，复制后 name 字段改为新名称", async () => {
  const d = await dirs();
  const catalog = await loadRoleCatalog({ ...d, parseFrontmatter, projectTrusted: true });
  const worker = catalog.roles.find((entry) => entry.name === "worker")!, pm = catalog.roles.find((entry) => entry.name === "pm")!;
  const layerDirs = [d.defaultDir, d.userDir, d.projectDir];
  const target = await copyAgentDefinition({ entry: worker, newName: "ui-dev", targetDir: d.projectDir, layerDirs });
  expect(await readFile(target, "utf8")).toMatch(/^name: ui-dev$/mu);
  await expect(copyAgentDefinition({ entry: worker, newName: "ui-dev", targetDir: d.userDir, layerDirs })).rejects.toBeInstanceOf(AgentCopyError);
  await expect(copyAgentDefinition({ entry: worker, newName: "reviewer", targetDir: d.userDir, layerDirs })).rejects.toThrow("已被使用");
  await expect(copyAgentDefinition({ entry: worker, newName: "Bad Name", targetDir: d.userDir, layerDirs })).rejects.toThrow("名称只能");
  await expect(copyAgentDefinition({ entry: pm, newName: "boss", targetDir: d.userDir, layerDirs })).rejects.toThrow("pm 职责唯一");
  await copyAgentDefinition({ entry: pm, newName: "pm", targetDir: d.userDir, layerDirs });
  await expect(copyAgentDefinition({ entry: pm, newName: "pm", targetDir: d.userDir, layerDirs })).rejects.toThrow("已被使用");
  const reloaded = await loadRoleCatalog({ ...d, parseFrontmatter, projectTrusted: true });
  expect(reloaded.roles.find((entry) => entry.name === "pm")).toMatchObject({ source: "user", overrides: ["default"] });
  expect(reloaded.roles.find((entry) => entry.name === "ui-dev")).toMatchObject({ source: "project", available: true });
});
