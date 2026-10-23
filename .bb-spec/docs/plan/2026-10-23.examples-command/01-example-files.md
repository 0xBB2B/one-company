---
name: example-files
description: 读包里的样例，按层判每个文件和 AGENTS.md 那一段的状态，算出合并后的 AGENTS.md，只复制缺的文件
---
# 样例文件的状态判定与复制

## 目标
程序能列出包里的设计规范样例，判出它在某一层每个文件、AGENTS.md 那一段和整体的状态，算出合并后的 AGENTS.md 和是否超限，并把缺的文件复制过去。

## 业务规则（来源：PRD choose-and-copy、agents-md-section）
- 样例 = 包内 `examples/` 下的每个子目录，按目录名排序。中文名固定：golang →「Go 后端」，vue →「Vue 前端」；没有中文名的目录用目录名本身。
- 样例文件：skills 是 `examples/<样例>/skills/<名字>/` 下的每个文件（含子目录里的），复制到目标层 `skills/<名字>/` 下同一相对路径；定义是 `examples/<样例>/agents/<名字>.md`，复制到目标层 `agents/<名字>.md`。
- 文件状态：目标没有 →「未复制」(missing)；有且逐字节相同 →「已一致」(same)；有但不同 →「被改过」(changed)。
- 一个 skill 的状态：目录里任一文件被改过 → changed；否则任一文件未复制 → missing（会新复制）；否则 same。定义按单个文件。
- AGENTS.md 那一段：样例 `AGENTS.md` 第一行是它的标题（如「## 后端设计约定」）。目标 AGENTS.md 中从第一处整行等于标题的行开始，到下一个以「## 」开头的行之前（没有就到末尾）为止。目标不存在或没有这一行 → missing；那一段和样例全文各自去掉末尾空白后相同 → same；否则 changed。
- 样例在一层的整体状态：所有文件 missing 且那一段 missing →「未复制」；所有文件 same 且那一段 same →「已复制」；任一文件 changed 或那一段 changed →「有改动」；其余 →「部分复制」。项目层未受信任时不看文件，直接「未受信任」（由调用方决定，本单元只给前四种）。
- 合并后的 AGENTS.md：目标不存在 → 样例全文；存在 → 原内容去掉末尾的换行 + "\n\n" + 样例全文。按 UTF-8 计字节，大于 16384（`MAX_CONVENTIONS_BYTES`）算超限；正好 16384 不算。超出量 = 字节数 − 16384。
- 复制：只写状态为 missing 的文件，缺的目录一并创建；same、changed 的文件不碰（内容和修改时间都不变）。写某个文件失败时立刻停下，已写好的保留，报出已写数量、失败文件所在目录和错误码。

## 涉及文件
- `src/modules/settings/spec-examples.ts`（新建）
- `tests/spec-examples-files.test.ts`（新建）

## 函数清单
### src/modules/settings/spec-examples.ts
| 函数名 | 职责 |
|---|---|
| `EXAMPLE_LABELS` | 常量：样例目录名 → 中文名 |
| `examplesDir` | 包内 `examples/` 的绝对路径（与 `defaultRoleDir()` 同级） |
| `listExamples` | 列出样例目录（只要目录，按名排序），带中文名 |
| `layerTargets` | 按层给出目标 skills 目录、agents 目录、AGENTS.md 路径：用户层取 pi 代理目录，项目层取主仓库目录下 `.pi/` 与根目录 |
| `inspectExample` | 读样例和一层的目标位置，返回每个 skill、每个定义的状态、那一段的标题与状态、整体状态 |
| `findSection` | 在目标 AGENTS.md 文本里按标题切出那一段 |
| `mergeConventions` | 给出合并后的全文、字节数、是否超限、超出量 |
| `copyExampleFiles` | 按 `inspectExample` 的结果写入 missing 的文件，返回写入的文件路径；失败抛 `ExampleCopyError` |
| `ExampleCopyError` | 错误类：带 `written`（已写数量）、`dir`（失败文件所在目录）、`code`（底层错误码） |

## 协作关系
- 读写文件用 `node:fs/promises`；`MAX_CONVENTIONS_BYTES` 从 `src/modules/verification/project-conventions.ts` 引入；`defaultRoleDir` 从 `src/modules/agents/roles.ts` 引入（settings 模块排在两者之后，可以引用）。
- `copyExampleFiles` 依赖 `inspectExample` 的结果，不重新判定。
- 本单元不弹窗、不写 AGENTS.md、不读信任状态；这些由 `examples-extension.ts` 负责。

## 验证方式
- 测试入口：从 `src/modules/settings/spec-examples.ts` 导入 `EXAMPLE_LABELS`、`examplesDir`、`listExamples`、`inspectExample`、`mergeConventions`、`copyExampleFiles`、`ExampleCopyError`。
  - `inspectExample({ examplesDir, example, targets: { skillsDir, agentsDir, conventionsFile } })` → `{ skills: Array<{ name, state, files: Array<{ path, state }> }>, agents: Array<{ name, path, state }>, section: { heading, state }, overall }`；`state` 取 `"missing" | "same" | "changed"`，`overall` 取 `"未复制" | "部分复制" | "已复制" | "有改动"`；`path` 是目标位置的绝对路径。
  - `mergeConventions(before: string | null, example: string)` → `{ content, bytes, over, excess }`。
  - `copyExampleFiles({ examplesDir, example, targets, inspection })` → 写入的目标文件绝对路径数组。
- 测试输入：用包里真实的 `examples/`，目标层放在临时目录里，按需预先写入相同、改过、缺失的文件和 AGENTS.md。
- 预期结果：
  - [ ] `listExamples()` 按序给出 golang（Go 后端）、vue（Vue 前端）；`examples/` 下每个子目录在 `EXAMPLE_LABELS` 里都有中文名（这条测试在新增样例目录却没加中文名时失败）。
  - [ ] 空目标：golang 的 10 个 skill、2 个定义、那一段全是 missing，overall「未复制」。
  - [ ] 把 golang 全部文件原样放好、AGENTS.md 里有一致的那一段：全是 same，overall「已复制」。
  - [ ] 文件全一致但 AGENTS.md 没有那一段：overall「部分复制」。
  - [ ] 改动一个 skill 的 `SKILL.md`：这个 skill 为 changed，overall「有改动」；那一段内容改了一条（文件全一致）：section changed，overall「有改动」。
  - [ ] 那一段后面还有别的「## 」二级标题：只比较到下一个二级标题之前；那一段末尾多几个空行仍算 same。
  - [ ] `mergeConventions(null, x)` 的 content 等于 x；`mergeConventions("a\n\n", x)` 的 content 等于 `"a\n\n" + x`；合并后 16384 字节 over 为 false，16385 字节 over 为 true、excess 为 1。
  - [ ] 用仓库根 `AGENTS.md`（12186 字节）和 golang 样例合并：bytes 17024，excess 640。
  - [ ] `copyExampleFiles` 只写 missing 的文件：写后与样例逐字节相同；changed、same 的文件内容和修改时间不变；返回值只含新写的路径。
  - [ ] 目标 skills 目录设成只读后复制：抛 `ExampleCopyError`，`code` 为 `EACCES`（或 `EPERM`），`written` 等于失败前已写的数量，之前写好的文件还在。
