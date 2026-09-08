import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL_MD = join(PACKAGE_ROOT, "skills/spec-docs/SKILL.md");
const LINT_SH = join(PACKAGE_ROOT, "skills/spec-docs/scripts/lint.sh");
const TASK_CHECK_TS = join(PACKAGE_ROOT, "skills/spec-docs/scripts/task-check.ts");
const REQUIREMENT_DIR_REL = ".pi-company/requirements/2026-09-09.sample-feature";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-company-spec-docs-"));
  tempRoots.push(root);
  return root;
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(cmd: string, args: string[], envOverride?: Record<string, string>): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: PACKAGE_ROOT,
      timeout: 20_000,
      env: envOverride ?? process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function runLintTasks(requirementsPath: string, envOverride?: Record<string, string>): Promise<RunResult> {
  return run("bash", [LINT_SH, "--tasks", requirementsPath], envOverride);
}

async function runTaskCheck(requirementsPath: string): Promise<RunResult> {
  return run("bun", [TASK_CHECK_TS, requirementsPath]);
}

async function hashTree(dir: string): Promise<string> {
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const items = await readdir(current, { withFileTypes: true });
    for (const item of items) {
      const full = join(current, item.name);
      if (item.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(dir);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(dir, file));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function countLinesExcludingFencesIndependently(filePath: string): Promise<number> {
  const script = 'awk \'/^```/||/^~~~/{f=!f;next} !f{c++} END{print c+0}\' "$1"';
  const { stdout } = await execFileAsync("bash", ["-c", script, "_", filePath]);
  return Number.parseInt(stdout.trim(), 10);
}

function ruleFile(name: string): string {
  return `---
name: ${name}
description: ${name} 规则描述
---
# ${name} 规则标题

## 目的
说明 ${name} 为谁解决什么问题。

## 逻辑
触发后系统执行既定处理并返回结果。

## 约束
- C-1：系统应在触发时返回既定结果

## 例子
输入触发条件，系统返回既定结果。

## 验收
### AC-1 基本场景 ← C-1
- 触发: 命令 sample ${name}
- Given: 系统处于初始状态
- When: 执行命令 sample ${name}
- Then: 返回既定结果
`;
}

function ruleFileWithFullWidthColonHeading(name: string): string {
  return `---
name: ${name}
description: ${name} 规则描述
---
# ${name} 规则标题

## 目的
说明 ${name} 为谁解决什么问题。

## 逻辑
触发后系统执行既定处理并返回结果。

## 约束
- C-1：系统应在触发时返回既定结果

## 例子
输入触发条件，系统返回既定结果。

## 验收
### AC-1：基本场景 ← C-1
- 触发: 命令 sample ${name}
- Given: 系统处于初始状态
- When: 执行命令 sample ${name}
- Then: 返回既定结果
`;
}

function ruleFileWithExtraAc(name: string): string {
  const base = ruleFile(name);
  const withConstraint = base.replace(
    "- C-1：系统应在触发时返回既定结果",
    "- C-1：系统应在触发时返回既定结果\n- C-2：如果触发条件缺失，系统应返回错误",
  );
  return withConstraint.replace(
    /(### AC-1 基本场景 ← C-1\n- 触发: 命令 sample [^\n]+\n- Given: 系统处于初始状态\n- When: 执行命令 sample [^\n]+\n- Then: 返回既定结果\n)/,
    `$1\n### AC-2 缺失场景 ← C-2\n- 触发: 命令 sample ${name}\n- Given: 触发条件缺失\n- When: 执行命令 sample ${name}\n- Then: 返回错误\n`,
  );
}

function acQuoteBlock(ruleName: string): string {
  return [
    "- C-1：系统应在触发时返回既定结果",
    "",
    "### AC-1 基本场景 ← C-1",
    `- 触发: 命令 sample ${ruleName}`,
    "- Given: 系统处于初始状态",
    `- When: 执行命令 sample ${ruleName}`,
    "- Then: 返回既定结果",
  ].join("\n");
}

interface TaskOpts {
  id: string;
  title: string;
  domainRuleName: string;
  files: string[];
}

function taskBody(opts: TaskOpts): string {
  const handlerName = `handle${opts.id.replace("-", "")}`;
  const body = [
    "",
    `# ${opts.title}`,
    "",
    "## 目标",
    `完成 ${opts.domainRuleName} 对应的能力。`,
    "",
    "## 业务规则",
    "",
    `来源：sample/${opts.domainRuleName}。`,
    "",
    acQuoteBlock(opts.domainRuleName),
    "",
    "## 涉及文件",
    `- 新建（生产）：${opts.files[0]} — 实现 ${opts.domainRuleName}`,
    "",
    "## 函数清单",
    `- ${opts.domainRuleName}.ts: ${handlerName} — 处理 ${opts.domainRuleName} 触发`,
    "",
    "## 协作关系",
    `${handlerName} 由入口直接调用，无外部依赖。`,
    "",
    "## 验证方式",
    `- 真实入口: 命令 sample ${opts.domainRuleName}`,
    "- 必须成立: 执行后返回既定结果",
    "- 场景: 适用于初始状态触发；不适用于未初始化场景",
    "- 模拟边界: 允许模拟外部时钟，必须真实贯通命令执行链路",
    "- 三层责任: 目标测试覆盖对应验收；受影响回归覆盖既有命令入口；集成验证覆盖端到端命令执行",
  ];
  return body.join("\n") + "\n";
}

function taskFile(
  opts: TaskOpts & {
    dependsOn: string[];
    refs: string[];
    verify: string;
  },
): string {
  const frontmatter = [
    "---",
    `id: ${opts.id}`,
    `title: ${opts.title}`,
    `depends_on: [${opts.dependsOn.join(", ")}]`,
    `files: [${opts.files.join(", ")}]`,
    `refs: [${opts.refs.join(", ")}]`,
    `verify: ${opts.verify}`,
    "---",
  ];
  return frontmatter.join("\n") + "\n" + taskBody(opts);
}

function buildTaskBContent(
  root: string,
  targetCountedLines: number,
  fenceOptions: { openFence?: string; closeFence?: string; fenceBody?: string[] } = {},
): string {
  const file = join(root, ".pi-company/src/rule-b.ts");
  const marker = join(root, "verify-marker.sh");
  const before = [
    "---",
    "id: T-2",
    "title: 任务 B",
    "depends_on: []",
    `files: [${file}]`,
    "refs: [sample/rule-b/AC-1]",
    `verify: bash ${marker} T-2`,
    "---",
    "",
    "# 任务 B",
    "",
    "## 目标",
    "完成 rule-b 对应的能力。",
    "",
    "## 业务规则",
    "",
    "来源：sample/rule-b。",
    "",
    ...acQuoteBlock("rule-b").split("\n"),
    "",
    "## 涉及文件",
    `- 新建（生产）：${file} — 实现 rule-b`,
    "",
    "## 成品定义",
    "",
  ];
  const openFence = fenceOptions.openFence ?? "```json";
  const closeFence = fenceOptions.closeFence ?? "```";
  const fenceBody = fenceOptions.fenceBody ?? ['{"table":"sample_rule_b","columns":["id"]}'];
  const codeBlock = [openFence, ...fenceBody, closeFence];
  const after = [
    "",
    "## 函数清单",
    "- rule-b.ts: handleT2 — 处理 rule-b 触发",
    "",
    "## 协作关系",
    "handleT2 由入口直接调用，无外部依赖。",
    "",
    "## 验证方式",
    "- 真实入口: 命令 sample rule-b",
    "- 必须成立: 执行后返回既定结果",
    "- 场景: 适用于初始状态触发；不适用于未初始化场景",
    "- 模拟边界: 允许模拟外部时钟，必须真实贯通命令执行链路",
    "- 三层责任: 目标测试覆盖 AC-1；受影响回归覆盖既有命令入口；集成验证覆盖端到端命令执行",
  ];
  const fixedCount = before.length + after.length;
  const paddingCount = targetCountedLines - fixedCount;
  if (paddingCount < 0) throw new Error("padding 不足，调整基础内容长度");
  const padding = Array.from(
    { length: paddingCount },
    (_, i) => `补充说明第 ${i + 1} 行，用于凑满任务文件计数行。`,
  );
  const lines = [...before, ...codeBlock, ...padding, ...after];
  return lines.join("\n") + "\n";
}

interface Fixture {
  requirementsPath: string;
  files: Record<string, string>;
}

async function buildValidFixture(root: string): Promise<Fixture> {
  const fileA = join(root, ".pi-company/src/rule-a.ts");
  const marker = join(root, "verify-marker.sh");
  const taskAContent = taskFile({
    id: "T-1",
    title: "任务 A",
    dependsOn: [],
    files: [fileA],
    refs: ["sample/rule-a/AC-1"],
    verify: `bash ${marker} T-1`,
    domainRuleName: "rule-a",
  });
  const taskBContent = buildTaskBContent(root, 200);

  const files: Record<string, string> = {
    ".pi-company/spec/sample/rule-a.md": ruleFile("rule-a"),
    ".pi-company/spec/sample/rule-b.md": ruleFile("rule-b"),
    ".pi-company/spec/sample/rule-c.md": ruleFile("rule-c"),
    ".pi-company/spec/INDEX.md": [
      "# 规范索引",
      "",
      "## sample",
      "",
      "- [rule-a](sample/rule-a.md) — rule-a 规则描述",
      "- [rule-b](sample/rule-b.md) — rule-b 规则描述",
      "- [rule-c](sample/rule-c.md) — rule-c 规则描述",
      "",
    ].join("\n"),
    ".pi-company/spec/GLOSSARY.md": "# 术语表\n\n| 锚点 | 定义 | 别名 |\n|---|---|---|\n",
    [`${REQUIREMENT_DIR_REL}/requirements.md`]: [
      "---",
      "name: sample-feature",
      "title: 示例功能",
      "created: 2026-09-09",
      "---",
      "",
      "# 示例功能",
      "",
      "## 1. 背景",
      "",
      "用户在示例场景下需要规则 A 与规则 B 生效。",
      "",
      "## 2. 目标与非目标",
      "",
      "### 非目标",
      "",
      "- 不涉及规则 C 的变更",
      "",
      "### 目标",
      "",
      "- 规则 A 与规则 B 均可触发并返回既定结果",
      "",
      "## 3. 规范变更",
      "",
      "| 规范 | 变更 | 说明 |",
      "|---|---|---|",
      "| sample/rule-a | 新增 | 增加规则 A |",
      "| sample/rule-b | 新增 | 增加规则 B |",
      "",
      "## 4. 边界与已知坑",
      "",
      "- 数据量与并发：单用户单请求",
      "- 失败与重试：失败不重试",
      "- 上下游约束：无外部依赖",
      "- 已知坑：无",
      "",
    ].join("\n"),
    [`${REQUIREMENT_DIR_REL}/tasks/INDEX.md`]: [
      "# 任务索引",
      "",
      "## 阶段一",
      "",
      "- [T-1 任务 A](01-task-a.md) — 完成规则 A",
      "- [T-2 任务 B](02-task-b.md) — 完成规则 B",
      "",
    ].join("\n"),
    [`${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`]: taskAContent,
    [`${REQUIREMENT_DIR_REL}/tasks/02-task-b.md`]: taskBContent,
    "verify-marker.sh": '#!/usr/bin/env bash\ntouch "$(dirname "$0")/marker-$1.txt"\n',
  };

  return { requirementsPath: join(root, REQUIREMENT_DIR_REL, "requirements.md"), files };
}

async function runMutatedFixture(mutate: (files: Record<string, string>, root: string) => void): Promise<RunResult> {
  const root = await createTempRoot();
  const { requirementsPath, files } = await buildValidFixture(root);
  mutate(files, root);
  await writeFiles(root, files);
  return runLintTasks(requirementsPath);
}

function extractFrontmatterExampleFromSkill(content: string): string {
  const idx = content.indexOf("frontmatter 字段顺序固定");
  if (idx === -1) throw new Error("SKILL.md 未找到 frontmatter 字段顺序固定 说明");
  const rest = content.slice(idx);
  const fenceMatch = rest.match(/```[a-zA-Z]*\n([\s\S]*?)\n```/);
  if (!fenceMatch) throw new Error("SKILL.md 的 frontmatter 示例未包裹在代码块中");
  return fenceMatch[1];
}

describe("有效需求文档与任务集合通过机械检查", () => {
  test("lint.sh --tasks 与 task-check.ts 均两次退出码 0、首行 PASS、.pi-company 全树指纹不变、不执行 verify", async () => {
    const root = await createTempRoot();
    const { requirementsPath, files } = await buildValidFixture(root);
    await writeFiles(root, files);

    const taskBPath = join(root, REQUIREMENT_DIR_REL, "tasks/02-task-b.md");
    expect(await countLinesExcludingFencesIndependently(taskBPath)).toBe(200);

    const piCompanyRoot = join(root, ".pi-company");
    const beforeHash = await hashTree(piCompanyRoot);

    const first = await runLintTasks(requirementsPath);
    const second = await runLintTasks(requirementsPath);
    const direct = await runTaskCheck(requirementsPath);

    const afterHash = await hashTree(piCompanyRoot);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(direct.code).toBe(0);
    expect(first.stdout.split("\n")[0]).toBe("PASS: 仅证明任务机械条件，不证明行为正确");
    expect(second.stdout.split("\n")[0]).toBe("PASS: 仅证明任务机械条件，不证明行为正确");
    expect(direct.stdout.split("\n")[0]).toBe("PASS: 仅证明任务机械条件，不证明行为正确");
    expect(afterHash).toBe(beforeHash);

    expect(await pathExists(join(root, "marker-T-1.txt"))).toBe(false);
    expect(await pathExists(join(root, "marker-T-2.txt"))).toBe(false);
  });

  test("范围外规则 rule-c 的未覆盖验收不报错", async () => {
    const root = await createTempRoot();
    const { requirementsPath, files } = await buildValidFixture(root);
    await writeFiles(root, files);
    const result = await runLintTasks(requirementsPath);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("rule-c");
  });

  test("SKILL.md 的权威 frontmatter 示例块补充行尾注释后落成任务文件可通过 task-check", async () => {
    const root = await createTempRoot();
    const skillContent = await readFile(SKILL_MD, "utf8");
    const fileA = join(root, ".pi-company/src/rule-a.ts");
    const marker = join(root, "verify-marker.sh");
    const frontmatterBlock = extractFrontmatterExampleFromSkill(skillContent)
      .replace(/^id:.*/m, "id: T-1")
      .replace(/^title:.*/m, "title: 任务 A")
      .replace(/^depends_on:.*/m, "depends_on: []  # 无前置任务时为空数组")
      .replace(/^files:.*/m, `files: [${fileA}]`)
      .replace(/^refs:.*/m, "refs: [sample/rule-a/AC-1]")
      .replace(/^verify:.*/m, `verify: bash ${marker} T-1`);

    const { requirementsPath, files } = await buildValidFixture(root);
    files[`${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`] =
      `${frontmatterBlock}\n${taskBody({ id: "T-1", title: "任务 A", domainRuleName: "rule-a", files: [fileA] })}`;
    await writeFiles(root, files);

    const result = await runTaskCheck(requirementsPath);
    expect(result.code).toBe(0);
  });

  test("成品代码块使用 ~~~ 围栏且达 300 行时仍按围栏排除计数并通过检查", async () => {
    const root = await createTempRoot();
    const { requirementsPath, files } = await buildValidFixture(root);
    files[`${REQUIREMENT_DIR_REL}/tasks/02-task-b.md`] = buildTaskBContent(root, 200, {
      openFence: "~~~json",
      closeFence: "~~~",
      fenceBody: Array.from({ length: 300 }, (_, i) => `{"row": ${i}}`),
    });
    await writeFiles(root, files);

    const taskBPath = join(root, REQUIREMENT_DIR_REL, "tasks/02-task-b.md");
    expect(await countLinesExcludingFencesIndependently(taskBPath)).toBe(200);

    const result = await runLintTasks(requirementsPath);
    expect(result.code).toBe(0);
  });
});

describe("违规任务集合被拒绝且定位到具体条件", () => {
  test("任务文件超过 200 行计数内容 → 拒绝并定位 T-2", async () => {
    const result = await runMutatedFixture((files, root) => {
      files[`${REQUIREMENT_DIR_REL}/tasks/02-task-b.md`] = buildTaskBContent(root, 201);
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-2");
  });

  test("业务规则节删掉所引验收的标题行（含回指）→ 拒绝并定位 T-1", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`;
      files[path] = files[path].replace(/^### AC-1 .*\n/m, "");
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
  });

  test("业务规则节把验收标题的回指改为不存在的约束编号 → 拒绝并定位 T-1", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`;
      files[path] = files[path].replace(/^(### AC-1 .*)← C-1/m, "$1← C-9");
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
  });

  test("涉及文件行缺少类别声明 → 退出码 2 并定位 T-1", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`;
      files[path] = files[path].replace(/^- 新建（生产）：/m, "- 新建：");
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
  });

  test("frontmatter 缺少 refs 字段 → 拒绝并定位 T-1", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`;
      files[path] = files[path].replace(/^refs:.*\n/m, "");
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
    expect(result.stdout).toContain("refs");
  });

  test("frontmatter 含 parallel 运行字段 → 拒绝并定位 T-1", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`;
      files[path] = files[path].replace(/^verify:(.*)\n/m, "verify:$1\nparallel: false\n");
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
    expect(result.stdout).toContain("parallel");
  });

  test("files 字段写成块式 YAML 列表 → 拒绝并定位 T-1: files 格式不合法", async () => {
    const result = await runMutatedFixture((files, root) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`;
      const fileA = join(root, ".pi-company/src/rule-a.ts");
      files[path] = files[path].replace(/^files:.*\n/m, `files:\n  - ${fileA}\n`);
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1: files");
  });

  test("涉及文件节声明的生产路径多于 frontmatter files → 拒绝并定位 files", async () => {
    const result = await runMutatedFixture((files, root) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`;
      const fileA = join(root, ".pi-company/src/rule-a.ts");
      const extra1 = join(root, ".pi-company/src/extra-1.ts");
      const extra2 = join(root, ".pi-company/src/extra-2.ts");
      const originalLine = `- 新建（生产）：${fileA} — 实现 rule-a`;
      const replacedLines = [
        originalLine,
        `- 新建（生产）：${extra1} — 附加文件一`,
        `- 新建（生产）：${extra2} — 附加文件二`,
      ].join("\n");
      files[path] = files[path].replace(originalLine, replacedLines);
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
    expect(result.stdout).toContain("files");
  });

  test("tasks/INDEX.md 缺失 T-2 的索引链接 → 拒绝并定位 T-2", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/INDEX.md`;
      files[path] = files[path].replace(/- \[T-2.*\n/, "");
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-2");
  });

  test("tasks/INDEX.md 链接指向不存在的任务编号 → 拒绝并定位悬空链接", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/INDEX.md`;
      files[path] = files[path].replace(
        "- [T-2 任务 B](02-task-b.md) — 完成规则 B",
        "- [T-2 任务 B](02-task-b.md) — 完成规则 B\n- [T-9 悬空任务](09-missing.md) — 不存在的任务",
      );
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-9");
  });

  test("tasks/INDEX.md 同一任务被链接两次 → 拒绝并定位重复链接", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/INDEX.md`;
      files[path] = files[path].replace(
        "- [T-1 任务 A](01-task-a.md) — 完成规则 A",
        "- [T-1 任务 A](01-task-a.md) — 完成规则 A\n- [T-1 任务 A](01-task-a.md) — 完成规则 A",
      );
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
  });

  test("tasks/INDEX.md 行格式不符合固定模板 → 拒绝并定位", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/INDEX.md`;
      files[path] = files[path].replace(
        "- [T-1 任务 A](01-task-a.md) — 完成规则 A",
        "* T-1 任务 A -> 01-task-a.md : 完成规则 A",
      );
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
  });

  test("生产文件被两个任务重复归属 → 拒绝并定位", async () => {
    const result = await runMutatedFixture((files, root) => {
      const pathB = `${REQUIREMENT_DIR_REL}/tasks/02-task-b.md`;
      const sharedFile = join(root, ".pi-company/src/rule-a.ts");
      files[pathB] = files[pathB].replace(/^files:.*\n/m, `files: [${sharedFile}]\n`);
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
    expect(result.stdout).toContain("T-2");
  });

  test("depends_on 引用编号更大的任务（向后依赖）→ 拒绝并定位 T-1", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`;
      files[path] = files[path].replace(/^depends_on:.*\n/m, "depends_on: [T-2]\n");
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
    expect(result.stdout).toContain("depends_on");
  });

  test("depends_on 形成依赖环 → 拒绝并定位 T-2", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/02-task-b.md`;
      files[path] = files[path].replace(/^depends_on:.*\n/m, "depends_on: [T-2]\n");
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-2");
    expect(result.stdout).toContain("depends_on");
  });

  test("业务规则内联的 Then 原文与规则文件不一致 → 拒绝并定位 T-1，且规则文件 AC 标题为全角冒号时仍可比对", async () => {
    const result = await runMutatedFixture((files) => {
      files[".pi-company/spec/sample/rule-a.md"] = ruleFileWithFullWidthColonHeading("rule-a");
      const path = `${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`;
      files[path] = files[path].replace("- Then: 返回既定结果", "- Then: 返回被篡改的结果");
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
    expect(result.stdout).toContain("AC-1");
  });

  test("业务规则内联的约束原文与规则文件不一致 → 拒绝并定位 T-1", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`;
      files[path] = files[path].replace(
        "- C-1：系统应在触发时返回既定结果",
        "- C-1：系统应在触发时返回不同的结果",
      );
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
  });

  test("refs 引用不存在的验收编号 → 拒绝并定位 T-1", async () => {
    const result = await runMutatedFixture((files) => {
      const path = `${REQUIREMENT_DIR_REL}/tasks/01-task-a.md`;
      files[path] = files[path].replace("refs: [sample/rule-a/AC-1]", "refs: [sample/rule-a/AC-9]");
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("T-1");
    expect(result.stdout).toContain("AC-9");
  });

  test("变更内规则漏一条验收覆盖 → 拒绝并定位 rule-a", async () => {
    const result = await runMutatedFixture((files) => {
      files[".pi-company/spec/sample/rule-a.md"] = ruleFileWithExtraAc("rule-a");
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^FAIL: /m);
    expect(result.stdout).toContain("rule-a");
    expect(result.stdout).toContain("AC-2");
  });
});

describe("输入不可读或类别无法确认时非零退出并定位", () => {
  test("requirements.md 路径不存在 → 退出码 2", async () => {
    const root = await createTempRoot();
    const missing = join(root, "does-not-exist", "requirements.md");
    const result = await runLintTasks(missing);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).toMatch(/^FAIL: /m);
  });

  test("requirements.md 不可读 → 退出码 2 且首行 FAIL 不含堆栈", async () => {
    const root = await createTempRoot();
    const { requirementsPath, files } = await buildValidFixture(root);
    await writeFiles(root, files);
    await chmod(requirementsPath, 0o000);
    const result = await runLintTasks(requirementsPath);
    await chmod(requirementsPath, 0o644);
    expect(result.code).toBe(2);
    const combined = result.stdout + result.stderr;
    expect(combined.split("\n")[0]).toMatch(/^FAIL: /);
    expect(combined).not.toMatch(/^\s*at .+/m);
  });

  test("任务文件不可读 → 退出码 2 且首行 FAIL 不含堆栈", async () => {
    const root = await createTempRoot();
    const { requirementsPath, files } = await buildValidFixture(root);
    await writeFiles(root, files);
    const taskPath = join(root, REQUIREMENT_DIR_REL, "tasks/01-task-a.md");
    await chmod(taskPath, 0o000);
    const result = await runLintTasks(requirementsPath);
    await chmod(taskPath, 0o644);
    expect(result.code).toBe(2);
    const combined = result.stdout + result.stderr;
    expect(combined.split("\n")[0]).toMatch(/^FAIL: /);
    expect(combined).not.toMatch(/^\s*at .+/m);
  });

  test("规则文件不可读 → 退出码 2 且首行 FAIL 不含堆栈", async () => {
    const root = await createTempRoot();
    const { requirementsPath, files } = await buildValidFixture(root);
    await writeFiles(root, files);
    const rulePath = join(root, ".pi-company/spec/sample/rule-a.md");
    await chmod(rulePath, 0o000);
    const result = await runLintTasks(requirementsPath);
    await chmod(rulePath, 0o644);
    expect(result.code).toBe(2);
    const combined = result.stdout + result.stderr;
    expect(combined.split("\n")[0]).toMatch(/^FAIL: /);
    expect(combined).not.toMatch(/^\s*at .+/m);
  });

  test("tasks 目录下与任务文件同名的子目录 → 退出码 2 且首行 FAIL 不含堆栈", async () => {
    const root = await createTempRoot();
    const { requirementsPath, files } = await buildValidFixture(root);
    await writeFiles(root, files);
    const taskPath = join(root, REQUIREMENT_DIR_REL, "tasks/01-task-a.md");
    await rm(taskPath, { force: true });
    await mkdir(taskPath, { recursive: true });
    const result = await runLintTasks(requirementsPath);
    expect(result.code).toBe(2);
    const combined = result.stdout + result.stderr;
    expect(combined.split("\n")[0]).toMatch(/^FAIL: /);
    expect(combined).not.toMatch(/^\s*at .+/m);
  });

  test("输入文件无任何 frontmatter 声明时无法分类 → 退出码 2", async () => {
    const root = await createTempRoot();
    const emptyPath = join(root, "empty-no-frontmatter.md");
    await writeFile(emptyPath, "");
    const result = await runLintTasks(emptyPath);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).toMatch(/^FAIL: /m);
  });

  test("输入文件无法识别类别 → 退出码 2", async () => {
    const root = await createTempRoot();
    const garbage = join(root, "not-a-requirements-doc.md");
    await writeFile(garbage, "这是一段既不是需求文档也不是任务文件的普通文字。\n");
    const result = await runLintTasks(garbage);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).toMatch(/^FAIL: /m);
  });
});

describe("lint.sh --spec 拒绝含实现细节或格式不合法的规则文件", () => {
  test("规则文件含反引号包裹的代码路径 → 非零退出", async () => {
    const root = await createTempRoot();
    const specPath = join(root, "bad-rule.md");
    await writeFile(
      specPath,
      [
        "---",
        "name: bad-rule",
        "description: 含实现细节的规则",
        "---",
        "# 含实现细节的规则",
        "",
        "## 目的",
        "验证黑盒约束。",
        "",
        "## 逻辑",
        "触发后调用 `runtime/x.ts` 处理请求。",
        "",
        "## 约束",
        "- C-1：系统应在触发时返回既定结果",
        "",
        "## 例子",
        "输入触发条件，系统返回既定结果。",
        "",
        "## 验收",
        "### AC-1 基本场景 ← C-1",
        "- 触发: 命令 sample bad-rule",
        "- Given: 系统处于初始状态",
        "- When: 执行命令 sample bad-rule",
        "- Then: 返回既定结果",
        "",
      ].join("\n"),
    );
    const result = await run("bash", [LINT_SH, "--spec", specPath]);
    expect(result.code).not.toBe(0);
  });

  test("规范文件路径不存在 → 退出码 2", async () => {
    const root = await createTempRoot();
    const missing = join(root, "missing-rule.md");
    const result = await run("bash", [LINT_SH, "--spec", missing]);
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).toMatch(/^FAIL: /m);
  });

  test("AC 标题使用全角冒号格式不合法 → 非零退出且 stderr 说明原因", async () => {
    const root = await createTempRoot();
    const specPath = join(root, "bad-ac-heading.md");
    await writeFile(specPath, ruleFileWithFullWidthColonHeading("bad-ac-heading"));
    const result = await run("bash", [LINT_SH, "--spec", specPath]);
    expect(result.code).not.toBe(0);
    expect((result.stdout + result.stderr).trim().length).toBeGreaterThan(0);
  });
});

describe("lint.sh 默认模式与环境依赖的边界", () => {
  test("需求文档不存在 → 退出码 2", async () => {
    const root = await createTempRoot();
    const missing = join(root, "missing-requirements.md");
    const result = await run("bash", [LINT_SH, missing]);
    expect(result.code).toBe(2);
    expect(result.stdout).toMatch(/^FAIL: /m);
  });

  test("PATH 中缺少 bun 时 --tasks 仍以退出码 2 与 FAIL 前缀报告，而非裸命令未找到错误", async () => {
    const root = await createTempRoot();
    const { requirementsPath, files } = await buildValidFixture(root);
    await writeFiles(root, files);
    const result = await runLintTasks(requirementsPath, { PATH: "/usr/bin:/bin" });
    expect(result.code).toBe(2);
    expect(result.stdout + result.stderr).toContain("FAIL:");
  });
});
