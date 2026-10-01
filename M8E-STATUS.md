# M8E 状态

阶段目标：需求里涉及界面的任务，先由 worker 做一个能在浏览器打开的 HTML 原型给用户看，用户确认后才允许派出实现 worker。网页界面直接做成网页，终端界面用网页模拟终端。原型只用来看效果，不是实现代码。

范围与非目标：按计划 M8E 一节。不做截图比对或像素级核对；程序不判断任务是否涉及界面，由 PM 标记、reviewer 把关；原型不进业务仓库、不进业务提交；不改需求批准流程；主代理自己的工作不受这条约束；面板里其他事项仍按回车插入决策包。

验证方法：每条 AC 有对应测试；`pnpm run typecheck`、`pnpm test`、`pnpm run test:integration`、`pnpm run test:installation` 全绿。类型检查不包含 `tests/`，改过的测试文件实际运行确认。

性能指标：不适用。

停止条件：出现 AGENTS.md「停止规则」任一情况；界面预览未经用户确认前不写界面实现代码。

用户 2026-10-01 的决定（已写入计划 M8E 一节）：在同一界面任务上带"原型"标志派 worker；做原型的 worker 工具与普通 worker 相同；上限 1 MB；reviewer 与 QA 只拿到路径、版本和指纹，QA 多一个只能读这些原型文件的 read；在事项上按回车弹程序确认窗口，用户的选择由程序直接登记，只改原型这一种事项；worker 做原型的写法照搬用户对预览页的要求；预览 .bb-spec/.cache/ui-preview/m8e-prototype-confirm.html 已确认。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 worker 能提交 HTML 原型，程序存入本机数据目录并记版本与指纹，不写业务仓库；超出 1 MB 拒绝并写明原因；非 worker 不能提交 | 通过 | e0bdd14；tests/prototype.test.ts「M8E-AC1」（经真实运行管理器与脚本化模型：文件落在数据目录 prototypes/ 下、权限 0600、记录版本与 sha256、需求工作区 git status 为空；1 MB 加 1 字节被拒且原因写明字节数；reviewer、QA、不是当前原型运行的 worker 都交不进来；做原型不占尝试次数、不进入待审查；没交出原型时如实报给 PM） | 无 |
| AC2 原型提交后面板出现"待你确认原型"事项；按回车时在默认浏览器打开原型并弹出程序确认窗口，窗口给出文件路径；通过或返工由程序直接登记，返工意见按原话交回 PM；Esc 或没有界面时不登记；窗口与预览一致 | 通过 | e0bdd14；tests/pm-panel.test.ts「M8E-AC2」两条（按回车调用打开文件、窗口 80 列逐行与预览对照、选通过与输入返工意见都直接登记、空意见不提交、Esc 不登记、浏览器没打开时窗口写明、不插入决策包也不触发主代理）；tests/prototype.test.ts「M8E-AC2/AC3」（事项文字与版本、面板第二行"等待你确认原型"、返工意见原话送到 PM、文件被改动后拒绝打开） | 与预览有两处差异：文件路径不缩写仓库身份，按目录分隔处折成多行；登记时原型已出新版本的提示显示在对话区的警告行，不在窗口里。登记后的绿色提示行没有在真实终端里看过，只核对了调用 |
| AC3 界面任务没有已通过原型时派实现 worker 被拒并写明原因；通过后可以派出；原型出新版本后旧的通过失效；PM 与其他代理不能替用户通过 | 通过 | e0bdd14；tests/prototype.test.ts「M8E-AC2/AC3」（没有原型、待确认、被要求返工三种情况派实现都被拒并各写明原因；通过后派出；通过后再出第 3 版即重新被拒；拿旧版本事项登记被拒；决策包与主代理的裁决登记入口不认原型事项；PM 的计划工具写不进原型记录；非界面任务照常派出） | 无 |
| AC4 实现 worker、reviewer 与 QA 的输入里带有已通过原型的路径、版本和指纹；QA 多一个只能读这些原型文件的 read；角色说明写明核对要求；非界面任务流程不受影响，现有测试全部通过 | 通过（剩余 2 条单元失败是本机睡眠定时偏慢造成的等锁计时测试，按用户 2026-10-01 的决定不改代码） | e0bdd14；tests/prototype.test.ts「M8E-AC4」三条（完整走到 QA：reviewer 与 QA 的系统提示含原型路径、版本、指纹，QA 工具多出 read，读原型成功、读别的文件被拒；read 范围判断；四个角色说明与主窗口规范的关键要求）；typecheck 通过，单元 2441 条里 2439 通过，集成 56、安装 11 通过（1 个需 Docker 跳过） | 单元 2 条失败：tests/database-initialization.test.ts「真实读锁阻挡 WAL 切换」（7.77 秒，上限 7.5 秒）、tests/helpers/project-index-installed-fixture.test.ts「databaseRows：真实SQLite锁超过5000ms」（7.83 秒，上限 7 秒）。机器定时恢复正常后重跑确认 |
| AC5 真实模型的界面需求验收并入 M9-AC13 | 不在本阶段运行 | 无 | M9 重跑；届时验收宿主要对"确认原型"窗口自动选"通过"，并把打开浏览器换成不真的打开 |

## 当前阻塞

无。

本机睡眠定时偏慢：2026-10-01 用 python3 睡 10 毫秒 20 次，应为 200 毫秒，实测 618 毫秒。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，只做本地提交，不推送）。
M8E 已完成。先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md（M9 章节与 §13），再读 M9-STATUS.md，核对 git status 与最近提交，然后恢复 M9：重跑 AC12、AC13。AC12 含 M8D2-AC6 的规范分流场景（首条消息里的规范经三选弹窗写入 AGENTS.md）。AC13 含 M8E 的原型确认流程（PM 把 HUD 面板任务标为界面任务，worker 先做原型，确认后再实现，QA 对照原型验收）：验收宿主要对"确认原型"窗口自动选"通过"，并把面板扩展的打开浏览器换成不真的打开。
界面改动必须先做 HTML 预览（放 .bb-spec/.cache/ui-preview/，终端界面用 HTML 模拟 80 列终端），用户说"可以"后才写实现代码。
本机睡眠定时偏慢时，tests/database-initialization.test.ts 与 tests/helpers/project-index-installed-fixture.test.ts 各有 1 条等锁计时测试会失败，与代码无关；先用 python3 测一下睡 10 毫秒 20 次的实际用时再判断。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。类型检查不包含 tests/ 下的文件，改测试文件后要实际运行确认。
```
