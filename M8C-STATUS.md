# M8C 状态

阶段目标：需求文档规范改为可自定义的 `requirement-doc` skill，包内默认为背景、需求、功能、实现、验收五大板块，程序守住每个标题有唯一编号、标出两段记录的插入板块、批准时按板块清单核对的底线；批准时保存规范快照。另外各停止路径写明停止原因。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 零自定义用包内默认 skill，行为与 M8A 一致 | 未开始 | 无 | 全部 |
| AC2 查找顺序项目 > 用户 > 包内，未受信任项目的 skill 不生效 | 未开始 | 无 | 全部 |
| AC3 自定义规范下批准核对、PM 接手、归档记录插入位置都正确 | 未开始 | 无 | 全部 |
| AC4 skill 无效时批准报错并写明原因，不退回默认 | 未开始 | 无 | 全部 |
| AC5 批准后修改 skill，已批准需求按快照归档，新需求按新规范 | 未开始 | 无 | 全部 |
| AC6 调试沙箱与 change_apply 都不能写 .pi/skills | 未开始 | 无 | 全部 |
| AC7 真实模型用自定义规范完整跑通一次 | 未开始 | 无 | 全部 |
| AC8 各停止路径写明原因，续租失败记错误码，只记录不改行为 | 未开始 | 无 | 全部 |

## 当前阻塞

无。计划正文与本表已按用户 2026-09-28 的批准写入，尚未开工。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（§5.1、§8.9、§12 的 M8A、M8C、M9），再读 M8C-STATUS.md、M8A-STATUS.md 与 M9-STATUS.md，核对 git status 与最近提交。M0–M8、M8A、M8B 已收口，当前执行 M8C，M9 暂停到 M8C 完成。
M8C 用户已定：需求文档规范由 requirement-doc skill 定义（frontmatter 板块清单并标出实现记录、验收记录的插入板块；正文注入主会话）；查找顺序项目 .pi/skills（受信任）> 用户 agentDir/skills > 包内默认；程序固定每个标题有唯一编号、必须标出两段记录的插入板块、批准时按清单核对；批准时保存板块清单与 skill hash 快照，修改只影响新需求；skill 无效即报错不退回默认；解释器与草稿核验器提示词通用化；change_apply 与调试沙箱不能写 .pi/skills；PM、角色子代理与 explore 各停止路径写明原因、续租失败记错误码（第 56 轮 PM 被宿主中止，疑似 daemon/run-manager.ts:307 续租失败，停止不记原因无法确认）。
按 TDD 实施；同一 worktree 还有 e9 会话，改计划正文、rules/、agents/、daemon/ 前先用 SendMessage 与它排先后。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation；真实模型 PI_COMPANY_ACCEPTANCE_MODEL=5x/gpt-6-luna PI_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance（后台运行，证据目录 events.jsonl 10 分钟无更新就在该目录放 STOP 文件）。
```
