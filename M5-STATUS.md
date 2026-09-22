# M5 状态

阶段目标：落实核心工具的专用写入与六类职责权限，保留已有安全保护；正常项目流程排除 prod，不以全面阻断其他工具的正文读取作为首版目标。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 无效批量补丁预检不写；部分失败精确记录并阻塞交付 | 通过 | tests/change-apply.test.ts（提交 5f54714）：整批预检拒绝不留记录；逐文件 written/failed/pending 状态；partial_failure 记录在 change_sets | 交付侧消费 partial_failure 阻塞由 M6 交付凭据接入 |
| AC2 外部编辑/pull 后旧基础拒绝；生成器只导入授权差异 | 通过 | tests/change-apply.test.ts：外部改动 stale_base 不覆盖；分支 head 变化后重试拒绝；import 只从 scratchRoot 按声明指纹导入，越界/指纹不符不落盘 | 无 |
| AC3 worker 不能改 docs/spec、docs/prod、本机 prod；explore 不能提案/发布/写文件；PM 不能改 prod；不跨绑定 worktree 写 | 通过 | tests/core-permissions.test.ts（提交 52c456d）六职责 action 矩阵与写路径分类；tests/change-apply.test.ts 路径 ACL 与 workspace/branch 绑定；tests/spec-change.test.ts（提交 39d8398）只写 .rules.json；tests/explore-capabilities.test.ts（提交 c7b5b88）；PM 不改 prod 沿用 tests/requirement-read-tool.test.ts | 新工具未注册进任何会话，worker/PM 会话接线在 M7 |
| AC4 spec 发布核对批准 prod、候选 hash、实际实现与有效检查证据；检查阶段未释放不写；发布后绑定新基线 | 通过 | tests/spec-change.test.ts：格式与拆分门槛、validation_required、check_phase_active、evidence_required（候选 hash/批准 prod/代码 head 任一不符）、发布后磁盘集合指纹等于 targetSpecSetHash、prod 重新批准后 prod_changed | 检查阶段与证据由宿主 publishGate 回调提供，产品侧尚无提供者即拒绝发布；真实 verification_run 在 M6 |
| AC5 专用工具拒 closed 正文；扫描/查询/上下文排除 docs/prod 与本机 prod；角色说明禁读归档；通用旁路标暂缓 | 通过 | tests/requirement-read-tool.test.ts（closing/closed 拒读且读取探针为零）、tests/knowledge-query.test.ts、tests/prod-exclusion.test.ts、tests/project-index-policy.test.ts（dataRoot 与 worktree 分离）；角色说明 tests/role-prompts.test.ts、tests/main-session-skills.test.ts（提交 2beacd2） | 已知限制见下 |
| AC6 既有目录权限、真实路径/链接、沙箱、写入范围、管理接口保护保持 | 通过 | 本阶段未改动这些模块；回归 tests/role-session.test.ts、tests/security-regressions.test.ts、tests/managed-git.test.ts、tests/write-guard.test.ts、tests/range-claims.test.ts 全绿 | 检查阶段写保护按 M6-AC13 验证 |
| AC7 伪造角色参数、旧 fence/epoch、DB 直写不扩权；备份不回显正文 | 通过 | tests/core-permissions.test.ts 伪造职责/工具/action 拒绝；tests/change-apply.test.ts 与 tests/spec-change.test.ts 的 AC7 用例（非本职责、旧 epoch、旧 fence、他人 run、宿主撤权）；tests/requirement-backup.test.ts、tests/database-transition.test.ts | 无 |
| AC8 日志提交、文件替换、索引发布、关闭边界故障注入可恢复；断电未验证明示 | 通过 | tests/change-apply.test.ts（文件替换失败与日志提交失败后同操作重试按实际指纹续接，不覆盖用户内容）；索引发布 tests/index-store.test.ts；关闭边界 tests/requirement-state.test.ts（关闭事件落库失败回滚、closing 拒绝重开） | 物理断电未验证 |
| AC9 六角色权限表与 action 一致；explore 核心集只 knowledge_query/result_submit，无 prod/私有 DB/派工/bash/MCP/写入；自报不扩权 | 通过 | tests/core-permissions.test.ts（矩阵与已注册工具 action 枚举一致）；tests/explore-capabilities.test.ts（白名单外工具拒绝、prod/DB/密钥/会话路径拒绝、result_submit 只收绑定原输入的 research） | 真实 explore 派出与运行时接线在 M7 |
| AC10 本地与联网分离；未授权网络/外发/越界拒绝；私有内容不外发；能力不足报仅本地/未执行 | 通过 | tests/explore-capabilities.test.ts：network_unauthorized 报 local_only、network_unavailable 报 not_executed、disclosure_unauthorized、域名/查询越界拒绝、请求夹带 grant 不生效 | 真实 search/fetch 实现在 M7 |

已知限制（非首版门槛）：通用 read/Shell/Git 历史/MCP 对 prod 正文的全覆盖防护暂缓；命令沙箱后端仅 darwin；新增工具以工具工厂加夹具宿主验证，尚未注册进会话。

全量回归（2026-09-22，提交 2beacd2 加审查修复）：typecheck 通过；`pnpm test` 148 文件 3915 用例通过、1 跳过、1 失败（tests/project-index-sync.test.ts「归档watch只发无正文metadata」在 4 worker 负载下失败，单独重跑 2/2 通过，本阶段未改该模块，属计时抖动，证据 .bb-spec/.cache/m5/full-regression-01.txt 与 project-index-sync-rerun.txt），耗时 4 分 29 秒；`pnpm run test:integration` 16 文件 97 用例通过，60 秒；`pnpm run test:installation` 5 文件 12 用例通过，85 秒。独立审查（两条威胁模型内）发现 2 条阻塞与 1 条建议修，已修复并补用例（提交 7ab3fd4）：重试按路径配对并在标 applied 前复核指纹；spec 放行判定精确匹配 docs/spec/ 前缀；生成物导入拒绝非 UTF-8 字节。修复后基线 7ab3fd4 第二轮回归（.bb-spec/.cache/m5/full-regression-02.txt）：typecheck 通过；installation 全绿；单元 tests/project-index-sync.test.ts「M3-PERF-PERIODIC-01」与 integration tests/integration/project-index-sync.test.ts「启动失败必须非零退出并清理socket」各失败一例，两文件单独重跑均 2/2 通过（project-index-sync-rerun-02.txt），属 4 worker 并行负载下的计时抖动，本阶段未改动该模块；第三轮（同基线 7ab3fd4，full-regression-03.txt）：`pnpm test` 148 文件 3916 用例通过、1 跳过，4 分 21 秒；`pnpm run test:integration` 16 文件 97 用例通过，61 秒；连同第二轮的 installation 全绿，三条命令在基线 7ab3fd4 上均有通过记录。

## 当前阻塞

无。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md，再读 M5-STATUS.md，核对 git status 与最近提交。M0–M5 已收口不重做。
本窗口任务：M6（计划 §12 M6，AC1–AC21）。先按计划列出验收目标、范围与非目标、验证方法、性能指标、停止条件与复用模块，经用户确认后再动。
M6 可直接复用：runtime/spec-change.ts 的 publishGate 回调（接真实检查阶段令牌与 verification_run 证据）、runtime/change-apply.ts 的 change_sets 状态（交付凭据核对 partial_failure）、runtime/result-submit.ts 的 verdict 动作（当前拒绝）、runtime/core-permissions.ts 的 verification_run/workflow_manage action 表。
验证入口：pnpm run typecheck；pnpm test（单元，约 5 分钟）；pnpm run test:integration（约 1 分钟）；pnpm run test:installation（约 1 分钟）。三条测试命令都绿才算全量绿。
任何新增机制、加固或计划正文修改都必须先经用户拍板；第一版威胁模型只有两条。
待用户决定：周期对账改为发布时原子切换（C-3）。
```
