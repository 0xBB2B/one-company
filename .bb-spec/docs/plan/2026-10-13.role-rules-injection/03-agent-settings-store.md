---
name: agent-settings-store
description: 读写 pi 设置文件 one-company 字段里 PM、解释器、草稿核验器的模型与思考等级，分用户层与项目层，写错列为问题
---
# 设定的读取与写入

## 目标
提供一个模块：按"项目层（受信任时）> 用户层 > 内置默认值"算出三个角色当前的模型和思考等级、各自来自哪一层，列出写错的地方；能在指定层加锁写入或删掉某个角色的设定，文件里其他内容原样保留。

## 业务规则（来源：PRD settings-tab、settings-recovery）
- 设定存在 pi 设置文件的 one-company 字段下：用户层是 `<agentDir>/settings.json`，项目层是 `<仓库根>/.pi/settings.json`；项目未受信任时不读项目层。
- 内置默认值：PM 用 gpt-6.1-sol、high；解释器用 gpt-6-luna、medium；草稿核验器用 gpt-6.1-sol、medium。
- "跟随主会话"在文件里写成 `"model": null`。
- 写错的一项不生效，取下一层：模型写法不对（不是"模型名"或"提供方/模型名"，也不是 null）、思考等级不认识、条目不是对象、one-company 不是对象、整个文件不是合法 JSON。每处写错都记一条问题：哪个文件、哪个角色（有的话）、原因。one-company 里出现不认识的角色名也记一条问题。
- 写入时只改 one-company 下这一个角色，文件里其他字段、其他角色原样保留；one-company 删空后去掉这个字段。文件不是合法 JSON 时拒绝写入并说明原因，不覆盖用户的文件。
- 和 pi 用同一种文件锁（proper-lockfile，锁住设置文件本身），避免和 pi 或别的 pi 窗口同时写而丢改动；文件不存在时先建目录再写。写出的格式和 pi 一致：两个空格缩进的 JSON。

## 涉及文件
- 新建 `runtime/agent-settings.ts`
- 新建 `runtime/proper-lockfile.d.ts`（类型声明，不另装类型包）
- 修改 `package.json`（dependencies 加 proper-lockfile）、`pnpm-lock.yaml`
- 新建测试 `tests/agent-settings.test.ts`

## 新增第三方依赖
| 库名 | 用途 | 版本策略 |
|---|---|---|
| `proper-lockfile` | 写 pi 设置文件时加和 pi 相同的文件锁 | 与 pi 当前依赖的版本一致（pi 1.2.0 用的是 4.1.2），精确版本号 |

安装提醒：worktree 的 node_modules 是指向主仓库的软链接，装依赖前先删掉软链接，在 worktree 里单独 `pnpm install`，避免改到主仓库的 node_modules。pi 1.2.0 发布不满一天时，pnpm 默认的最短发布时间会挡住安装，需要临时放行这一次。

## 成品定义

### 设置文件里的写法
```json
{
  "theme": "dark",
  "one-company": {
    "pm": { "model": "gpt-6-luna", "thinking": "xhigh" },
    "interpreter": { "model": null, "thinking": "off" },
    "draft-verifier": { "model": "5x/gpt-6.1-sol", "thinking": "medium" }
  }
}
```
每个条目必须同时有 model（字符串或 null）和 thinking（off、minimal、low、medium、high、xhigh、max 之一）。

### 三个角色的固定表（成品常量）
```ts
export const SETTINGS_ROLES = [
  { key: "pm", label: "PM", purpose: "活动需求的负责人，拆任务、派工、调度", effect: "下次启动 PM 时生效", failure: "启动 PM 会失败", model: "gpt-6.1-sol", thinking: "high" },
  { key: "interpreter", label: "解释器", purpose: "把用户原话解读成结构化决定", effect: "下次调用时生效", failure: "批准需求时解读会失败", model: "gpt-6-luna", thinking: "medium" },
  { key: "draft-verifier", label: "草稿核验器", purpose: "核对需求草稿是不是用户原话要求的", effect: "下次调用时生效", failure: "起草或修改需求草稿时核验会失败", model: "gpt-6.1-sol", thinking: "medium" },
] as const;
```

### proper-lockfile 类型声明
```ts
declare module "proper-lockfile" {
  export function lockSync(file: string, options?: { realpath?: boolean }): () => void;
}
```

### 问题原因的写法
```text
文件不是合法的 JSON，这一层的设定都没有生效
one-company 要写成对象，这一层的设定都没有生效
不认识的角色 <名字>，只能是 pm、interpreter、draft-verifier
<角色名> 的设定要写成对象，同时包含 model 和 thinking
<角色名> 的模型写法不对：<原值>；要写成模型名、提供方/模型名，或 null（跟随主会话）
<角色名> 的思考等级写错了：<原值>；只能是 off、minimal、low、medium、high、xhigh、max
```

## 函数清单
### runtime/agent-settings.ts
| 函数名 | 职责 |
|---|---|
| `SETTINGS_ROLES` | 三个角色的固定表（见成品）：名称、用途、生效时机、模型用不了时的后果、内置默认值 |
| `userSettingsPath` | 由 agentDir 得出用户层设置文件路径 |
| `projectSettingsPath` | 由仓库根得出项目层设置文件路径 |
| `readAgentSettings` | 读两层文件，返回每个角色的生效值（模型或 null、思考等级、来源层）、每层各自的有效条目和问题列表 |
| `parseSettingsLayer` | 解析一层文件：文件不存在算空层；逐项校验，写错的一项丢弃并记问题 |
| `saveAgentSetting` | 加锁读出文件，在 one-company 下写入一个角色的 model 与 thinking，写回 |
| `clearAgentSetting` | 加锁读出文件，删掉 one-company 下一个角色，删空后去掉 one-company，写回 |
| `withSettingsLock` | 内部：按 pi 的做法加锁、读、改、写、解锁；文件不是合法 JSON 时报错不写 |

## 协作关系
- 校验模型写法复用 `runtime/roles.ts` 里定义 model 字段用的同一条规则；思考等级复用 `THINKING_LEVELS`。
- 被 04（设定栏界面）和 05（守护进程与内部代理取值）调用；本计划不改任何调用方。

## 验证方式
- 测试入口：`readAgentSettings`、`saveAgentSetting`、`clearAgentSetting`（包级导出），测试目录用单层 `/tmp/pi-t-XXXXXX`。
- 测试输入：两层都没有文件；用户层设 PM 为 A、项目层设为 B，项目受信任与不受信任；项目层 PM 思考等级写成 "super"；用户层文件内容是 `{ 坏`；one-company 里有不认识的角色；文件里另有 `"theme": "dark"` 和 `"packages": [...]`。
- 预期结果：
  - [ ] 没有文件时，三个角色都是成品表里的默认值，来源为内置
  - [ ] 项目受信任时 PM 取 B、来源项目；不受信任时取 A、来源用户
  - [ ] "super" 那项被丢弃，PM 取下一层；问题列表有一条写明项目设置文件、PM、思考等级写错
  - [ ] 坏 JSON 那一层整层不生效，问题写明"文件不是合法的 JSON"；对它调用保存时报错，文件内容不变
  - [ ] 保存 PM 后，文件里 theme、packages 和其他角色原样保留，PM 条目是写入的值；`model: null` 读回来是跟随主会话
  - [ ] 清除唯一的 PM 条目后，文件里不再有 one-company 字段，其余字段不变
  - [ ] 保存到不存在的文件时自动建目录和文件
  - [ ] 测试先用 proper-lockfile 锁住设置文件（模拟 pi 正在写）再保存：按 pi 的做法重试 10 次、每次隔 20 毫秒仍拿不到锁时报错"设置文件正在被别的进程写入，稍后再试"，文件内容不变；解锁后再保存成功，且锁目录（`<文件>.lock`）已被清掉
