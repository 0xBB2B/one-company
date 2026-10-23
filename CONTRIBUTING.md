# 参与开发

## 本地安装

在本仓库目录里装好锁定的依赖，再用绝对路径把它装进 pi：

```bash
pnpm install --frozen-lockfile
pi install /absolute/path/to/one-company
```

用 pnpm 11.7.0，运行和测试都用 Node。

## 测试

| 命令 | 测什么 |
|---|---|
| `pnpm run typecheck` | 类型检查，不含 `tests/`，改了测试要实际运行 |
| `pnpm test` | 单元测试，4 个进程并行，一轮 10 分钟以上 |
| `pnpm run test:integration` | 集成测试：真实守护进程、临时 SQLite、跨进程 |
| `pnpm run test:integration:installed` | 同上，但先打包安装，守护进程从安装产物启动 |
| `pnpm run test:installation` | 按真实 pi 安装方式装好再测；没有 Docker 时跳过 Docker 安装测试 |
| `pnpm run test:acceptance:parallel` | 真实模型验收：16 个单点，单点每条 1～6 分钟，同时跑全部单点约 20 分钟，加两条完整流程约 35 分钟 |

合并前，类型检查、单元、集成、安装这四项纯代码测试必须全过。改了产品代码或提示词，再跑全部单点（P1–P16）和零自定义完整流程（M9-AC12）；改动碰到 `role-rules/pm.md`、`rules/*.md`，或新版本送到 PM、PM 复核计划的流程（`src/modules/requirement/requirement-state.ts`、`src/modules/requirement/requirement-service.ts`、`src/modules/pm/plan-manage.ts` 里待复核版本的部分），还要加跑渐进需求完整流程（M9-AC2/AC3/AC11），拿不准就跑。

### 测试注意事项

- 测试临时目录是单层的 `/tmp/pi-t-XXXXXX`，跑完按登记删除。不要改成多层，否则守护进程通信文件的路径会超过 macOS 的 104 字节上限。
- 本机睡眠定时偏慢时，个别计时敏感的测试会偶发失败，单独重跑通过就不算代码问题。

## 真实模型验收

```bash
ONE_COMPANY_ACCEPTANCE_MODEL=<提供方>/<模型> \
ONE_COMPANY_ACCEPTANCE_OUTPUT=<绝对路径> \
pnpm run test:acceptance:parallel [--only <编号…>]
```

- `ONE_COMPANY_ACCEPTANCE_MODEL`：主会话用的模型，如 `5x/gpt-6.1-sol`。各角色和内部调用默认跟随主会话的模型和思考等级，在 /one:setting 的「模型」和角色定义里可改。
- `ONE_COMPANY_ACCEPTANCE_OUTPUT`：证据目录。每条每次一个子目录，有会话记录、`data.db`、`report.json`；总进度在 `summary.txt`。
- `--only`：只跑测试名冒号前编号匹配的几条，如 `--only P1 P2 M9-AC12`，所以测试名开头的编号不要删改。
- 运行时把 `~/.pi/agent/` 下的 `models.json` 和 `auth.json` 复制进一个只有当前用户能读写的临时 agent 目录，跑完删除，不动你自己的 `~/.pi/agent/`。
- 用 gpt-6.1-sol 时，`models.json` 里它的思考等级 `off` 要写成 `null`，这个模型不接受关闭思考。

**判定**：模型输出有波动，每条在同一提交上先同时跑 2 次（相隔 20 秒启动）。2 次都过算通过；一过一不过就立即跑第 3 次，过算通过、不过算失败；2 次都不过直接失败。脚本自动补跑和判定。某次 10 分钟没有任何更新会被自动停下。修好后在新提交上按同样规则重跑；只改验收脚本或文档不重跑。全部失败时，先查会话记录里有没有 `429 usage_limit_reached`，模型服务额度用完后大约半小时恢复。

**两类测试**，都在临时目录里跑。程序自己保证的步骤（有原型没定下来时不能批准、@ 指向哪个需求、关闭时生成归档等）已有纯代码测试，这里只测靠模型判断的地方和能不能走完流程。

单点测试（`tests/acceptance/points/`）：判断点之前的步骤由按脚本回答的假模型走完，到需要模型判断的那一步，把程序当时发出的请求原样交给真实模型，再由程序按工具调用和记录判对错。每个几十秒到几分钟。交给真实模型的 PM、worker、reviewer、QA 用 `ONE_COMPANY_ACCEPTANCE_MODEL`；P1、P6–P8、P11、P13、P14 起一个真实主会话，解释器等内部调用默认跟随这个主会话的模型和思考等级。遇到过载、限流时和宿主一样自动重试 3 次。

| 编号 | 判断点 | 判对的标准 |
|---|---|---|
| P1 | 用户说"批准这一版" | 解释器解读成确认，批准登记生效 |
| P2 | PM 规划时有对口的专业 worker | 实现任务选用它并写明理由 |
| P3 | PM 规划时只有不对口的专业 worker | 实现任务用默认 worker |
| P4 | PM 规划登录页面需求 | 页面任务选用界面专业 worker |
| P5 | PM 收到 worker 的结束通知 | 用 status 查看引用的验证记录，不读子代理会话记录 |
| P6 | 不带 @ 说两个需求都补一条 | 两个需求的草稿都更新，不新建需求 |
| P7 | 带 @ 说"转告 PM"、再带 @ 说"追加一条" | 前一句转给 PM、不改需求；后一句只改被 @ 的需求 |
| P8 | 需求里顺带定了一条长期规范 | 弹出写入 AGENTS.md 的窗口并写入 |
| P9 | 已有代码和测试都与需求不符（验证码有效期写成 10 分钟） | worker 把代码和测试一起改对，`npm test` 通过 |
| P10 | 主窗口出原型、随需求批准后 QA 验收界面任务 | 读取需求里的原型文件对照检查 |
| P11 | 已有需求时逐题回答 12 个问题 | 不用 read、bash 等工具绕道读本机数据目录 |
| P12 | 实施中用户批准了新版本 | PM 读差异，把计划更新并确认到新版本，新目标有任务覆盖 |
| P13 | 用户提一个带界面的需求、要求先出草稿 | 主代理存好草稿后派原型设计师出原型 |
| P14 | 主代理在提交说明没有需求编号时 | 读了提交新增的归档文件，回答里带上需求编号 |
| P15 | go-worker 的改动里埋了 5 个 Go 常见坑（请求无超时、写未初始化的 map、并发写 map、拼接 SQL、释放 Redis 锁不比对 token） | 自动挂上的 go-reviewer 打回，5 个坑各有一条阻塞意见，指到埋坑的文件和行号 |
| P16 | vue-worker 的改动里埋了 5 个 Vue 常见坑（v-html 渲染评论、:href 绑用户链接、监听不移除、路由守卫当权限校验、解构 reactive） | 自动挂上的 vue-reviewer 打回，5 个坑各有一条阻塞意见，指到埋坑的文件和行号 |

完整流程（2 条）：在临时目录真实安装本包、建样例项目，由真实模型扮演主代理和各角色，从提需求走到完成关闭。

- 零自定义（M9-AC12）：全新数据根目录、只用包内默认定义，从草稿走到用户验收和关闭；首条消息里的长期约定会写进样例项目的 AGENTS.md。
- 渐进需求（M9-AC2/AC3/AC11）：先做完"快跑"并合并，再做"跳跃"并在实施中追加"动画"，之后在同一会话和新会话里问 13 个问题。它是唯一的长会话测试，上下文越积越大才出现的问题只有它能发现。

## 性能基准与测量工具

这三个工具不在测试命令里，需要时手动跑。记录结果时写明机器（CPU、内存、系统）、Node 版本和冷热状态，所有样本和失败都要记，不能只挑最好的一次。

- **索引内核基准**：`node --experimental-strip-types tests/helpers/m3-benchmark.ts --output <全新的绝对路径目录> [--scenario all|cold|restart|events] [--smoke]`。只认 Node v22.19.0 或 v26.8.2。用约 1000 个文件、文本不超过 20 MiB 的样例项目，测冷启动建索引、重启后复用、需求事件投递。参考目标：冷初始化 60 秒内；重启时未变文件不重新解析；已确认需求的事件 95% 在 2 秒内可投递。`--smoke` 只用几个文件检查脚本能跑。
- **知识查询基准**：`node --experimental-strip-types tests/helpers/m4-query-benchmark.ts --output <全新的绝对路径目录> --scenario smoke|formal`。参考目标：热态精确查询 95% 在 500 毫秒内；中文搜索和有限事实查询 95% 在 2 秒内。失败样本也算进分母。
- **验收测量**：`node tests/acceptance/measure.ts <验收输出目录>`，从验收证据里取数生成 `<目录>/measure.md`：PM 接手用时与 token、检索的输入输出大小与父代理回读、PM 查角色目录与选中定义、各角色 token 与总用时。token 用模型返回的实际用量，字数不当 token；每次运行一行，给中位数和最大值，失败、截断、测不了的单独列，不算"节省了百分之多少"。

## 语法解析资源

`src/modules/project-index/syntax-parser.ts` 使用随包分发的 TS/TSX、JS/JSX、Go 语法 WASM 和固定版本的 `web-tree-sitter`，装好后可离线解析，不需要 CodeGraph 或现场编译；资源缺失、损坏或版本不兼容时明确失败。它只解析调用方给的源码字符串；项目扫描、结构提取、持久化和宿主授权分别在 `src/modules/project-index/project-index-policy.ts`、`src/modules/project-index/code-extractor.ts`、`src/modules/project-index/index-store.ts`、`src/modules/project-index/project-index-service.ts`、`src/modules/project-index/project-manage-tool.ts`。资源来源和许可证见 [解析资源说明](resources/tree-sitter/README.md)。
