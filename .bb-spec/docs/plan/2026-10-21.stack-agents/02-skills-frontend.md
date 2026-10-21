---
name: skills-frontend
description: 写 Vue、React 的编码规范和排查清单共 4 份 skill
---
# 前端 skill（4 份）

## 目标
包里的 `skills/` 新增 vue-coding、vue-pitfalls、react-coding、react-pitfalls 4 份 skill，格式和主题覆盖通过检查。

## 业务规则（来源：PRD skills-and-acceptance）
- 每份 skill 是 `skills/<名字>/SKILL.md`，设置段 `name` 与目录名一致、`description` 一句话写清覆盖什么；连设置段不超过 200 行；中文大白话，标识符保持英文。
- 每个检查项固定四行：问题、怎么认出（diff 里看得见的特征）、修法、出处（https 链接，优先 Vue / React 官方文档和 OWASP；只有二手资料时注明「二手资料」）。写入时每个链接实际打开一次，2xx 或 3xx 才算数，打不开换出处，换不到删掉这一项。
- 必须覆盖的主题（每个至少一项，有余量再补同类常见问题）：
  - vue-coding：按 Vue 官方风格指南——组件名多个单词、prop 定义写全、v-for 带稳定 key、v-if 不和 v-for 写在同一元素；用 `<script setup lang="ts">`；computed 里不写副作用；不直接改 props。
  - vue-pitfalls：把用户内容当组件模板；`v-html` 渲染用户内容造成 XSS；`:href` 绑定用户 URL（`javascript:`）；用户可控的 style；Vue 挂载到含用户内容的服务端页面；解构 reactive 对象丢失响应式；`onMounted` 里加的监听和定时器在 `onUnmounted` 没清理；路由守卫只当 UX，权限必须后端校验。
  - react-coding：按 Rules of React——Hooks 只在顶层调用、组件和 Hooks 保持纯；列表 key 稳定且唯一；能算出来的值不存 state；useEffect 只用来和外部系统同步。
  - react-pitfalls：`dangerouslySetInnerHTML` 渲染用户内容；href 绑定用户 URL（`javascript:`）；useEffect 依赖漏写、没有清理函数；请求竞态（旧请求结果覆盖新的）；用数组下标当 key；闭包拿到过期的 state。

## 涉及文件
- 新建 `skills/vue-coding/SKILL.md`、`skills/vue-pitfalls/SKILL.md`、`skills/react-coding/SKILL.md`、`skills/react-pitfalls/SKILL.md`
- 新建 `tests/skills-frontend.test.ts`

## 成品定义
SKILL.md 骨架与 `skills-backend-languages` 计划相同：

```markdown
---
name: <目录名>
description: <一句话：这份清单覆盖什么>
---
# <标题>

## <分组名>
### 1. <问题名>
- 问题：<是什么问题、会造成什么后果>
- 怎么认出：<diff 里看得见的代码特征>
- 修法：<具体怎么改，必要时一两行示例>
- 出处：<https://…>（二手资料时在链接后注明「二手资料」）
```

主题关键词表（`tests/skills-frontend.test.ts` 原样使用，区分大小写）：

```ts
const TOPICS: Record<string, string[]> = {
  "vue-coding": ["多个单词", "prop 定义", "v-for", "v-if", "<script setup lang=\"ts\">", "computed", "不直接改 props"],
  "vue-pitfalls": ["组件模板", "v-html", "javascript:", ":style", "服务端渲染", "解构", "onUnmounted", "路由守卫"],
  "react-coding": ["顶层调用", "保持纯", "列表 key", "不存 state", "useEffect"],
  "react-pitfalls": ["dangerouslySetInnerHTML", "javascript:", "清理函数", "竞态", "下标当 key", "过期的 state"],
};
```

## 函数清单
### tests/skills-frontend.test.ts
| 函数名 | 职责 |
|---|---|
| （无新函数） | 用 `tests/helpers/skill-lint.ts` 的 `skillLintErrors` 逐份检查 TOPICS 里的 4 份 skill |

## 协作关系
依赖 `skills-backend-languages` 计划建立的 `tests/helpers/skill-lint.ts`。不改产品代码。

## 验证方式
- 测试入口：`pnpm test -- tests/skills-frontend.test.ts`
- 测试输入：`skills/` 下 4 个目录
- 预期结果：每份的格式错误列表为空
- [ ] 4 份 SKILL.md 存在、name 一致、≤ 200 行，检查项四行齐全、出处为 https
- [ ] TOPICS 里每个关键词都能找到
- [ ] 链接检查：一次性脚本（`.bb-spec/.cache/skill-links/`）列出 4 份 skill 全部出处链接的 HTTP 状态，无 4xx、5xx、连不上；结果和「二手资料」清单贴进提交说明
