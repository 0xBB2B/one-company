# M8D 状态

阶段目标：打开 pi 后只靠 PM 面板和 `@需求` 就能处理需求。`@需求` 只说明这句话针对哪些需求，不带 @ 时由主代理判断；窗口不再绑定需求；决定的对象只由程序从用户操作得出，得不出时弹程序确认窗口；新增通用问答窗口，现有程序弹框全部改用中文、警告色的程序确认窗口；agent_manage 新增给 PM 发消息的动作；删除两个需求命令。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 `@` 补全与多需求识别 | 通过 | c4273b8 与本提交；tests/mention-completion.test.ts（需求排在文件前、按标题或编号尾过滤、编号尾至少 4 位且重复时加长、选中后插入 @[标题#编号尾]、文件补全仍走原逻辑）、tests/integration/mention-completion.test.ts（交互终端只登记一次、列出窗口需求与 PM 运行状态、关窗后只剩原补全）、tests/main-requirement-interaction.test.ts「M8D-AC1」（补全数据随草稿标题更新；tests/main-requirement-interaction.test.ts「M8D-AC1」按编号尾巴认出需求、同一需求只算一次、无效 @ 写明原因、下一句清空）、tests/rules-extension.test.ts「M8D-AC1」（@ 到的需求由程序写进本轮系统提示） | 与预览的差异：无效 @ 的提示经 pi 的警告通知显示，前面带 pi 固定的英文前缀 "Warning:" |
| AC2 不带 @ 时无绑定也能读取、改草稿、核对接手，可涉及多个需求 | 通过 | 本提交；tests/main-requirement-interaction.test.ts「M8D-AC2」（同一窗口两个需求都能读、都能改草稿）、tests/requirement-manage-tool.test.ts「M8D-AC2」（宿主已无绑定入口，只核对仓库）、main-intake-interaction*.test.ts 与 pm-intake-service-cancellation.test.ts 去掉绑定后通过；关闭与状态未知仍按原测试拒读 | 无 |
| AC3 决定对象由程序得出，得不出时逐个弹框确认 | 部分 | 本提交；tests/main-requirement-interaction.test.ts「M8D-AC3」（@ 到直接登记不弹窗；没 @ 到弹"批准需求"窗口，显示需求名、版本与简介，取消即不登记不生效）、tests/adjudication.test.ts「M8D-AC3」（裁决只认最后打开的面板事项） | 裁决时没打开过事项目前是拒绝并提示先打开，没有弹窗（预览里没有这种窗口，待用户决定）；预览里多个需求的"（1/2）"编号没做（每次批准是独立的工具调用，程序不知道总数） |
| AC4 agent_manage message 只给主代理，PM 收到标为主代理转述 | 通过 | 本提交；tests/pm-dispatch.test.ts「M8D-AC4」（PM 收到带【主代理转述】标签的消息、暂停时排队到恢复后送达、无 PM 与超长拒绝并写明原因）、tests/core-permissions.test.ts（只有 main 有 message，PM 与其他角色没有；主会话 agent_manage 的动作都在核心表内）、tests/daemon-protocol.test.ts（pm.message 登记与参数校验） | 无 |
| AC5 两个命令与窗口绑定机制删除干净，README 写明 @需求 用法 | 通过 | c4273b8 与本提交；两个命令、绑定与一次性选择凭据、相关错误说明全部删除，tests/integration/host-requirement-continuation.test.ts 删除，全仓 grep 无残留；README 命令表删去两行，新增「@需求」一节写明补全、带 @ 与不带 @ 的处理、回答面板事项与恢复对话 | 无 |
| AC6 真实模型跑一轮 | 未开始 | 无 | 依赖 AC1—AC5、AC7 |
| AC7 通用问答窗口与程序确认窗口，现有弹框全部改用 | 通过 | 本提交；tests/question-window.test.ts（多题、多选、其他输入、Esc 取消、无界面与中止按拒绝、警告色标题、需求名正常色、其余灰色、改动行红绿、全中文）；tests/workspace-manage.test.ts（创建与回收窗口显示需求标题，标题随工作区记录保存）；tests/project-manage-tool.test.ts、tests/project-maintenance.test.ts、tests/git-delivery*.test.ts 与安装测试 project-index-sync、project-manage 经真实渲染的窗口确认；typecheck、单元 2375（2 个并行负载下的偶发超时单独重跑通过）、集成、安装 11 通过（1 个需 Docker 跳过） | 与预览的差异：PR 合并方式窗口的提示行没有"（取消等于自己 review）"半句 |

## 当前阻塞

无。HTML 预览已于 2026-09-30 确认（.bb-spec/.cache/ui-preview/m8d.html），实现完成后逐项对照。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md 的 M8D 一节，再读本文件，核对 git status 与最近提交。M9 已暂停，M8D、M8E 完成后恢复。
界面改动必须先做 HTML 预览（放 .bb-spec/.cache/ui-preview/，终端界面用 HTML 模拟 80 列终端），用户说"可以"后才写实现代码。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
