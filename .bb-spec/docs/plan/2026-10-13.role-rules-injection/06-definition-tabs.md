---
name: definition-tabs
description: /one:agents 去掉 pm 栏，所有定义都能复制成新名字，详情新增正文一行，内置与复制出的文件带空 skills 和 mcp
---
# 角色定义栏调整

## 目标
/one:agents 左边只剩 worker、reviewer、qa、explore 四栏，任何定义按 C 都能复制成新名字，详情里看得出正文写没写，复制出来的文件自带空的 skills 和 mcp。

## 业务规则（来源：PRD definition-tabs）
- 界面以用户已确认的预览为准：`.bb-spec/.cache/ui-preview/agents-settings.html` 里「二、角色定义栏」的 4 个画面（列表、展开详情、复制、复制完成）和「三、文件内容」。实现完成后逐个对照，不一致要报告。
- 分类栏左边依次是 worker、reviewer、qa、explore，右边竖线后是设定栏，有问题时再加问题栏；不再有 pm 栏。右上角计数只算这四种职责的定义。
- 任何定义按 C 都进"复制 <名称> 为新定义"，默认名 `<名称>-copy`，名字规则不变（小写字母、数字、连字符，最多 64 个字符，三层里不能重名）；不再有"只能同名""C 复制（只能同名）"。
- 复制出来的文件：头部原样复制，只改 name；源文件没写 skills 或 mcp 时补上 `skills: []`、`mcp: []`，写了的原样保留；正文原样保留（内置定义正文为空）。
- 展开详情在 MCP 和文件之间新增「正文」一行：正文为空时写"空 · 流程规矩由程序加上，正文只写专长和偏好"，写了正文时写"已写 · 流程规矩由程序加上，优先于正文"。
- 复制完成后的提示："✓ 已复制到 <路径>，打开它写专长、skills 和 mcp"。
- 页面不显示工具；定义里写工具字段仍按"不认识的字段"进问题栏（现状，不用改）。

## 涉及文件
- 修改 `runtime/agent-catalog-ui.ts`
- 修改 `runtime/agent-copy.ts`
- 修改 `runtime/roles.ts`（删 `sameNameOnly`）
- 修改 `extensions/settings.ts`
- 修改测试：`tests/agent-catalog-ui.test.ts`、`tests/agents-page.test.ts`、`tests/role-catalog.test.ts` 里与 pm 栏、同名复制相关的部分

## 成品定义
复制出的文件头部（以内置 worker 复制为 vue-engineer 为例）：
```markdown
---
name: vue-engineer
description: 按派工目标实现代码与测试，也承担获准范围内的领域设计，经受控工具写入并自测后提交结果
role: worker
model: gpt-6.1-sol
thinking: high
skills: []
mcp: []
---
```

## 函数清单
### runtime/agent-catalog-ui.ts
| 函数名 | 职责 |
|---|---|
| `ROLE_TABS` | 修改：只剩 worker、reviewer、qa、explore |
| `header` | 修改：计数只算四种职责的定义 |
| `handleInput` / `handleNaming` / `renderNaming` / `hint` | 修改：去掉只能同名复制的锁定分支 |
| `entryDetail` | 修改：新增「正文」一行 |
| `describe` | 不改：描述 · skills · MCP |

### runtime/agent-copy.ts
| 函数名 | 职责 |
|---|---|
| `copyAgentDefinition` | 修改：去掉同名复制分支；改 name 的同时，头部缺 skills 或 mcp 时补上空列表 |

### runtime/roles.ts
| 函数名 | 职责 |
|---|---|
| `sameNameOnly` | 删除 |

### extensions/settings.ts
| 函数名 | 职责 |
|---|---|
| `openSettingsPage` | 修改：复制流程去掉同名分支；复制完成提示改成上面那句 |

## 协作关系
- `openSettingsPage` → `AgentCatalogView`（复制请求）→ 现有的选层窗口 `chooseWindow` → `copyAgentDefinition`。

## 验证方式
- 测试入口：`AgentCatalogView` 的 `render(80)` 与 `handleInput`；`copyAgentDefinition`；`openSettingsPage`（假 ctx）。测试目录用单层 `/tmp/pi-t-XXXXXX`。
- 测试输入：内置四个定义；用户层一份正文为"擅长 Vue"的 vue-engineer；一份头部没写 skills、mcp 的用户定义；一份写了 `tools:` 的定义。
- 预期结果：
  - [ ] 分类栏左边只有 worker、reviewer、qa、explore，右边是设定栏；没有 pm 栏；右上角"内置 4"
  - [ ] 选中内置 explore 按 C，默认名 explore-copy，可改名，选层后生成文件；输入已有的名字时提示换一个
  - [ ] 复制内置 worker 得到的文件头部与成品一致，正文为空
  - [ ] 复制没写 skills、mcp 的用户定义，新文件补上了 `skills: []`、`mcp: []`，正文原样保留
  - [ ] 展开内置 worker 详情显示"空 · 流程规矩由程序加上，正文只写专长和偏好"；展开 vue-engineer 显示"已写 · 流程规矩由程序加上，优先于正文"
  - [ ] 写了 tools 的定义出现在问题栏，原因是不认识的字段
  - [ ] 复制完成提示为"✓ 已复制到 <路径>，打开它写专长、skills 和 mcp"
  - [ ] 和预览「二、角色定义栏」4 个画面逐个对照一致
