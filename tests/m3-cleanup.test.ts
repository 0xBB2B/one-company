import { expect, test } from "vitest";
import { cleanupOwnedScope } from "./helpers/m3-cleanup.ts";

test("清理首个孩子失败仍逐个停止后续孩子，保留所有关联目录", async () => {
  const trace: string[] = [];
  await expect(cleanupOwnedScope({
    paths: ["/tmp/owned-fixture-a", "/tmp/owned-fixture-b"],
    stop: [
      { label: "child-a", run: () => { trace.push("a-stop-failed"); throw new Error("stop failure"); } },
      { label: "child-b", run: () => { trace.push("b-stopped"); } },
    ],
    diagnose: [
      { label: "evidence-a", run: () => { trace.push("a-evidence-failed"); throw new Error("evidence failure"); } },
      { label: "evidence-b", run: () => { trace.push("b-evidence"); } },
    ],
    remove: [{ label: "delete", run: () => { trace.push("deleted"); } }],
  })).rejects.toThrow("保留关联现场：/tmp/owned-fixture-a, /tmp/owned-fixture-b");
  expect(trace).toEqual(["a-stop-failed", "b-stopped", "a-evidence-failed", "b-evidence"]);
});

test("未知exited有界返回失败，迟到结束不补做删除且后续孩子仍收尾", async () => {
  const trace: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  try {
    await expect(cleanupOwnedScope({
      paths: ["/tmp/owned-unknown"],
      stop: [
        { label: "unknown-exited", timeoutMs: 20, run: () => pending },
        { label: "next-child", run: () => { trace.push("next-stopped"); } },
      ],
      remove: [{ label: "delete", run: () => { trace.push("deleted"); } }],
    })).rejects.toThrow("/tmp/owned-unknown");
  } finally { release(); await pending; }
  expect(trace).toEqual(["next-stopped"]);
});

test("所有资源停止但诊断失败仍保留；全部成功才允许进入删除阶段", async () => {
  for (const fail of [true, false]) {
    const trace: string[] = [];
    const result = cleanupOwnedScope({
      paths: ["/tmp/owned-scope"],
      stop: [{ label: "stop", run: () => { trace.push("stopped"); } }],
      diagnose: [{ label: "diagnose", run: () => { trace.push("diagnosed"); if (fail) throw new Error("read failure"); } }],
      remove: [{ label: "delete", run: () => { trace.push("deleted"); } }],
    });
    if (fail) await expect(result).rejects.toThrow("/tmp/owned-scope"); else await result;
    expect(trace).toEqual(fail ? ["stopped", "diagnosed"] : ["stopped", "diagnosed", "deleted"]);
  }
});
