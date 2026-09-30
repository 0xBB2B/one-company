# M8D 状态

阶段目标：打开 pi 后只靠 PM 面板和 `@需求` 就能处理需求。`@需求` 只说明这句话针对哪些需求，不带 @ 时由主代理判断；窗口不再绑定需求；决定的对象只由程序从用户操作得出，得不出时弹程序确认窗口；新增通用问答窗口，现有程序弹框全部改用中文、警告色的程序确认窗口；agent_manage 新增给 PM 发消息的动作；删除两个需求命令。

## AC 状态表

| AC | 状态 | 证据 | 剩余缺口 |
|---|---|---|---|
| AC1 `@` 补全与多需求识别 | 未开始 | 无 | 界面部分等 HTML 预览确认 |
| AC2 不带 @ 时无绑定也能读取、改草稿、核对接手，可涉及多个需求 | 未开始 | 无 | 无 |
| AC3 决定对象由程序得出，得不出时逐个弹框确认 | 未开始 | 无 | 弹框部分等 HTML 预览确认 |
| AC4 agent_manage message 只给主代理，PM 收到标为主代理转述 | 未开始 | 无 | 无 |
| AC5 两个命令与窗口绑定机制删除干净，README 写明 @需求 用法 | 未开始 | 无 | 无 |
| AC6 真实模型跑一轮 | 未开始 | 无 | 依赖 AC1—AC5、AC7 |
| AC7 通用问答窗口与程序确认窗口，现有弹框全部改用 | 未开始 | 无 | 等 HTML 预览确认 |

## 当前阻塞

界面部分（@ 补全、通用问答窗口、程序确认窗口）要等用户确认 HTML 预览后才写实现代码。

## 下一窗口续接提示

```
项目：/Users/bb/.bb-spec/worktrees/pi-spec-bb-spec-rebuild（分支 bb-spec-rebuild，不推送）。
先完整读 AGENTS.md 与 SQLITE-KNOWLEDGE-REBUILD-PLAN.md 的 M8D 一节，再读本文件，核对 git status 与最近提交。M9 已暂停，M8D、M8E 完成后恢复。
界面改动必须先做 HTML 预览（放 .bb-spec/.cache/ui-preview/，终端界面用 HTML 模拟 80 列终端），用户说"可以"后才写实现代码。
验证入口：pnpm run typecheck；pnpm test；pnpm run test:integration；pnpm run test:installation。
```
