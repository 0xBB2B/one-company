# M4 状态

阶段目标：用户可逐步确认需求，代理按权限读取正确目标；PM 接手需求侧复核契约成立；当前知识查询只命中代码与 spec。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 prod 自包含可理解 | 通过 | tests/main-requirement-interaction.test.ts、tests/prod-view.test.ts；真实模型语义试用 S1–S7（.bb-spec/.cache/m4-closeout/semantic-trial-01） | 语义证据为一次真实模型试用，不是生产 Interpreter 请求路径 |
| AC2 draft 仅主代理读写、受限 PM 只读已批准基线 | 通过 | tests/requirement-read-tool.test.ts、tests/requirement-role-reader.test.ts、tests/integration/requirement-role-reader.test.ts | 无 |
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

全量回归（2026-09-18）：typecheck 通过；vitest 173 个文件全部通过，4108 个用例通过、1 个跳过，耗时 77 分钟。提交号：d2d1dc4（探针链删除）、ca84d2c（收口的产品与测试改动），文档与纪律条款为其后一次提交。

## 性能

需求正文每次保存操作执行约 25 条 Git 命令并经独立 worker 进程会话，单次操作 400–700ms；测试默认超时因此从 5 秒放宽到 30 秒。查询正式基准（1000 文件、每档 100 样本、500ms/2000ms 门槛，2026-09-18 运行，输出 .bb-spec/.cache/m4-closeout/bench/formal-01）：未通过。900 个样本中 682 个失败：多数立即返回 index_not_fresh，其余等待约 14 秒后同样返回 index_not_fresh；218 个成功样本的 p95 为 36–40 秒，远超 500ms/2000ms 门槛。查询路径在 1000 文件规模下既慢又长时间判定索引未就绪，属于产品性能缺陷，未在本次收口中修复，待用户决定是否单开任务。

## 当前阻塞

无。

## 已批准的后续任务

1. Git 子系统减重：删除 PATH 逐段绑定、排除根预算、跨进程 gitExpectation、Git worker 会话、sandbox-exec 与 ExecutionGuard，只保留"安装时缺 Git 非零退出"和"运行时用 PATH 上的 git 执行固定参数"两条验收。预计删约 6000 行，需求保存速度提升 5 倍以上。
2. M5 在 1 完成后开始。

## 候选清理（未批准，不动）

- extensions/decision-record.ts 为空壳扩展；runtime/decisions.ts 与 decision-record-tool.ts 只剩抛"已淘汰"的桩，13 个测试文件引用它们。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md，再读 M4-STATUS.md，核对 git status 与最近提交。
本窗口任务：执行 M4-STATUS.md「已批准的后续任务」第 1 项 Git 子系统减重。验收只有两条：安装时缺 Git 非零退出；运行时用 PATH 上的 git 执行固定参数。开工前先列出要删除的文件与要改的测试，给出最小方案和代价，经用户确认后再动。
任何新增机制、加固或计划正文修改都必须先经用户拍板。
```
