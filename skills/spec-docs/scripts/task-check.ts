import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

type Change = { domain: string; name: string; type: "新增" | "修改" | "删除" };

type RequirementDoc = {
  path: string;
  requirementDir: string;
  specRoot: string;
  tasksDir: string;
  changes: Change[];
};

type AcEntry = { id: string; cIds: string[]; blockLines: string[] };

type RuleDoc = {
  domain: string;
  name: string;
  exists: boolean;
  constraints: Map<string, string>;
  acs: Map<string, AcEntry>;
};

type ListField = { present: boolean; malformed: boolean; values: string[] };

type TaskFrontmatter = {
  keys: string[];
  id?: string;
  depends_on: ListField;
  files: ListField;
  refs: ListField;
  verify?: string;
};

type TaskDoc = {
  file: string;
  content: string;
  fm: TaskFrontmatter;
  body: string;
};

const REQUIRED_KEYS = ["id", "title", "depends_on", "files", "refs", "verify"];
const REQUIRED_SECTIONS = ["## 目标", "## 业务规则", "## 涉及文件", "## 函数清单", "## 协作关系", "## 验证方式"];

function fail2(msg: string): never {
  console.log(`FAIL: ${msg}`);
  process.exit(2);
}

function extractSection(content: string, heading: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(heading));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

function parseArgs(argv: string[]): string {
  if (argv.length !== 1) fail2("用法: task-check.ts <requirements.md>");
  return argv[0];
}

function loadRequirement(path: string): RequirementDoc {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    return fail2(`${path}: 无法读取: ${(err as Error).message}`);
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) fail2(`${path}: 缺少 frontmatter，无法识别为需求文档`);
  const fm = fmMatch[1];
  if (!/^name:/m.test(fm) || !/^title:/m.test(fm) || !/^created:/m.test(fm)) {
    fail2(`${path}: frontmatter 缺少 name/title/created，无法识别为需求文档`);
  }
  for (const heading of ["## 1.", "## 2.", "## 3.", "## 4."]) {
    if (!content.includes(heading)) fail2(`${path}: 缺少章节 ${heading}，无法识别为需求文档`);
  }

  const requirementDir = resolve(dirname(path));
  const specRoot = resolve(join(requirementDir, "..", "..", "spec"));
  const tasksDir = join(requirementDir, "tasks");

  const section3 = extractSection(content, "## 3.");
  const rowRe = /^\|\s*([a-z0-9-]+)\/([a-z0-9-]+)\s*\|\s*(新增|修改|删除)\s*\|/;
  const changes: Change[] = [];
  for (const line of section3.split("\n")) {
    const m = line.match(rowRe);
    if (m) changes.push({ domain: m[1], name: m[2], type: m[3] as Change["type"] });
  }

  return { path, requirementDir, specRoot, tasksDir, changes };
}

const ruleCache = new Map<string, RuleDoc>();

function loadRule(specRoot: string, domain: string, name: string): RuleDoc {
  const key = `${domain}/${name}`;
  const cached = ruleCache.get(key);
  if (cached) return cached;

  const path = join(specRoot, domain, `${name}.md`);
  const constraints = new Map<string, string>();
  const acs = new Map<string, AcEntry>();
  const exists = existsSync(path);

  if (exists) {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch (err) {
      return fail2(`${path}: 无法读取: ${(err as Error).message}`);
    }
    for (const m of content.matchAll(/^- (C-\d+)：.*$/gm)) {
      constraints.set(m[1], m[0].trimEnd());
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const heading = lines[i].match(/^### (AC-\d+).*←\s*(.+)$/);
      if (!heading) continue;
      const acId = heading[1];
      const cIds = Array.from(heading[2].matchAll(/C-\d+/g)).map((m) => m[0]);
      let end = i + 1;
      while (end < lines.length && !/^#{2,3} /.test(lines[end])) end++;
      const blockLines = lines.slice(i, end).map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
      acs.set(acId, { id: acId, cIds, blockLines });
    }
  }

  const doc: RuleDoc = { domain, name, exists, constraints, acs };
  ruleCache.set(key, doc);
  return doc;
}

function parseListValue(raw: string | undefined): { malformed: boolean; values: string[] } {
  if (raw === undefined) return { malformed: false, values: [] };
  const trimmed = raw.trim();
  const m = trimmed.match(/^\[([^\]]*)\]\s*(?:#.*)?$/);
  if (!m) return { malformed: true, values: [] };
  const inner = m[1].trim();
  const values = inner === "" ? [] : inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return { malformed: false, values };
}

function parseFrontmatter(content: string): { keys: string[]; raw: Record<string, string>; body: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { keys: [], raw: {}, body: content };
  const keys: string[] = [];
  const raw: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const km = line.match(/^([a-zA-Z_]+):\s?(.*)$/);
    if (!km) continue;
    keys.push(km[1]);
    raw[km[1]] = km[2];
  }
  return { keys, raw, body: m[2] };
}

function readTaskFiles(tasksDir: string): { indexContent: string; tasks: TaskDoc[] } {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(tasksDir, { withFileTypes: true });
  } catch (err) {
    return fail2(`${tasksDir}: 无法读取任务目录: ${(err as Error).message}`);
  }

  const indexPath = join(tasksDir, "INDEX.md");
  let indexContent: string;
  try {
    indexContent = readFileSync(indexPath, "utf8");
  } catch (err) {
    return fail2(`${indexPath}: 无法读取: ${(err as Error).message}`);
  }

  const taskFileNames: string[] = [];
  for (const entry of entries) {
    if (entry.name === "INDEX.md" || !entry.name.endsWith(".md")) continue;
    if (!entry.isFile()) fail2(`${join(tasksDir, entry.name)}: 不是常规文件，无法作为任务文件读取`);
    taskFileNames.push(entry.name);
  }
  taskFileNames.sort();

  const tasks: TaskDoc[] = taskFileNames.map((f) => {
    const full = join(tasksDir, f);
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch (err) {
      return fail2(`${full}: 无法读取: ${(err as Error).message}`);
    }
    const { keys, raw, body } = parseFrontmatter(content);
    const fm: TaskFrontmatter = {
      keys,
      id: raw["id"]?.trim(),
      depends_on: { present: raw["depends_on"] !== undefined, ...parseListValue(raw["depends_on"]) },
      files: { present: raw["files"] !== undefined, ...parseListValue(raw["files"]) },
      refs: { present: raw["refs"] !== undefined, ...parseListValue(raw["refs"]) },
      verify: raw["verify"]?.trim(),
    };
    return { file: full, content, fm, body };
  });

  return { indexContent, tasks };
}

function taskLabel(task: TaskDoc): string {
  return task.fm.id ?? task.file;
}

function checkFrontmatter(task: TaskDoc, failures: string[]): void {
  const label = taskLabel(task);
  const keys = task.fm.keys;
  const missing = REQUIRED_KEYS.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !REQUIRED_KEYS.includes(k));
  for (const k of missing) failures.push(`FAIL: ${label}: frontmatter 缺少字段 ${k}`);
  for (const k of extra) failures.push(`FAIL: ${label}: frontmatter 含不允许的运行字段 ${k}`);
  if (missing.length === 0 && extra.length === 0 && keys.join(",") !== REQUIRED_KEYS.join(",")) {
    failures.push(`FAIL: ${label}: frontmatter 字段顺序不符，应为 ${REQUIRED_KEYS.join("/")}`);
  }

  if (task.fm.id && !/^T-\d+$/.test(task.fm.id)) {
    failures.push(`FAIL: ${label}: id 格式不合法: ${task.fm.id}`);
  }

  for (const [name, field] of [
    ["depends_on", task.fm.depends_on],
    ["files", task.fm.files],
    ["refs", task.fm.refs],
  ] as const) {
    if (field.present && field.malformed) {
      failures.push(`FAIL: ${label}: ${name}: 格式不合法，须写成行内 [ ... ] 列表`);
    }
  }

  for (const p of task.fm.files.values) {
    if (!isAbsolute(p)) failures.push(`FAIL: ${label}: files 必须为绝对路径: ${p}`);
  }
  for (const r of task.fm.refs.values) {
    if (!/^[a-z0-9-]+\/[a-z0-9-]+\/AC-\d+$/.test(r)) {
      failures.push(`FAIL: ${label}: refs 格式不合法: ${r}`);
    }
  }
  if (!task.fm.verify) failures.push(`FAIL: ${label}: verify 不能为空`);
}

function checkSections(task: TaskDoc, failures: string[]): void {
  const label = taskLabel(task);
  for (const heading of REQUIRED_SECTIONS) {
    if (!task.body.includes(heading)) {
      failures.push(`FAIL: ${label}: 缺少节 ${heading}`);
      continue;
    }
    if (extractSection(task.body, heading).trim() === "") {
      failures.push(`FAIL: ${label}: 节 ${heading} 为空`);
    }
  }
}

function countTaskLines(content: string): number {
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let count = 0;
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (fenceChar === null) {
      const openMatch = trimmed.match(/^(`{3,}|~{3,})/);
      if (openMatch) {
        fenceChar = openMatch[1][0];
        fenceLen = openMatch[1].length;
        continue;
      }
      count++;
    } else {
      const closeRe = new RegExp(`^${fenceChar}{${fenceLen},}$`);
      if (closeRe.test(trimmed)) {
        fenceChar = null;
        fenceLen = 0;
      }
    }
  }
  if (fenceChar !== null) throw new Error("未闭合的代码块围栏");
  return count;
}

function classifyFile(task: TaskDoc): string[] {
  const label = taskLabel(task);
  const section = extractSection(task.body, "## 涉及文件");
  const productionPaths: string[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;
    const m = trimmed.match(/^- (新建|修改)（(生产|测试|非生产)）：(.+?) — (.+)$/);
    if (!m) fail2(`${label}: 涉及文件行缺少类别声明: ${trimmed}`);
    if (m[2] === "生产") productionPaths.push(m[3]);
  }
  return productionPaths;
}

function checkFilesConsistency(task: TaskDoc, productionPaths: string[], failures: string[]): void {
  const label = taskLabel(task);
  const frontmatterSet = new Set(task.fm.files.values);
  const bodySet = new Set(productionPaths);
  const mismatch =
    productionPaths.some((p) => !frontmatterSet.has(p)) || task.fm.files.values.some((p) => !bodySet.has(p));
  if (mismatch) {
    failures.push(`FAIL: ${label}: files 与涉及文件节声明的生产路径不一致`);
  }
}

function checkFileOwnership(tasks: TaskDoc[], failures: string[]): void {
  const owners = new Map<string, string[]>();
  for (const task of tasks) {
    const label = taskLabel(task);
    if (task.fm.files.values.length > 2) failures.push(`FAIL: ${label}: files 生产文件超过 2 个`);
    for (const f of task.fm.files.values) {
      const list = owners.get(f) ?? [];
      list.push(label);
      owners.set(f, list);
    }
  }
  for (const [file, labels] of owners) {
    if (labels.length > 1) {
      failures.push(`FAIL: ${labels.join(", ")}: 生产文件被多个任务持有: ${file}`);
    }
  }
}

function checkDependencyGraph(tasks: TaskDoc[], failures: string[]): void {
  const ids = new Set(tasks.map((t) => t.fm.id).filter((id): id is string => Boolean(id)));
  for (const task of tasks) {
    const label = taskLabel(task);
    if (!task.fm.id) continue;
    const selfNum = Number(task.fm.id.slice(2));
    for (const dep of task.fm.depends_on.values) {
      if (!ids.has(dep)) {
        failures.push(`FAIL: ${label}: depends_on 引用不存在的任务 ${dep}`);
        continue;
      }
      const depNum = Number(dep.slice(2));
      if (!(depNum < selfNum)) {
        failures.push(`FAIL: ${label}: depends_on 只能引用编号更小的任务，实际引用 ${dep}`);
      }
    }
  }
}

function checkIndex(indexContent: string, tasks: TaskDoc[], failures: string[]): void {
  const lines = indexContent.split("\n");
  const countable = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  if (countable > 30) failures.push(`FAIL: tasks/INDEX.md: 超过 30 行`);

  const realIds = new Set(tasks.map((t) => t.fm.id).filter((id): id is string => Boolean(id)));
  const linkCounts = new Map<string, number>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || !/T-\d+/.test(trimmed)) continue;
    const m = trimmed.match(/^- \[(T-\d+)[^\]]*\]\([^)]+\) — .+$/);
    if (!m) {
      failures.push(`FAIL: tasks/INDEX.md 行格式不合法: ${trimmed}`);
      continue;
    }
    const id = m[1];
    linkCounts.set(id, (linkCounts.get(id) ?? 0) + 1);
  }

  for (const [id, count] of linkCounts) {
    if (!realIds.has(id)) failures.push(`FAIL: ${id}: tasks/INDEX.md 链接指向不存在的任务`);
    if (count > 1) failures.push(`FAIL: ${id}: tasks/INDEX.md 重复链接`);
  }

  for (const task of tasks) {
    if (task.fm.id && !linkCounts.has(task.fm.id)) {
      failures.push(`FAIL: ${task.fm.id}: tasks/INDEX.md 未收录该任务的索引链接`);
    }
  }
}

function checkRefs(task: TaskDoc, specRoot: string, failures: string[]): void {
  const label = taskLabel(task);
  if (task.fm.refs.values.length > 3) failures.push(`FAIL: ${label}: refs 超过 3 条`);

  const bizSection = extractSection(task.body, "## 业务规则");
  const seenDomains = new Set<string>();

  for (const ref of task.fm.refs.values) {
    const m = ref.match(/^([a-z0-9-]+)\/([a-z0-9-]+)\/(AC-\d+)$/);
    if (!m) continue;
    const [, domain, name, acId] = m;
    const domainKey = `${domain}/${name}`;
    const rule = loadRule(specRoot, domain, name);
    if (!rule.exists) {
      failures.push(`FAIL: ${label}: refs 引用的规范不存在 ${domainKey}`);
      continue;
    }
    const ac = rule.acs.get(acId);
    if (!ac) {
      failures.push(`FAIL: ${label}: refs 引用了不存在的验收 ${ref}`);
      continue;
    }

    if (!seenDomains.has(domainKey)) {
      seenDomains.add(domainKey);
      if (!bizSection.includes(`来源：${domainKey}。`)) {
        failures.push(`FAIL: ${label}: 业务规则节缺少来源声明 来源：${domainKey}。`);
      }
    }

    const missingLine = ac.blockLines.find((line) => !bizSection.includes(line));
    if (missingLine) {
      failures.push(`FAIL: ${label}: 业务规则与规范原文不一致 (${ref})`);
    }

    for (const cId of ac.cIds) {
      const cText = rule.constraints.get(cId);
      if (cText && !bizSection.includes(cText)) {
        failures.push(`FAIL: ${label}: 业务规则未逐字包含 ${domainKey}/${cId}`);
      }
    }
  }
}

function checkCoverage(req: RequirementDoc, tasks: TaskDoc[], failures: string[]): void {
  const referenced = new Set<string>();
  for (const task of tasks) {
    for (const ref of task.fm.refs.values) referenced.add(ref);
  }

  for (const change of req.changes) {
    const domainKey = `${change.domain}/${change.name}`;
    if (change.type === "删除") {
      if (loadRule(req.specRoot, change.domain, change.name).exists) {
        failures.push(`FAIL: ${domainKey}: 标记删除但规范文件仍存在`);
      }
      continue;
    }
    const rule = loadRule(req.specRoot, change.domain, change.name);
    if (!rule.exists) {
      failures.push(`FAIL: ${domainKey}: 规范文件不存在`);
      continue;
    }
    for (const acId of rule.acs.keys()) {
      if (!referenced.has(`${domainKey}/${acId}`)) {
        failures.push(`FAIL: ${domainKey}: ${acId} 未被任何任务的 refs 覆盖`);
      }
    }
  }
}

function snapshotDir(dir: string): string {
  if (!existsSync(dir)) return "";
  const parts: string[] = [];
  const walk = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const s = statSync(full);
        parts.push(`${full}:${s.size}:${s.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return parts.join("|");
}

function checkReadOnly(before: string, after: string, failures: string[]): void {
  if (before !== after) failures.push(`FAIL: 内部错误: 检查过程中修改了 .pi-company 下的文件`);
}

function report(failures: string[]): never {
  if (failures.length === 0) {
    console.log("PASS: 仅证明任务机械条件，不证明行为正确");
    process.exit(0);
  }
  for (const f of failures) console.log(f);
  process.exit(1);
}

function main(): void {
  try {
    const path = parseArgs(process.argv.slice(2));
    const req = loadRequirement(path);
    const { indexContent, tasks } = readTaskFiles(req.tasksDir);

    const before = snapshotDir(req.requirementDir) + "||" + snapshotDir(req.specRoot);

    const failures: string[] = [];

    for (const task of tasks) {
      checkFrontmatter(task, failures);
      checkSections(task, failures);
      try {
        const count = countTaskLines(task.content);
        if (count > 200) failures.push(`FAIL: ${taskLabel(task)}: 任务文件超过 200 行（计数 ${count} 行）`);
      } catch (err) {
        failures.push(`FAIL: ${taskLabel(task)}: ${(err as Error).message}`);
      }
      const productionPaths = classifyFile(task);
      checkFilesConsistency(task, productionPaths, failures);
      checkRefs(task, req.specRoot, failures);
    }

    checkFileOwnership(tasks, failures);
    checkDependencyGraph(tasks, failures);
    checkIndex(indexContent, tasks, failures);
    checkCoverage(req, tasks, failures);

    const after = snapshotDir(req.requirementDir) + "||" + snapshotDir(req.specRoot);
    checkReadOnly(before, after, failures);

    report(failures);
  } catch (err) {
    console.log(`FAIL: ${(err as Error).message ?? String(err)}`);
    process.exit(2);
  }
}

main();
