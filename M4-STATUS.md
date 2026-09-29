# M4 状态

阶段目标：用户可逐步确认需求，代理按权限读取正确目标；PM 接手需求侧复核契约成立；当前知识查询只命中代码与 spec。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 prod 自包含可理解 | 通过 | tests/main-requirement-interaction.test.ts、tests/prod-view.test.ts；真实模型语义试用 S1–S7（.bb-spec/.cache/m4-closeout/semantic-trial-01） | 语义证据为一次真实模型试用，不是生产 Interpreter 请求路径 |
| AC2 draft 仅主代理读写、受限 PM 只读已批准基线 | 通过 | tests/requirement-read-tool.test.ts | 无 |
| AC3 长段输入区分目标/约束/排除/未来/委托/动作 | 通过 | tests/user-interaction.test.ts、tests/host-result-currentness.test.ts；语义试用 S1–S3 | 语义证据有限，同 AC1 |
| AC4 伪主体、伪 role、旧 hash 不产生授权 | 通过 | tests/main-requirement-interaction.test.ts、tests/security-regressions.test.ts、tests/legacy-retire-safety.test.ts、tests/legacy-workflow-retired.test.ts | 无 |
| AC5 中文查询命中代码/spec、不命中 prod、closed 拒绝 | 通过 | tests/knowledge-query.test.ts、tests/knowledge-query-tool.test.ts、tests/prod-exclusion.test.ts | 无 |
| AC6 大小边界与职责拆分检查 | 通过 | tests/spec-analysis.test.ts；语义试用 S6 | 语义证据有限 |
| AC7 重复/互斥/例外区分 | 通过 | tests/spec-analysis.test.ts；语义试用 S7 | 语义证据有限 |
| AC8 未知性能与历史结果不冒充当前通过 | 通过 | tests/knowledge-query.test.ts、tests/host-result-currentness.test.ts、tests/m4-query-benchmark.test.ts | 正式性能测量见下方"性能" |
| AC9 手机号登录夹具：分析授权与实施授权分离 | 通过 | tests/user-interaction.test.ts、tests/main-requirement-interaction.test.ts；语义试用 S1/S2 | 语义证据有限 |
| AC10 短答/长答入库、取代关系、会话清空不阻塞 | 通过 | tests/short-decisions.test.ts、tests/user-interaction.test.ts | 无 |
| AC11 短结论限制与批量拼接拒绝 | 通过 | tests/short-decisions.test.ts | 无 |
| AC12 接手契约覆盖目标/非目标/约束/动作/未决 | 通过 | tests/pm-intake-contracts.test.ts、tests/pm-intake-service.test.ts、tests/main-intake-interaction.test.ts、tests/integration/pm-intake-interaction.test.ts | 无 |
| AC13 核对记录绑定 requirementId/hash/范围/epoch | 通过 | tests/pm-intake-store.test.ts 及同前缀文件 | 无 |
| AC14 首次/新 PM/丢基线/连续追加区分 | 通过 | tests/pm-intake-service-currentness.test.ts、tests/pm-intake-contracts.test.ts | 无 |
| AC15 explore 双父输入输出契约 | 通过 | tests/explore-contracts.test.ts | 无 |

全量回归（2026-09-19，Git 子系统减重后）：typecheck 通过；vitest 165 个文件全部通过，3994 个用例通过、1 个跳过，耗时 20 分钟。提交号：daf72e2（正文存储与只读查询直接调 PATH git）、fde4189（删跨进程 gitExpectation 与 Git worker 会话）、875e812（删 ExecutionGuard 与 Git 沙箱包装）。

## 性能

需求正文保存（updateDraft，同机空闲、30 轮、Node v26.8.2，脚本与结果在 .bb-spec/.cache/git-slimming/save-timing-*.json）：减重前中位 811ms、p95 857ms；减重后中位 212ms、p95 235ms，约 3.8 倍。全量测试从 77 分钟降到 20 分钟。测试默认超时仍为 30 秒，未回调。

查询正式基准（1000 文件、每档 100 样本、500ms/2000ms 门槛，输出 .bb-spec/.cache/git-slimming/bench/formal-02）：未通过。2026-09-19 在提交 875e812 上运行，总耗时 7 小时 57 分。900 个样本中 899 个成功、1 个 index_not_fresh（减重前 682 个失败，多为 index_not_fresh）；成功样本三类查询、三档 closed 元数据规模下 p95 均为 31–33 秒，中位 31.8 秒，远超 500ms/2000ms 门槛。减重消除了索引未就绪失败，但查询本身约 32 秒的耗时与 Git 子系统无关。

最小改法（提交 3362d48）：一次查询只做一次索引重建，回执核对改为枚举加哈希。formal 基准重跑（输出 .bb-spec/.cache/git-slimming/bench/formal-03，耗时 3 小时 6 分）：query 中位 11.6 秒、check 中位 1.8 秒、合计中位 13.5 秒，仍远超门槛；另有 180 个样本（每 5 个 1 个）因未消费游标的缓存在 30 秒内累计到 2 MiB 上限而报 resource_limit，此前查询超过 30 秒时游标先过期所以未暴露。剩余耗时主要是每次查询无条件执行的索引 refresh（约 7–8 秒）和逐文件哈希（约 1.8 秒）。

方案 B+（提交 2e11437）：索引稳定时用 stat 快照校验并复用哈希，查询当前性只绑定内容，查询路径与后台对账互斥并在发布窗口有界重试，游标缓存满淘汰最旧。formal 基准重跑（2026-09-19，输出 .bb-spec/.cache/git-slimming/bench/formal-07，耗时 1 小时 17 分）：900 样本 0 失败；check 中位 25ms；query 中位 4.2 秒、p95 10.4 秒，仍未达门槛。剩余耗时：查询主体 readCurrentForQuery 每次把全部文件正文读两遍并逐个哈希后在内存里匹配（1000 文件约 4 秒），以及每 30 秒一次约 7 秒的周期对账期间查询需等待（p95 由此抬到 10 秒）。

方案 C-2（提交 9cb6edf）：匹配阶段只用索引片段，只对命中文件读磁盘正文核对；许可持久核验在同一同步执行段内只做一次（此前每路径一次数据库读取，1000 文件一次查询约 3000 次、2.3 秒）。formal 基准（2026-09-20，输出 .bb-spec/.cache/git-slimming/bench/formal-09，整轮 3 分 25 秒）：通过。900 样本 0 失败；三类查询在 0/1000/10000 条 closed 元数据下合计 p95 178–232ms，均在 500ms/2000ms 门槛内；query 中位 159ms、check 中位 17ms、最大 4.4 秒（撞上周期对账等待）。全量回归（2026-09-20）：165 文件，3997 用例通过、1 跳过，20 分钟；tests/role-session.test.ts 中"工具调用挂死时 stop() …"一例在全量负载下报 uncertain，单独重跑 2/2 通过，属计时抖动，未改动。

## 当前阻塞

无。

## 已批准的后续任务

1. M5（计划 §12 M5，AC1–AC10）。开工前先列出验收目标、范围与非目标、验证方法、性能指标，经用户确认后再动。

待用户决定（未批准，不动）：
- 周期对账改为发布时原子切换（C-3）：消除查询撞上 30 秒周期对账时最长约 4–7 秒的等待。

已完成：测试入口整理与文件级并行（2026-09-20）：`pnpm test` 只跑单元测试，`pnpm run test:integration` 与 `pnpm run test:installation` 分别覆盖其余，三条命令合计覆盖全部 165 个文件。vitest.config 改为 fileParallelism: true、maxWorkers: 4（用户批准前先以命令行参数连跑三轮单元套件全绿无抖动，证据在 .bb-spec/.cache/git-slimming/test-entry/parallel-*.txt）。并行配置下三条命令耗时：单元 144 文件 4 分 43 秒（串行 15 分 30 秒），integration 16 文件 1 分 2 秒，installation 5 文件 47 秒，全部通过。

已完成：知识查询性能修复（2026-09-20，提交 3362d48、2e11437、9cb6edf）：formal 基准从 p95 32 秒、682 失败到 p95 约 200ms、0 失败，门槛通过；已知限制是每 30 秒周期对账约 7 秒期间查询等待（单样本最大 4.4 秒），是否改为发布时原子切换（C-3）待用户决定。

已完成：Git 子系统减重（2026-09-19）。验收两条均成立：preinstall 缺 Git 非零退出并提示（tests/git-prerequisite.test.ts、tests/installation/git-prerequisite.test.ts）；运行时直接用 PATH 上的 git 执行固定参数，不做其他核验。角色 bash 命令沙箱保留。净删约 6800 行。

## 候选清理（未批准，不动）

- extensions/decision-record.ts 为空壳扩展；runtime/decisions.ts 与 decision-record-tool.ts 只剩抛"已淘汰"的桩，13 个测试文件引用它们。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md，再读 M4-STATUS.md，核对 git status 与最近提交。
本窗口任务：M5（计划 §12 M5，AC1–AC10）。先按计划 §12 M5 列出验收目标、范围与非目标、验证方法、性能指标，经用户确认后再动。
验证入口：pnpm run typecheck；pnpm test（单元，约 5 分钟）；pnpm run test:integration（约 1 分钟）；pnpm run test:installation（约 1 分钟）。三条测试命令都绿才算全量绿；vitest 已按 4 worker 并行。
任何新增机制、加固或计划正文修改都必须先经用户拍板；第一版威胁模型只有两条。
```
