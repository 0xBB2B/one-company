import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InstalledProjectFixture } from "../helpers/project-index-installed-fixture.ts";


const TS_SENTINEL = "TS_CURRENT_SOURCE_SENTINEL";
const GO_SENTINEL = "GO_CURRENT_SOURCE_SENTINEL";
const SPEC_SENTINEL = "SPEC_CURRENT_SOURCE_SENTINEL";
const PROD_SENTINEL = "PROD_ARCHIVE_BODY_SENTINEL_MUST_NOT_LEAK";

function validSpec() {
  return {
    $schema: "schema.json",
    schemaVersion: 1,
    feature: { id: "install.current", title: "安装索引", aliases: ["当前索引"] },
    rules: [{
      id: "install.current.visible", title: "当前规则可检索", condition: "项目已经接入", trigger: "执行索引",
      expected: SPEC_SENTINEL, reason: "验证安装产物使用当前规则", dependsOn: [], exceptions: [],
      acceptance: [{ id: "search-current", given: "存在当前规则", when: "建立索引", then: "规则进入当前索引" }],
    }],
  };
}

// 短真实路径避免macOS socket长度限制；安装/宿主/daemon同Node、离线且独立HOME/dataRoot。
test.skipIf(process.platform !== "darwin")("M2-AC1/4/5/6/7：安装产物经真实 lifecycle 执行 preview/init/status/重复init/refresh", async () => {
  const world = await InstalledProjectFixture.create();
  let failed = false;
  try {
    const repo = await world.repository("r");
    const repositoryRoot = repo.path, dataRoot = repo.dataRoot, databasePath = repo.indexPath;
    const identity = { repoId: repo.repoId };
    const { IndexStore } = await world.product<typeof import("../../runtime/index-store.ts")>("runtime/index-store.ts");
    const { uuidv7 } = await world.product<typeof import("../../runtime/database.ts")>("runtime/database.ts");
    for (const file of ["extensions/index.ts", "extensions/project-manage.ts", "runtime/project-manage-tool.ts",
      "runtime/project-index-service.ts", "runtime/project-index-policy.ts", "runtime/index-store.ts", "runtime/code-extractor.ts",
      "daemon/bootstrap.mjs", "daemon/loader.mjs"]) {
      expect(world.artifactFiles).toContain(file);
    }
    await mkdir(join(repositoryRoot, "src"), { recursive: true });
    await mkdir(join(repositoryRoot, "cmd"), { recursive: true });
    await mkdir(join(repositoryRoot, "docs/spec"), { recursive: true });
    await mkdir(join(repositoryRoot, "docs/prod"), { recursive: true });
    // repository()只准备Git身份；该场景保留原有两份代码输入。
    await world.git(repositoryRoot, ["rm", "source.ts"]);
    await writeFile(join(repositoryRoot, "src/main.ts"), `export function currentTs() { return "${TS_SENTINEL}"; }\n`);
    await writeFile(join(repositoryRoot, "cmd/main.go"), `package main\nconst currentGo = "${GO_SENTINEL}"\nfunc main() {}\n`);
    await copyFile(join(world.installed, "resources/spec/schema.json"), join(repositoryRoot, "docs/spec/schema.json"));
    await writeFile(join(repositoryRoot, "docs/spec/current.rules.json"), JSON.stringify(validSpec()));
    const archiveId = uuidv7();
    await writeFile(join(repositoryRoot, "docs/prod", `${archiveId}.已完成需求.md`), `${PROD_SENTINEL}\n不允许进入FTS或工具输出。\n`);
    await writeFile(join(repositoryRoot, "README.md"), "installation fixture\n");
    await world.git(repositoryRoot, ["add", "."]); await world.git(repositoryRoot, ["commit", "-m", "index inputs"]);
    const daemon = await world.daemon(repo), host = await world.host(repo);
    const toolResults: Array<{ details: Record<string, unknown>; text: string }> = [];
    const invoke = async (input: Record<string, unknown>) => {
      const reply = await host.call("project", input);
      expect(reply.node).toBe(process.execPath); expect(reply.version).toBe(process.version); expect(reply.sdkVersion).toBe("0.87.1");
      expect(reply.onPayloadCalls).toBeGreaterThan(0); expect(reply.payloadEvents).toBe(reply.onPayloadCalls);
      const message = reply.messages.filter((item) => item.role === "toolResult" && item.toolName === "pi_company_project_manage").at(-1);
      expect(message).toBeDefined(); expect(message!.isError, JSON.stringify(message!.content)).toBe(false);
      const text = (message!.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
      const captured = { details: message!.details!, text, confirmations: reply.confirmations };
      toolResults.push(captured);
      return captured;
    };
    expect(existsSync(databasePath)).toBe(false);
    await host.call("approve", { value: true });
    const preview = await invoke({ action: "init", preview: true });
    expect(existsSync(databasePath)).toBe(false);
    expect(preview.details).toMatchObject({ action: "preview", partial: false, databaseCreated: false });
    expect(preview.text).toContain("src/main.ts");
    expect(preview.confirmations).toHaveLength(1);
    expect(preview.confirmations[0]!.message).toContain(repositoryRoot);
    expect(preview.confirmations[0]!.message).toContain(join(dataRoot, "repos", identity.repoId));
    expect(preview.confirmations[0]!.message).toContain("docs/prod 只枚举有限路径元数据，不读取正文");

    await host.call("approve", { value: true });
    const initialized = await invoke({ action: "init" });
    expect(existsSync(databasePath)).toBe(true);
    expect(initialized.details).toMatchObject({ action: "init", status: "ready" });
    expect(Number(initialized.details.generation)).toBeGreaterThanOrEqual(1);
    // 持续协调器可先完成初次解析再发布复用轮；首批两份代码仍必须全部被处理。
    expect(Number(initialized.details.parsedFiles) + Number(initialized.details.reusedFiles)).toBe(2);
    expect(initialized.confirmations).toHaveLength(2);
    expect(initialized.confirmations[0]!.message).toContain("不能用于批准后续 init/refresh");
    expect(initialized.confirmations[1]!.message).toContain("窗口关闭后 PM 与子代理仍可查询");
    const workspace = initialized.details.workspace as { workspaceId: string; repoId: string };
    expect(workspace).toEqual({ workspaceId: expect.stringMatching(/^[0-9a-f]{64}$/), repoId: identity.repoId });
    const options = { workspaceId: workspace.workspaceId, repoId: identity.repoId, root: repositoryRoot, branch: "refs/heads/main" };
    const store = new IndexStore(databasePath, options);
    try {
      const snapshot = store.getSnapshot();
      expect(snapshot.files.map((item) => item.path)).toEqual(expect.arrayContaining(["src/main.ts", "cmd/main.go", "docs/spec/current.rules.json", "docs/spec/schema.json"]));
      expect(snapshot.rules.map((item) => item.id)).toContain("install.current.visible");
      expect(store.search(TS_SENTINEL).results.length).toBeGreaterThan(0);
      expect(store.search(GO_SENTINEL).results.length).toBeGreaterThan(0);
      expect(store.search(SPEC_SENTINEL).results.length).toBeGreaterThan(0);
      expect(store.search(PROD_SENTINEL).results).toEqual([]);
      expect(JSON.stringify(snapshot)).not.toContain(PROD_SENTINEL);
      expect(snapshot.prodMetadata).toContainEqual(expect.objectContaining({ source: "archive", requirementId: archiveId, path: `docs/prod/${archiveId}.已完成需求.md` }));
    } finally { store.close(); }
    const status = await invoke({ action: "status" });
    expect(status.details).toMatchObject({ action: "status", initialized: true, index: { status: "ready" } });
    const statusGeneration = Number((status.details.index as { currentGeneration: number }).currentGeneration);
    expect(statusGeneration).toBeGreaterThanOrEqual(Number(initialized.details.generation));
    const repeated = await invoke({ action: "init" });
    expect(repeated.details).toMatchObject({ action: "init", status: "ready", parsedFiles: 0, reusedFiles: 2 });
    expect(Number(repeated.details.generation)).toBeGreaterThan(statusGeneration);
    const refreshed = await invoke({ action: "refresh" });
    expect(refreshed.details).toMatchObject({ action: "refresh", status: "ready", parsedFiles: 0, reusedFiles: 2 });
    expect(Number(refreshed.details.generation)).toBeGreaterThan(Number(repeated.details.generation));
    expect(refreshed.confirmations).toHaveLength(2);
    const allToolOutput = JSON.stringify(toolResults);
    for (const sentinel of [TS_SENTINEL, GO_SENTINEL, SPEC_SENTINEL, PROD_SENTINEL]) expect(allToolOutput).not.toContain(sentinel);
    const finalStore = new IndexStore(databasePath, options);
    try {
      const snapshot = finalStore.getSnapshot();
      expect(new Set(snapshot.symbols.map((item) => item.id)).size).toBe(snapshot.symbols.length);
      expect(new Set(snapshot.codeEdges.map((item) => item.id)).size).toBe(snapshot.codeEdges.length);
    } finally { finalStore.close(); }
    await host.close();
    expect(await daemon.stop()).toMatchObject({ code: 0, signal: null });
    const probe = await daemon.probe();
    expect(probe).toMatchObject({ forbiddenReads: 0, exited: true });
    expect(probe.closedWatchers).toBe(probe.createdWatchers); expect(existsSync(daemon.socket)).toBe(false);
  } catch (error) { failed = true; throw error; }
  finally { await world.close(failed); }
}, 120_000);
