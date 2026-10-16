import { createHash } from "node:crypto";

/** 操作日志的内容校验；不是用户授权，也不替代目录身份和外部可信 manifest 核验。 */
export function sealOperationLog(value: object): Record<string, unknown> & { integrityHash: string } {
  const payload = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  delete payload.integrityHash;
  const integrityHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return { ...payload, integrityHash };
}

export function validOperationLog(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const hash = (value as Record<string, unknown>).integrityHash;
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) && sealOperationLog(value).integrityHash === hash;
}
