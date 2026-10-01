# M8E 状态

阶段目标：需求里涉及界面的任务，先由 worker 做一个能在浏览器打开的 HTML 原型给用户看，用户确认后才允许派出实现 worker。网页界面直接做成网页，终端界面用网页模拟终端。原型只用来看效果，不是实现代码。

范围与非目标：按计划 M8E 一节。不做截图比对或像素级核对；程序不判断任务是否涉及界面，由 PM 标记、reviewer 把关；原型不进业务仓库、不进业务提交；不改需求批准流程；主代理自己的工作不受这条约束。

验证方法：每条 AC 有对应测试；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全绿。类型检查不包含 `tests/`，改过的测试文件实际运行确认。

性能指标：不适用。

停止条件：出现 AGENTS.md「停止规则」任一情况；面板事项、决策包和确认窗口的预览未经用户确认前不写界面实现代码；计划没写明的做法（原型怎么派、原型 worker 的工具、大小上限、reviewer 与 QA 怎么拿到原型、存放位置）未经用户决定前不实施。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 worker 能提交 HTML 原型，程序存入本机需求数据目录并记版本与指纹，不写业务仓库；超出大小上限拒绝并写明原因；非 worker 不能提交 | 未开始 | 无 | 等用户决定大小上限与存放位置 |
| AC2 原型提交后面板出现"待你确认原型"事项；打开时在默认浏览器打开原型，决策包给出文件路径；通过或返工按原话登记，返工意见交回 PM | 未开始 | 无 | 等用户确认预览 .bb-spec/.cache/ui-preview/m8e-prototype-confirm.html |
| AC3 界面任务没有已通过原型时派实现 worker 被拒并写明原因；通过后可以派出；原型出新版本后旧的通过失效；PM 与其他代理不能替用户通过 | 未开始 | 无 | 等用户决定原型怎么派 |
| AC4 reviewer 与 QA 的输入里带有已通过原型，角色说明写明核对要求；非界面任务流程不受影响，现有测试全部通过 | 未开始 | 无 | 等用户决定 reviewer 与 QA 怎么拿到原型 |
| AC5 真实模型的界面需求验收并入 M9-AC13 | 不在本阶段运行 | 无 | M9 重跑；届时验收宿主对原型确认自动选"通过"，并且不真的打开浏览器 |

## 当前阻塞

等用户决定计划没写明的做法，并确认界面预览。

本机睡眠定时偏慢：2026-10-01 用 python3 睡 10 毫秒 20 次，应为 200 毫秒，实测 618 毫秒。`tests/database-initialization.test.ts` 与 `tests/helpers/project-index-installed-fixture.test.ts` 各有 1 条等锁计时测试预计失败，按用户 2026-10-01 的决定算本机环境问题，不改代码。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
M8E 进行中。先完整读 AGENTS.md、SQLITE-KNOWLEDGE-REBUILD-PLAN.md 的 M8E 一节和 M8E-STATUS.md，核对 git status 与最近提交，再按状态表里的剩余缺口继续。M8E 完成后恢复 M9（重跑 AC12、AC13；AC12 含 M8D2-AC6 的规范分流场景，AC13 含 M8E 的原型确认流程）。
界面改动必须先做 HTML 预览（放 .bb-spec/.cache/ui-preview/，终端界面用 HTML 模拟 80 列终端），用户说"可以"后才写实现代码。
本机睡眠定时偏慢时，tests/database-initialization.test.ts 与 tests/helpers/project-index-installed-fixture.test.ts 各有 1 条等锁计时测试会失败，与代码无关；先用 python3 测一下睡 10 毫秒 20 次的实际用时再判断。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。类型检查不包含 tests/ 下的文件，改测试文件后要实际运行确认。
```
