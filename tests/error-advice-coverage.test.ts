import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { HostAuthorizationError } from "../runtime/host-authorization.ts";
import { MainIntakeInteractionError } from "../runtime/main-intake-interaction.ts";
import { IntakeContractError } from "../runtime/pm-intake-contracts.ts";
import { PmIntakeServiceError } from "../runtime/pm-intake-service.ts";
import { PmIntakeStoreError } from "../runtime/pm-intake-store.ts";
import { ShortDecisionError } from "../runtime/short-decision-format.ts";
import { UserInteractionError } from "../runtime/user-interaction-format.ts";
import { WebAccessError } from "../runtime/web-access.ts";
import { ProdStorageError } from "../runtime/prod-storage.ts";
import { StaleVersionError } from "../runtime/database.ts";
import { UnsettledShellError } from "../runtime/shell-bash.ts";

const runtime = join(import.meta.dirname, "..", "runtime");
const sources = readdirSync(runtime).filter((name) => name.endsWith(".ts")).map((name) => ({ name, text: readFileSync(join(runtime, name), "utf8") }));
function codesOf(className: string, denyIn: string[] = []): string[] {
  const codes = new Set<string>();
  for (const { name, text } of sources) {
    for (const match of text.matchAll(new RegExp(`new ${className}\\("([a-z_]+)"`, "g"))) codes.add(match[1]!);
    if (denyIn.includes(name)) for (const match of text.matchAll(/\b(?:deny|denied|fail)\("([a-z_]+)"/g)) codes.add(match[1]!);
  }
  return [...codes];
}

test.each([
  ["HostAuthorizationError", (code: string) => new HostAuthorizationError(code), ["main-requirement-interaction.ts"]],
  ["MainIntakeInteractionError", (code: string) => new MainIntakeInteractionError(code), ["main-intake-interaction.ts"]],
  ["PmIntakeServiceError", (code: string) => new PmIntakeServiceError(code), ["pm-intake-service.ts"]],
  ["PmIntakeStoreError", (code: string) => new PmIntakeStoreError(code), ["pm-intake-store.ts"]],
  ["IntakeContractError", (code: string) => new IntakeContractError(code as never), ["pm-intake-contracts.ts"]],
  ["ShortDecisionError", (code: string) => new ShortDecisionError(code), []],
  ["UserInteractionError", (code: string) => new UserInteractionError(code), []],
] as const)("%s 抛出的每个码都写了原因与建议", (className, make, denyIn) => {
  const codes = codesOf(className, [...denyIn]);
  expect(codes.length).toBeGreaterThan(0);
  const missing = codes.filter((code) => make(code).advice.why.startsWith("未归类") || make(code).advice.why.startsWith("需求操作被拒绝（"));
  expect(missing).toEqual([]);
});

test("联网、需求存储、数据库与 Shell 的错误也给出原因与建议", () => {
  expect(new HostAuthorizationError("invalid_approval_unit_id").advice.why).not.toMatch(/^需求操作被拒绝（/);
  expect(new WebAccessError("rate_limited").advice).toEqual({ why: "搜索服务限流", next: "等一会再搜，或改用 web_fetch 直接读已知网址" });
  expect(new ProdStorageError("git_unavailable", "Git 可执行文件不可用").advice).toEqual({ why: "Git 可执行文件不可用", next: "请用户检查本机 Git 与数据目录的安装、权限和链接" });
  expect(new StaleVersionError().advice.next).toBe("重新读取后再试");
  expect(new UnsettledShellError("Shell 停止尚未确认").advice.why).toBe("Shell 停止尚未确认");
});
