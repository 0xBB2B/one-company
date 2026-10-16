import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { repositoryDatabase, uuidv7, withDatabase } from "../src/core/storage/database.ts";
import { REQUIREMENT_WRITE_COORDINATION_NAMESPACE, RequirementWriteCoordinator } from "../src/modules/requirement/requirement-coordination.ts";
import { temporaryRoot } from "./helpers/temporary-root.ts";

test("写占用元数据拒绝未知字段和记录键身份冲突", async () => {
  const dataRoot = await mkdtemp(join(temporaryRoot(), "coordination-metadata-"));
  const repoId = "a".repeat(64), requirementId = uuidv7();
  const path = repositoryDatabase(dataRoot, repoId);
  const claim = { format: "requirement-service-write-claim/v2", processGroups: [], repoId, requirementId,
    operationId: uuidv7(), ownerToken: uuidv7(), pid: process.pid, acquiredAt: Date.now() };
  try {
    withDatabase(path, (db) => db.create(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, requirementId, { ...claim, prodBody: "不能作为元数据返回" }));
    const coordinator = new RequirementWriteCoordinator({ dataRoot, repoId });
    expect(() => coordinator.inspect()).toThrow(/write_claim_corrupt/);
    withDatabase(path, (db) => {
      const record = db.read(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, requirementId)!;
      db.update(REQUIREMENT_WRITE_COORDINATION_NAMESPACE, requirementId, record.version, { ...claim, requirementId: uuidv7() });
    });
    expect(() => coordinator.inspect()).toThrow(/write_claim_corrupt/);
  } finally { await rm(dataRoot, { recursive: true, force: true }); }
});
