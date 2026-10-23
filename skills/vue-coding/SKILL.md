---
name: vue-coding
description: Vue 3 编码规范：按官方风格指南命名、写全 props 和 emits、v-for 带 key、script setup 加 TS、computed 保持纯净、不改 props，写 Vue 代码时遵守、审查时逐项对照。
---
# Vue 编码规范

## 组件与命名
### 1. 组件名用多个单词
- 问题：自己写的组件名只有一个单词（如 `Item`、`Table`），容易和现有或将来的 HTML 标签重名，官方风格指南把它列为必须遵守的规则。
- 怎么认出：新增的 `.vue` 文件名或 `name`、`app.component('Todo', ...)` 里只有一个单词；根组件 `App` 和 `<Transition>` 这类内置组件除外。
- 修法：改成两个以上单词，如 `TodoItem`、`BaseTable`。
- 出处：https://vuejs.org/style-guide/rules-essential.html#use-multi-word-component-names

### 2. 单文件组件文件名统一大小写
- 问题：同一项目里 `myComponent.vue`、`my-component.vue`、`MyComponent.vue` 混着用，在不区分大小写的文件系统（macOS、Windows 默认）上，只改大小写的重命名会让 git 和打包工具出问题。
- 怎么认出：`components/` 下文件名大小写风格不一致，或 `import` 的路径和实际文件名大小写对不上。
- 修法：全项目统一用 PascalCase（`TodoItem.vue`）或统一用 kebab-case（`todo-item.vue`），二选一。
- 出处：https://vuejs.org/style-guide/rules-strongly-recommended.html#single-file-component-filename-casing

### 3. prop 在声明里用 camelCase
- 问题：声明时写成 `greeting-text`，和 JS 里访问的名字对不上，同一个 prop 在项目里出现两种写法，搜索和重构都容易漏。
- 怎么认出：`defineProps` 或 `props` 里的键带连字符，如 `'greeting-text': String`。
- 修法：声明用 `greetingText`；单文件组件的模板里写 `greeting-text` 或 `greetingText` 都行，但全项目保持一种。
- 出处：https://vuejs.org/style-guide/rules-strongly-recommended.html#prop-name-casing

## Props、事件与类型
### 4. 用 `<script setup lang="ts">` 写组件
- 问题：不写 `lang="ts"` 的组件拿不到类型检查，props、事件、模板里的类型错误都要到运行时才暴露。
- 怎么认出：新组件是 `<script>` 加 `export default {}`，或 `<script setup>` 没有 `lang="ts"`。
- 修法：写成 `<script setup lang="ts">`，并给项目配上 `vue-tsc` 做类型检查。
- 出处：https://vuejs.org/guide/typescript/overview.html#usage-in-single-file-components

### 5. prop 定义写全（类型、必填、默认值）
- 问题：prop 只写名字时，别人看不出该传什么，传错类型也没有开发期警告。官方要求提交的代码里至少写明类型。
- 怎么认出：`props: ['size']`、`defineProps(['size'])` 传字符串数组；对象写法里只有 `size: null`。
- 修法：运行时写法给出 `{ type: String, required: true }`；也可以用类型写法 `defineProps<{ size?: string }>()`，用 `?` 标可选，默认值用 `withDefaults` 或解构默认值。
- 出处：https://vuejs.org/style-guide/rules-essential.html#use-detailed-prop-definitions

### 6. 对象和数组类型的 prop 默认值用工厂函数
- 问题：运行时写法里直接写 `default: []`，多个组件实例会共用同一个数组，一处改动影响所有实例。
- 怎么认出：`default: []`、`default: {}`、`default: { ... }` 出现在 `type: Array` 或 `type: Object` 的 prop 上。
- 修法：写成函数 `default: () => []`；类型写法用 `withDefaults(defineProps<...>(), { list: () => [] })`。
- 出处：https://vuejs.org/guide/components/props.html#prop-validation

### 7. 子组件发出的事件用 defineEmits 声明
- 问题：没声明的事件，父组件的监听会被当成原生事件监听器落到子组件的根元素上，行为和预期不一致，也没有类型提示。
- 怎么认出：代码里有 `emit('xxx')` 或模板里有 `$emit('xxx')`，但文件里没有 `defineEmits`。
- 修法：用 `const emit = defineEmits<{ submit: [id: string] }>()` 声明事件名和参数类型，再调用 `emit('submit', id)`。
- 出处：https://vuejs.org/guide/components/events.html#declaring-emitted-events

### 8. 不直接改 props，要改就复制或通知父组件
- 问题：props 是只读的，子组件直接赋值（`props.count = 1`）Vue 会在控制台警告，而且父组件下次更新时会把值覆盖回去，数据流向变得无法追踪。
- 怎么认出：`props.xxx = ...`、`props.list.push(...)`、模板里 `v-model="props.xxx"`。
- 修法：想要本地可改的副本，用 `const local = ref(props.initial)`；想让父组件改，`emit('update', value)`；需要转换后的值，用 `computed`。
- 出处：https://vuejs.org/guide/components/props.html#one-way-data-flow

### 9. 双向绑定用 defineModel（3.4 起）
- 问题：自己写 `modelValue` prop 加 `update:modelValue` 事件，再配本地 ref 同步，代码长，还容易漏掉一边。
- 怎么认出：`defineProps<{ modelValue: ... }>()` 和 `emit('update:modelValue', ...)` 成对出现，旁边有一个 `watch` 在同步本地值。
- 修法：Vue 3.4 及以上写 `const model = defineModel<string>()`，直接读写 `model.value`；低于 3.4 才保留手写的 prop 加事件。
- 出处：https://vuejs.org/guide/components/v-model.html

## 模板
### 10. v-for 带稳定的 key
- 问题：组件上用 `v-for` 必须带 `key`，否则列表增删或重排时，组件内部状态（输入框内容、展开状态）会错位到别的行。
- 怎么认出：`<li v-for="item in items">` 没有 `:key`；或 `:key="index"` 而列表会插入、删除、排序。
- 修法：用数据自带的唯一 id：`v-for="item in items" :key="item.id"`；数据没有 id 就在加载时生成一个。
- 出处：https://vuejs.org/style-guide/rules-essential.html#use-keyed-v-for

### 11. v-if 和 v-for 不写在同一个元素上
- 问题：Vue 3 里 `v-if` 优先于 `v-for`，所以 `v-if` 读不到循环变量；Vue 2 则相反，`v-for` 优先，每次渲染都遍历整个列表再过滤。两个版本行为不同，同一元素上混用很容易出错。
- 怎么认出：`<li v-for="u in users" v-if="u.active">`，或 `v-for` 与 `v-if="shouldShow"` 在同一个标签上。
- 修法：过滤列表时，先写 `const activeUsers = computed(() => users.value.filter(u => u.active))` 再遍历；整体显示或隐藏时，把 `v-if` 移到外层的 `<ul>` 或 `<template>` 上。
- 出处：https://vuejs.org/style-guide/rules-essential.html#avoid-v-if-with-v-for 、https://v3-migration.vuejs.org/breaking-changes/v-if-v-for.html

### 12. 模板里只放简单表达式，复杂的挪进 computed
- 问题：模板里写一长串 `split().map().join()` 很难读，也没法复用和单独测试。
- 怎么认出：`{{ }}` 或指令值里有链式调用、嵌套三元、多行函数体。
- 修法：不需要参数的结果写成 `computed`，需要传参的格式化才写普通函数，模板里只引用名字。
- 出处：https://vuejs.org/style-guide/rules-strongly-recommended.html#simple-expressions-in-templates

### 13. 样式默认加 scoped
- 问题：全局样式的选择器会影响到别的组件，改一个组件的外观可能让别的页面变形。
- 怎么认出：业务组件里的 `<style>` 没有 `scoped` 也没有 CSS Modules（`module`），且不是有意写的全局样式。
- 修法：写 `<style scoped>`；确实要全局的样式放到单独的全局样式文件里。
- 出处：https://vuejs.org/style-guide/rules-essential.html#use-component-scoped-styling

## 响应式与复用逻辑
### 14. computed 里不写副作用
- 问题：computed 只该根据已有数据算出新值。在里面发请求、改别的状态、动 DOM，会在不确定的时机被重复执行，结果难以预测。
- 怎么认出：`computed(() => { ... })` 的函数体里出现 `fetch`、`xxx.value = ...`、`emit`、`document.` 或 `console.log` 之外的写操作。
- 修法：只保留纯计算和 `return`；需要在数据变化后做事，改用 `watch`，用户操作触发的事放进事件处理函数。
- 出处：https://vuejs.org/guide/essentials/computed.html#getters-should-be-side-effect-free

### 15. 不修改 computed 的返回值
- 问题：computed 的结果是根据源数据临时算出的快照，改它不会影响源数据，下次重算就被覆盖。
- 怎么认出：`const sorted = computed(() => list.value.sort(...))`（`sort`、`reverse` 会原地改动源数组）；或对 computed 的结果 `push`、赋值。
- 修法：先复制再处理，`[...list.value].sort(...)`，或用 `toSorted()`（ES2023，需确认运行环境支持）；要改数据就改源状态。
- 出处：https://vuejs.org/guide/essentials/computed.html#avoid-mutating-computed-value

### 16. 能算出来的值用 computed，不用 watch 去同步
- 问题：用 `watch` 把 A 复制到 B，多出一份要手动保持一致的状态，而且 `watch` 默认创建时不执行，初始值容易漏掉。
- 怎么认出：`watch(a, (v) => { b.value = f(v) })`，里面只有赋值、没有请求或其他外部操作。
- 修法：改成 `const b = computed(() => f(a.value))`。
- 出处：https://vuejs.org/guide/essentials/watchers.html

### 17. 大块只读数据用 shallowRef
- 问题：几万条只用来展示的数据被 `ref` 深度代理（Vue 会把对象里每一层属性都包一层代理，才能追踪变化），初始化和每次访问都有额外开销。
- 怎么认出：`ref(bigArray)`、`ref(接口返回的整张表)`，而且代码里从不修改其中的字段。
- 修法：用 `shallowRef(bigArray)`，更新时整体替换 `.value`。
- 出处：https://vuejs.org/guide/best-practices/performance.html#reduce-reactivity-overhead-for-large-immutable-structures

### 18. 复用逻辑的函数以 use 开头
- 问题：组合式函数指把一段带响应式状态的逻辑抽成可复用的函数。命名不统一，别人看不出它是组合式函数，也没法一眼知道它该在 `setup` 里调用。
- 怎么认出：`composables/` 目录里导出 `fetchUser`、`mouse` 这类不带 `use` 的名字。
- 修法：命名成 `useXxx`（驼峰，如 `useMouse`、`useFetch`）。
- 出处：https://vuejs.org/guide/reusability/composables.html#conventions-and-best-practices

### 19. 取模板引用用 useTemplateRef（3.5 起）
- 问题：旧写法要求变量名和模板里的 `ref="xxx"` 字符串完全相同，改名时只改一边不会有任何报错，变量就静默变成 `null`。
- 怎么认出：`const input = ref(null)` 配 `<input ref="input">`，vue 版本为 3.5 及以上。
- 修法：写 `const input = useTemplateRef('my-input')`，模板里 `ref="my-input"`；低于 3.5 版本沿用旧写法。
- 出处：https://vuejs.org/guide/essentials/template-refs.html#accessing-the-refs

### 20. provide/inject 用 InjectionKey 约定类型
- 问题：用字符串当键，提供方和使用方的类型各写各的，改了一边另一边照样通过编译，运行时才出错。
- 怎么认出：`provide('user', ...)` 和 `inject('user')`，没有泛型也没有共享的 key。
- 修法：在单独文件导出 `const userKey: InjectionKey<User> = Symbol()`，两边都用它。
- 出处：https://vuejs.org/guide/typescript/composition-api.html#typing-provide-inject

### 21. 路由页面组件用动态 import 懒加载
- 问题：路由表里把所有页面静态 `import` 进来，所有页面打进同一个包，首页要多下载其他页面的代码。
- 怎么认出：`router/index.ts` 顶部有一排 `import XxxView from '../views/XxxView.vue'`，并在 `routes` 里直接引用。
- 修法：改成 `component: () => import('../views/XxxView.vue')`，打包工具会自动拆成单独的文件，访问到对应路由时才下载。
- 出处：https://router.vuejs.org/guide/advanced/lazy-loading.html

### 22. defineExpose 只暴露必要的方法
- 问题：`<script setup>` 的组件默认是封闭的，父组件通过模板引用拿不到内部变量，要用 `defineExpose` 才能开放。一股脑全部暴露，父子耦合变紧，改子组件内部就会弄坏父组件。
- 怎么认出：`defineExpose({ state, list, loading, ... })` 暴露了一长串内部状态，或把整个 `reactive` 对象、`props` 传了进去。
- 修法：优先用 props 和 emits 通信；确实要命令式调用时，只暴露 `defineExpose({ focus })` 这样的少数方法。
- 出处：https://vuejs.org/api/sfc-script-setup.html#defineexpose

### 23. provide 的值要带上修改它的方法，不让使用方直接改
- 问题：提供一个 ref 给所有后代，任何后代都能直接 `inject` 后改它，出了错很难找到是谁改的。
- 怎么认出：`provide('count', count)`，而后代组件里有 `injected.value = ...`。
- 修法：在提供方定义修改函数，`provide('count', { count: readonly(count), update })`；改动都集中在提供方。
- 出处：https://vuejs.org/guide/components/provide-inject.html#working-with-reactivity

### 24. 父子组件通信用 props 和事件，不用 $parent
- 问题：子组件通过 `this.$parent` 直接读写父组件的数据，两个组件耦合得很深，换个位置使用或重构父组件，子组件就坏了，状态怎么流动也读不出来。
- 怎么认出：`this.$parent.xxx`、`getCurrentInstance().parent`、`$parent.$refs`。
- 修法：数据用 props 往下传，变化用事件往上抛，即“props 向下，事件向上”。
- 出处：https://vuejs.org/style-guide/rules-use-with-caution.html#implicit-parent-child-communication

### 25. 指令简写要么都用，要么都不用
- 问题：同一个项目里一会儿 `:value`，一会儿 `v-bind:value`，`@click` 和 `v-on:click` 混用，读代码时要来回切换。
- 怎么认出：同一文件或同一项目里同时出现 `v-bind:` 与 `:`，或 `v-on:` 与 `@`，或 `v-slot:` 与 `#`。
- 修法：全项目统一用简写（`:`、`@`、`#`），写进 lint 规则 `vue/v-bind-style`、`vue/v-on-style`。
- 出处：https://vuejs.org/style-guide/rules-strongly-recommended.html#directive-shorthands

