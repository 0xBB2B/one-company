---
name: prototype-role
description: 新增 prototype 职责：内置定义、职责规矩、宿主工具与核心工具权限、/one:agents 新栏；PM 派不了
---
# 原型设计师职责与定义栏

## 目标
系统认识一个新职责 `prototype`（原型设计师）：有内置定义、程序注入的职责规矩、只读工具和提交原型的权限，/one:agents 有它的一栏；PM 和计划任务都用不了它。

## 业务规则（来源：PRD prototype-designer）
- 原型设计师只出原型：一份单个 HTML 文件，样式和脚本写在文件里，浏览器直接打开就能看。
- 内置定义名 `prototype`，正文为空，模型、思考等级不写（默认跟随主窗口）；描述写"只能由主窗口派出，在澄清阶段出界面原型（单个 HTML）。"。
- 职责规矩放在定义正文之后，并写明优先于正文。规矩内容包括：
  - 只交一个 HTML 文件，样式和脚本写在文件里，浏览器直接打开就能看。
  - 图形界面画出正常、空数据、加载中、出错四种状态，有交互的地方能点。
  - 终端界面用深色背景、等宽字体、80 列模拟终端窗口，多步交互按顺序画出每一步。
  - 有上一版和用户返工意见时，先读上一版，再按意见改。
  - 不包含先红后绿。
- 原型设计师只能读仓库里的文件，不能改，也不能运行验证命令。它的宿主工具是 read、grep、find、ls，核心工具只有知识查询和提交原型。
- /one:agents：
  - 在 explore 栏后、设定栏前新增 prototype 栏。
  - 内置定义显示"跟随主会话 / 跟随"，右上角的内置计数多 1。
  - 栏底说明文字同描述。
  - 能复制，复制出的定义归在这一栏。
- PM 不能派原型设计师。PM 的定义目录不列 prototype 这一类；计划任务的角色也不能是 prototype。PM 指定了 prototype 类定义去承担 worker、reviewer、qa 时，派出失败，原因写"原型设计师只能由主窗口派出，在澄清阶段出原型"。

## 涉及文件
- runtime/roles.ts（修改）
- runtime/core-permissions.ts（修改）
- runtime/role-tools.ts（修改）
- runtime/package-rules.ts（修改）
- runtime/agent-resolve.ts（修改）
- runtime/agent-catalog-ui.ts（修改）
- runtime/pm-overview.ts（修改，ROLE_LABEL 加一项）
- agents/prototype.md（新建）
- role-rules/prototype.md（新建，按 role-rules/worker-prototype.md 改写；旧文件在 03 删除）
- tests/role-catalog.test.ts、tests/core-permissions.test.ts、tests/agent-catalog-ui.test.ts、tests/agents-page.test.ts、tests/agent-session.test.ts（修改，补新职责）

## 成品定义
`agents/prototype.md`：
```markdown
---
name: prototype
description: 只能由主窗口派出，在澄清阶段出界面原型（单个 HTML）。
role: prototype
skills: []
mcp: []
---
```

`role-rules/prototype.md`：
```markdown
你是原型设计师，只出界面原型，不写实现代码。
- 只交单个 HTML 文件：样式和脚本都写在文件里，不引用外部文件，浏览器直接打开就能看。用 result_submit 的 prototype 动作提交 html 全文和一句说明；超过 1 MiB 或不是 HTML 会被拒收，按原因改后重交。
- 图形界面（网页、桌面或手机界面）：还原布局、配色、文案，画出正常、空数据、加载中、出错四种状态，有交互的地方做成能点的。
- 终端界面（命令行输出、表格、进度条、交互提示）：在 HTML 里模拟一个终端窗口，深色背景、等宽字体、固定 80 列，颜色按实际终端效果还原；多步交互按顺序画出每一步的画面。
- 任务说明里给出上一版文件和用户的返工意见时，先用 read 读上一版，按用户原话改，没提到的地方保持不变。
- 只能读仓库里的文件，不能改文件，也不能运行命令；需要了解现有界面时读源码和样式。
- 任务说明里有项目规范时，原型不得与之冲突；不清楚就停下，在说明里写明，不猜。
```

## 函数清单
### runtime/roles.ts
| 函数名 | 职责 |
|---|---|
| `AGENT_ROLES` / `DEFINITION_ROLES` | 常量各加 `prototype` |
### runtime/core-permissions.ts
| 函数名 | 职责 |
|---|---|
| `CORE_ROLES` / `MATRIX` | 加 `prototype` 行：knowledge_query 全部、result_submit 只有 prototype（worker 的 prototype 权限在 03 去掉） |
### runtime/role-tools.ts
| 函数名 | 职责 |
|---|---|
| `ROLE_HOST_TOOLS` | `prototype` 给 read、grep、find、ls |
### runtime/package-rules.ts
| 函数名 | 职责 |
|---|---|
| `RoleRulesName` | 加 `prototype`（`worker-prototype` 在 03 去掉） |
### runtime/agent-resolve.ts
| 函数名 | 职责 |
|---|---|
| `resolveAgentDefinition`（现有解析入口） | 定义职责是 prototype、要承担的职责不是 prototype 时，报上面那句原因 |
### runtime/agent-catalog-ui.ts
| 函数名 | 职责 |
|---|---|
| `ROLE_TABS` | 在 explore 后加 prototype |

## 协作关系
- `daemon/agent-session.ts` 按 `ROLE_HOST_TOOLS` 和 `MATRIX` 给会话装工具，不用改。
- PM 的定义目录过滤（`daemon/pm-tools.ts` 的 role 枚举）和计划任务角色（`runtime/plan-manage.ts` 的 DelegatedRole）都不加 prototype，保持现状即可。

## 验证方式
- 测试入口：`loadRoleRules`、定义加载与 `/one:agents` 页面渲染、`authorizeToolAction`、会话工具装配、PM 派工。
- 测试输入：内置定义目录；复制 prototype 的用户定义；PM 用 prototype 类定义派 worker 任务。
- 预期结果：
  - [ ] 内置定义共 5 份，prototype 正文为空。`loadRoleRules("prototype")` 含 C-7 各项，不含"先红后绿"。
  - [ ] `authorizeToolAction("prototype","result_submit","prototype")` 为真；prototype 没有 change_apply 和 verification_run。
  - [ ] prototype 会话的宿主工具正好是 read、grep、find、ls。
  - [ ] 渲染 /one:agents：分类栏顺序是 worker、reviewer、qa、explore、prototype，最后是设定；内置计数 5；prototype 栏底有说明文字；按 C 复制后新定义出现在 prototype 栏。
  - [ ] PM 用 prototype 类定义派 worker 任务时被拒，原因含"只能由主窗口派出"；PM 列定义时没有 prototype 类。
