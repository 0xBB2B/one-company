# M8D 状态

阶段目标：打开 pi 后只靠 PM 面板和 `@需求` 就能处理需求。`@需求` 只说明这句话针对哪些需求，不带 @ 时由主代理判断；窗口不再绑定需求；决定的对象只由程序从用户操作得出，得不出时弹程序确认窗口；新增通用问答窗口，现有程序弹框全部改用中文、警告色的程序确认窗口；agent_manage 新增给 PM 发消息的动作；删除两个需求命令。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 `@` 补全与多需求识别 | 通过 | c4273b8 与本提交；tests/mention-completion.test.ts（需求排在文件前、按标题或编号尾过滤、编号尾至少 4 位且重复时加长、选中后插入 @[标题#编号尾]、文件补全仍走原逻辑）、tests/integration/mention-completion.test.ts（交互终端只登记一次、列出窗口需求与 PM 运行状态、关窗后只剩原补全）、tests/main-requirement-interaction.test.ts「M8D-AC1」（补全数据随草稿标题更新；tests/main-requirement-interaction.test.ts「M8D-AC1」按编号尾巴认出需求、同一需求只算一次、无效 @ 写明原因、下一句清空）、tests/rules-extension.test.ts「M8D-AC1」（@ 到的需求由程序写进本轮系统提示） | 用户 2026-09-30 同意保留的与预览差异：无效 @ 的提示经 pi 的警告通知显示，前面带 pi 固定的英文前缀 "Warning:" |
| AC2 不带 @ 时无绑定也能读取、改草稿、核对接手，可涉及多个需求 | 通过 | 本提交；tests/main-requirement-interaction.test.ts「M8D-AC2」（同一窗口两个需求都能读、都能改草稿）、tests/requirement-manage-tool.test.ts「M8D-AC2」（宿主已无绑定入口，只核对仓库）、main-intake-interaction*.test.ts 与 pm-intake-service-cancellation.test.ts 去掉绑定后通过；关闭与状态未知仍按原测试拒读 | 无 |
| AC3 决定对象由程序得出，得不出时逐个弹框确认 | 通过 | c4273b8 与本提交；tests/main-requirement-interaction.test.ts「M8D-AC3」（@ 到直接登记不弹窗；没 @ 到弹"批准需求"窗口，显示需求名、版本与简介，取消即不登记不生效）、tests/adjudication.test.ts「M8D-AC3」两条（面板打开的事项直接登记不弹窗；没打开或打开的不是这个事项时弹"登记裁决"窗口，显示需求名与事项名，取消即不登记）；裁决窗口按 2026-09-30 用户确认的预览 .bb-spec/.cache/ui-preview/m8d-adjudicate.html 实现 | 用户 2026-09-30 同意保留的与预览差异：多个需求逐个弹窗时标题不带"（1/2）"编号 |
| AC4 agent_manage message 只给主代理，PM 收到标为主代理转述 | 通过 | 本提交；tests/pm-dispatch.test.ts「M8D-AC4」（PM 收到带【主代理转述】标签的消息、暂停时排队到恢复后送达、无 PM 与超长拒绝并写明原因）、tests/core-permissions.test.ts（只有 main 有 message，PM 与其他角色没有；主会话 agent_manage 的动作都在核心表内）、tests/daemon-protocol.test.ts（pm.message 登记与参数校验） | 无 |
| AC5 两个命令与窗口绑定机制删除干净，README 写明 @需求 用法 | 通过 | c4273b8 与本提交；两个命令、绑定与一次性选择凭据、相关错误说明全部删除，tests/integration/host-requirement-continuation.test.ts 删除，全仓 grep 无残留；README 命令表删去两行，新增「@需求」一节写明补全、带 @ 与不带 @ 的处理、回答面板事项与恢复对话 | 无 |
| AC6 真实模型跑一轮 | 部分 | 场景 tests/acceptance/at-mention-loop.test.ts（a2bfc3a、34f2125、b03b336）；5x/gpt-6-sol 跑了 3 次，第 1、3 次第一段（不带 @ 新建草稿、批准弹窗、派出并暂停 PM）通过（证据 .bb-spec/.cache/m8d/acceptance/at-mention-*）；第 4 次（解释器改用 luna，证据 .bb-spec/.cache/m8d/acceptance/at-mention-2026-09-30T11-29-41-241Z）全程跑完，10 项检查 7 项通过，解释器每次约 10 秒、无超时；第 5、6 次（证据 at-mention-2026-09-30T12-17-38-957Z、T12-34-55-034Z）都停在第二段 | 连续三轮都因验收脚本的模拟用户没跟上主代理的提问而失败，产品行为本身正确（有待定问题时拒绝批准）：第 4 次模拟用户不回答 A/B 就批准；第 5 次解释器认为"这一版"指代不明；第 6 次主代理登记问题时漏标推荐项、随后改口"我建议"，脚本认不出是提问。已按用户要求停下，等用户决定验收脚本怎么改。另：需求操作无原因失败已记进本机日志（9c2b189），第 5、6 次未出现 |
| AC8 解释器与草稿核验器的模型可按内部定义设置，角色定义页改版 | 通过 | 31109a2（按内部定义选模型与思考，默认沿用主会话模型、不思考；tests/internal-model.test.ts：用户层改的只影响对应那个、项目层只在受信任时生效、模型找不到或无凭据写明原因且不改用主会话模型）、c9033df（窗口不可选项、定义写错时带出错字段与原写法）与本提交：/one:agents 按 2026-09-30 确认的预览 .bb-spec/.cache/ui-preview/m8d-agents-v2.html 改成表格版；tests/agent-catalog-ui.test.ts（分类与数量、排序、内部分类中文名与"不思考"、就地展开、问题分类与未受信任、页内输入新名称与重名当场提示、pm 与内部定义锁定同名、复制后回原分类选中并标绿、窄终端省略顺序、44/56/80 列下每个画面都不超宽）、tests/agents-page.test.ts（整页走通：选层窗口写出完整路径、取消提示、已有同名文件的层变暗、两层都有时不弹窗、项目未受信任时项目层变暗）；typecheck、单元 2407、集成 56、安装 11 通过（1 个需 Docker 跳过） | 窄终端下展开的详情按宽度折行（中文任意处断开，英文单词与路径不从中间切开，路径优先在"/"后断开），已补进预览，用户 2026-09-30 确认。用户 2026-09-30 同意保留的与预览差异：①只能同名复制、用户层已有且项目未受信任时两层都选不了，底部提示"用户层已经有 X，直接编辑这个文件即可；项目未受信任，不能复制到项目层"（预览没画这个画面）；②复制时文件恰好被别处抢先建出，原因显示在页面底部灰色行，不再用 pi 的通知 |
| AC7 通用问答窗口与程序确认窗口，现有弹框全部改用 | 通过 | 本提交；tests/question-window.test.ts（多题、多选、其他输入、Esc 取消、无界面与中止按拒绝、警告色标题、需求名正常色、其余灰色、改动行红绿、全中文）；tests/workspace-manage.test.ts（创建与回收窗口显示需求标题，标题随工作区记录保存）；tests/project-manage-tool.test.ts、tests/project-maintenance.test.ts、tests/git-delivery*.test.ts 与安装测试 project-index-sync、project-manage 经真实渲染的窗口确认；typecheck、单元 2375（2 个并行负载下的偶发超时单独重跑通过）、集成、安装 11 通过（1 个需 Docker 跳过）；PR 合并方式窗口提示行的"（取消等于自己 review）"已按预览补上（tests/question-window.test.ts、tests/git-delivery.test.ts） | 无 |

## 当前阻塞

AC6 真实模型验收待重跑：此前 sol 解释一次用户原话约 50 秒，撞上解释器 60 秒上限；AC8 已让解释器可以单独改用 luna，验收用的是临时的 pi 配置目录，你本机用户层的解释器定义不会被读到；重跑前需在验收场景里自带一份把 model 设为 luna 的解释器定义，待用户同意。

此前：HTML 预览已于 2026-09-30 确认（.bb-spec/.cache/ui-preview/m8d.html），实现完成后逐项对照。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md 的 M8D 一节，再读本文件，核对 git status 与最近提交。M9 已暂停，M8D、M8E 完成后恢复。
界面改动必须先做 HTML 预览（放 .bb-spec/.cache/ui-preview/，终端界面用 HTML 模拟 80 列终端），用户说"可以"后才写实现代码。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
