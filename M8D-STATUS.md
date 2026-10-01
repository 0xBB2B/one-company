# M8D 状态

阶段目标：打开 pi 后只靠 PM 面板和 `@需求` 就能处理需求。`@需求` 只说明这句话针对哪些需求，不带 @ 时由主代理判断；窗口不再绑定需求；决定的对象只由程序从用户操作得出，得不出时弹程序确认窗口；新增通用问答窗口，现有程序弹框全部改用中文、警告色的程序确认窗口；agent_manage 新增给 PM 发消息的动作；删除两个需求命令。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 `@` 补全与多需求识别 | 通过 | c4273b8 与本提交；tests/mention-completion.test.ts（需求排在文件前、按标题或编号尾过滤、编号尾至少 4 位且重复时加长、选中后插入 @[标题#编号尾]、文件补全仍走原逻辑）、tests/integration/mention-completion.test.ts（交互终端只登记一次、列出窗口需求与 PM 运行状态、关窗后只剩原补全）、tests/main-requirement-interaction.test.ts「M8D-AC1」（补全数据随草稿标题更新；tests/main-requirement-interaction.test.ts「M8D-AC1」按编号尾巴认出需求、同一需求只算一次、无效 @ 写明原因、下一句清空）、tests/rules-extension.test.ts「M8D-AC1」（@ 到的需求由程序写进本轮系统提示） | 用户 2026-09-30 同意保留的与预览差异：无效 @ 的提示经 pi 的警告通知显示，前面带 pi 固定的英文前缀 "Warning:" |
| AC2 不带 @ 时无绑定也能读取、改草稿、核对接手，可涉及多个需求 | 通过 | 本提交；tests/main-requirement-interaction.test.ts「M8D-AC2」（同一窗口两个需求都能读、都能改草稿）、tests/requirement-manage-tool.test.ts「M8D-AC2」（宿主已无绑定入口，只核对仓库）、main-intake-interaction*.test.ts 与 pm-intake-service-cancellation.test.ts 去掉绑定后通过；关闭与状态未知仍按原测试拒读 | 无 |
| AC3 决定对象由程序得出，得不出时逐个弹框确认 | 通过 | c4273b8 与本提交；tests/main-requirement-interaction.test.ts「M8D-AC3」（@ 到直接登记不弹窗；没 @ 到弹"批准需求"窗口，显示需求名、版本与简介，取消即不登记不生效）、tests/adjudication.test.ts「M8D-AC3」两条（面板打开的事项直接登记不弹窗；没打开或打开的不是这个事项时弹"登记裁决"窗口，显示需求名与事项名，取消即不登记）；裁决窗口按 2026-09-30 用户确认的预览 .bb-spec/.cache/ui-preview/m8d-adjudicate.html 实现；003500c 补上一句话 @ 两个需求并批准的测试（tests/main-requirement-interaction.test.ts「M8D-AC3：一句话 @ 两个需求并批准」），此前同一句话登记第二个需求必然报"用户原话已过期"，原先只测了单个需求；ed113fd、9fdcf5c：解释器上下文带程序认定的对象事实、整份待定的解读不留记录（tests/main-requirement-interaction.test.ts「M8D-AC3」另两条）；5b57172：字节没变且以前确认或排除过的段落由程序沿用原依据（tests/interaction-derivation.test.ts「M8D-AC3」四条、tests/main-requirement-interaction.test.ts「M8D-AC3：已批准的需求只改一段后再批准」） | 用户 2026-09-30 同意保留的与预览差异：多个需求逐个弹窗时标题不带"（1/2）"编号 |
| AC4 agent_manage message 只给主代理，PM 收到标为主代理转述 | 通过 | 本提交；tests/pm-dispatch.test.ts「M8D-AC4」（PM 收到带【主代理转述】标签的消息、暂停时排队到恢复后送达、无 PM 与超长拒绝并写明原因）、tests/core-permissions.test.ts（只有 main 有 message，PM 与其他角色没有；主会话 agent_manage 的动作都在核心表内）、tests/daemon-protocol.test.ts（pm.message 登记与参数校验） | 无 |
| AC5 两个命令与窗口绑定机制删除干净，README 写明 @需求 用法 | 通过 | c4273b8 与本提交；两个命令、绑定与一次性选择凭据、相关错误说明全部删除，tests/integration/host-requirement-continuation.test.ts 删除，全仓 grep 无残留；README 命令表删去两行，新增「@需求」一节写明补全、带 @ 与不带 @ 的处理、回答面板事项与恢复对话 | 无 |
| AC6 真实模型跑一轮 | 通过 | 场景 tests/acceptance/at-mention-loop.test.ts；第 15 次（主会话 5x/gpt-6-sol，解释器 5x/gpt-6-luna 加 medium 思考，证据 .bb-spec/.cache/m8d/acceptance/at-mention-2026-10-01T10-13-23-281Z，约 30 分钟）11 项检查全部通过：不带 @ 新建草稿并弹窗批准；@ 需求追加功能并批准不弹窗；@ 需求转告 PM；一句话 @ 两个需求都改草稿、都批准不弹窗（版本到 3 与 2）；不带 @ 判断出两个需求并都修改、逐个弹窗批准后都生效（版本到 4 与 3）；不带 @ 新建草稿；9 次提问全部经提问窗口；恢复后 PM 收到主代理转述 | 这一轮解释器输出有过"引用的原依据不存在"，重答后通过，未挡住流程。此前 14 次的失败原因与修复：解释器超时（AC8 可换模型）、无原因失败与数据库忙（9c2b189、310656b）、批准时意外错误说成草稿要改（4320108）、过期批准清单卡死草稿保存（e9b6270）、目录链接数误报（5643c70）、一句话批准多个需求原话过期（003500c）、解释器缺对象事实与失败解读留记录（ed113fd、9fdcf5c）、没改动的已批准段落每次要模型重新确认（5b57172）；验收脚本改由程序选推荐项、只说固定台词（7af322d、65ea09d） |
| AC8 解释器与草稿核验器的模型可按内部定义设置，角色定义页改版 | 通过 | 31109a2（按内部定义选模型与思考，默认沿用主会话模型、不思考；tests/internal-model.test.ts：用户层改的只影响对应那个、项目层只在受信任时生效、模型找不到或无凭据写明原因且不改用主会话模型）、c9033df（窗口不可选项、定义写错时带出错字段与原写法）与本提交：/one:agents 按 2026-09-30 确认的预览 .bb-spec/.cache/ui-preview/m8d-agents-v2.html 改成表格版；tests/agent-catalog-ui.test.ts（分类与数量、排序、内部分类中文名与"不思考"、就地展开、问题分类与未受信任、页内输入新名称与重名当场提示、pm 与内部定义锁定同名、复制后回原分类选中并标绿、窄终端省略顺序、44/56/80 列下每个画面都不超宽）、tests/agents-page.test.ts（整页走通：选层窗口写出完整路径、取消提示、已有同名文件的层变暗、两层都有时不弹窗、项目未受信任时项目层变暗）；typecheck、单元 2407、集成 56、安装 11 通过（1 个需 Docker 跳过） | 窄终端下展开的详情按宽度折行（中文任意处断开，英文单词与路径不从中间切开，路径优先在"/"后断开），已补进预览，用户 2026-09-30 确认。用户 2026-09-30 同意保留的与预览差异：①只能同名复制、用户层已有且项目未受信任时两层都选不了，底部提示"用户层已经有 X，直接编辑这个文件即可；项目未受信任，不能复制到项目层"（预览没画这个画面）；②复制时文件恰好被别处抢先建出，原因显示在页面底部灰色行，不再用 pi 的通知 |
| AC9 主代理提问改用通用问答窗口，先反思、给 2 到 4 个选项并恰好推荐一个 | 通过 | 7ca4007（登记格式逐条核对，tests/user-interact-tool.test.ts「M8D-AC9」）、5fb4dd6（窗口样式，tests/question-window.test.ts「M8D-AC9」两条）、1e67e3b（登记后弹窗、回答记为原话、窗口回答不能批准或裁决，tests/main-requirement-interaction.test.ts「M8D-AC9」三条）、2844145（对话记录块）、9fa00e3（规则与 README，tests/rules-extension.test.ts、tests/user-documentation.test.ts）、ede38f1（验收宿主由扮演用户的模型在窗口里作答）、d5d44b1（批准被挡时写明段落；窗口回答后直接改草稿）；真实模型第 15 次验收（证据 .bb-spec/.cache/m8d/acceptance/at-mention-2026-10-01T10-13-23-281Z）里"主代理的提问都经提问窗口"通过：登记成功 9 次，弹窗 9 次 | 用户 2026-10-01 同意保留的与预览差异：①80 列下根源自检按"能放就放"折行，断点与预览里手工选的位置不同；②登记被拒时的红字直接用程序给出的原因，文字与预览示例不同。以前是委托类的段落不在程序沿用范围内 |
| AC7 通用问答窗口与程序确认窗口，现有弹框全部改用 | 通过 | 本提交；tests/question-window.test.ts（多题、多选、其他输入、Esc 取消、无界面与中止按拒绝、警告色标题、需求名正常色、其余灰色、改动行红绿、全中文）；tests/workspace-manage.test.ts（创建与回收窗口显示需求标题，标题随工作区记录保存）；tests/project-manage-tool.test.ts、tests/project-maintenance.test.ts、tests/git-delivery*.test.ts 与安装测试 project-index-sync、project-manage 经真实渲染的窗口确认；typecheck、单元 2375（2 个并行负载下的偶发超时单独重跑通过）、集成、安装 11 通过（1 个需 Docker 跳过）；PR 合并方式窗口提示行的"（取消等于自己 review）"已按预览补上（tests/question-window.test.ts、tests/git-delivery.test.ts） | 无 |

## 当前阻塞

无。M8D 已完成：AC1 至 AC9 都有通过的测试或证据，相关代码已本地提交。

全量测试说明：typecheck 通过；集成 56、安装 11（1 个需 Docker 跳过）通过；单元 2433 个在机器负载高时有个别计时类测试超时（数据库锁等待 7.5 秒上限、M7 投递 2 秒上限、PM 接手租约），单独重跑都通过，所测代码 M8D 未改动。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
M8D 已完成。先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md 的 M8D2 一节，核对 git status 与最近提交，再开始 M8D2；之后是 M8E，最后恢复 M9（重跑 AC12、AC13）。
界面改动必须先做 HTML 预览（放 .bb-spec/.cache/ui-preview/，终端界面用 HTML 模拟 80 列终端），用户说"可以"后才写实现代码。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。类型检查不包含 tests/ 下的文件，改测试文件后要实际运行确认。
真实模型验收：ONE_COMPANY_ACCEPTANCE_MODEL=5x/gpt-6-sol ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> pnpm run test:acceptance -t <名称>；解释器在验收里用 5x/gpt-6-luna 加 medium 思考，一轮约 30 到 60 分钟。
```
