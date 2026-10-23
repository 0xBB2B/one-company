---
name: vue-pitfalls
description: Vue 3 安全与鲁棒性常见坑：用户内容当模板、v-html、用户 URL 与样式、服务端渲染、响应式丢失、监听和定时器泄漏、路由守卫、异步与错误处理。
---
# Vue 常见坑排查清单

## 用户内容注入
### 1. 把用户内容当组件模板
- 问题：Vue 模板等于可执行的 JavaScript。用户提供的字符串一旦被当作模板编译，攻击者就能在你的页面里运行任意代码。官方把这条列为第一规则。
- 怎么认出：`createApp({ template: userInput })`、`compile(userInput)`、`defineComponent({ template: ... })` 的内容来自接口、URL 参数或数据库。
- 修法：用户内容只做插值 `{{ text }}`，不当模板；确实要让用户排版，用受限的标记语言（如 Markdown）加净化后再渲染。
- 出处：https://vuejs.org/guide/best-practices/security.html#rule-no-1-never-use-non-trusted-templates

### 2. v-html 渲染用户内容（XSS）
- 问题：`v-html` 把字符串当 HTML 直接塞进页面，用户提交的 `<img onerror=...>` 就会执行。XSS 指攻击者的脚本在别人浏览器里运行。Vue 默认的插值会转义，只有 `v-html` 和 `innerHTML` 不转义。
- 怎么认出：`v-html="xxx"`、`h('div', { innerHTML: xxx })`、JSX 里的 `innerHTML={xxx}`，且 `xxx` 来自用户、接口或第三方。
- 修法：能用文本插值就用文本；必须显示富文本时，后端或前端用 DOMPurify 这类净化库处理后再给 `v-html`。
- 出处：https://vuejs.org/guide/best-practices/security.html#html-injection

### 3. `:href` 绑定用户给的 URL（javascript:）
- 问题：`javascript:alert(1)` 也是合法的链接地址，用户点击就会执行脚本。Vue 不会检查链接协议。
- 怎么认出：`<a :href="user.website">`、`<a :href="profile.homepage">` 的值来自用户输入，没有协议检查。
- 修法：存入数据库前由后端校验协议只允许 `http:`、`https:`（或 `mailto:`）；数据已经入库又改不了后端时，前端渲染前用 `try { new URL(v, location.origin).protocol } catch {}` 取出协议做白名单判断（相对地址如 `/u/1` 会按当前站点解析），不通过就不渲染成链接。
- 出处：https://vuejs.org/guide/best-practices/security.html#url-injection

### 4. 用户可控的 `:style`
- 问题：用户能决定整段样式时，可以把链接拉成透明大方块盖在登录按钮上，诱导点击（点击劫持）。官方推荐的安全写法是对象语法，只开放特定属性的值。
- 怎么认出：`:style="user.styles"`（整段样式字符串或整个样式对象来自用户）；或用户能决定属性名；或用户能改 `position`、尺寸、`z-index`、`opacity` 这类能遮盖页面其他元素的属性。
- 修法：写成对象语法，只开放少数属性的值：`:style="{ color: userColor, background: userBg }"`；要完全放开用户样式，就放进沙盒 iframe。
- 出处：https://vuejs.org/guide/best-practices/security.html#style-injection

### 5. 把用户提供的字符串绑定到事件属性
- 问题：`onclick`、`onfocus` 这类 HTML 属性接受 JavaScript 字符串，用户给的内容绑上去就会被执行。
- 怎么认出：`:onclick="userString"`、`:onfocus="config.script"`、`h('div', { onmouseenter: userString })`，字符串来自用户或接口。
- 修法：事件只绑定自己写的函数 `@click="handler"`；用户数据只能当参数传给这些函数，不当代码执行。
- 出处：https://vuejs.org/guide/best-practices/security.html#javascript-injection

### 6. Vue 挂载到含用户内容的服务端渲染页面上
- 问题：服务端渲染（在服务器上先生成 HTML，再发给浏览器）出来的整页里含用户内容时，如果把 Vue 挂载到这个节点上，Vue 会把里面的内容当模板编译。对纯 HTML 安全的内容，对 Vue 模板可能是脚本。
- 怎么认出：`createApp(App).mount('body')`、`mount('#content')` 指向的节点里，服务端已经输出了用户评论、昵称、文章等内容；或旧页面里用 Vue 2 `new Vue({ el: '#app' })` 直接接管服务端模板。
- 修法：Vue 只挂载到不含用户内容的空容器；用户内容放进组件数据，用插值渲染；需要服务端渲染就用官方的 SSR 方案，由浏览器端水合（接管服务端发来的 HTML），不要整页接管。
- 出处：https://vuejs.org/guide/best-practices/security.html#server-side-rendering-ssr

## 服务端渲染
### 7. 模块顶层的响应式状态在服务端被所有请求共享
- 问题：服务端渲染时，模块只加载一次。写在模块顶层的 `ref`、`reactive` 会被所有用户的请求共用，A 用户的数据可能出现在 B 用户的页面里。
- 怎么认出：`export const user = ref(null)` 或模块顶层 `const state = reactive({...})`，被服务端渲染的组件使用，项目有 SSR（Nuxt、Vite SSR）。
- 修法：每个请求创建一份新实例：用工厂函数 `createApp()` 配 Pinia 的 `createPinia()`，状态放进 store 或在 `setup` 里创建。
- 出处：https://vuejs.org/guide/scaling-up/ssr.html#cross-request-state-pollution

### 8. 服务端和浏览器渲染的结果不一致（水合不一致）
- 问题：水合（hydration）是浏览器把服务端发来的 HTML 接管成可交互页面的过程。两边输出不同，会报 hydration mismatch，轻则警告，重则页面错乱。
- 怎么认出：模板或 `setup` 里直接用 `Math.random()`、`Date.now()`、`new Date()`、`window.innerWidth`、`localStorage` 决定渲染内容；`<p>` 里嵌 `<div>` 这类无效的 HTML 嵌套。
- 修法：只在客户端才有的值放到 `onMounted` 里再赋值（首次渲染两边一致）；修正无效嵌套。
- 出处：https://vuejs.org/guide/scaling-up/ssr.html#hydration-mismatch

### 9. 在服务端运行的代码里访问 window / document
- 问题：Node.js 里没有 `window` 和 `document`，在 `setup` 或模块顶层访问会直接抛错，整个页面返回 500。
- 怎么认出：SSR 项目里，组件的 `<script setup>` 顶层或被引入的模块顶层出现 `window.`、`document.`、`localStorage`。
- 修法：把这类访问放进 `onMounted`（只在浏览器执行）；共用的库用 `typeof window !== 'undefined'` 判断。
- 出处：https://vuejs.org/guide/scaling-up/ssr.html#access-to-platform-specific-apis

## 响应式丢失
### 10. 解构 reactive 对象后丢失响应式
- 问题：`reactive` 靠属性访问来追踪变化。把属性解构出来，拿到的是普通值，之后原对象变化它不会跟着变。
- 怎么认出：`const { count } = reactive({...})` 或 `const { name } = state`，随后在模板或 `computed` 里使用 `name`；把 `state.count` 直接传给函数。
- 修法：用 `toRefs(state)` 再解构，或写 `toRef(state, 'count')`；也可以一开始就用多个 `ref`。
- 出处：https://vuejs.org/guide/essentials/reactivity-fundamentals.html#limitations-of-reactive

### 11. 整体替换 reactive 变量
- 问题：`reactive` 返回的是代理对象，重新赋值整个变量会断开模板对旧对象的追踪，界面不更新。
- 怎么认出：`let state = reactive({...})` 后面有 `state = reactive(newData)` 或 `state = await fetchData()`。
- 修法：用 `const data = ref(...)`，整体替换写 `data.value = newData`；或用 `Object.assign(state, newData)`。
- 出处：https://vuejs.org/guide/essentials/reactivity-fundamentals.html#limitations-of-reactive

### 12. 解构 props：3.4 及以下得到固定值，3.5 起传给 watch 要包成函数
- 问题：Vue 3.4 及以下，`const { foo } = defineProps(...)` 得到的是常量，父组件更新 `foo` 后这里不会变。3.5 起 `<script setup>` 里的解构能保持响应式，但直接把 `foo` 传给 `watch(foo, ...)` 或组合式函数（把可复用的响应式逻辑抽成 `use` 开头的函数）时，传进去的只是一个值：传给 `watch` 会在编译时报错，传给组合式函数没有任何提示，只是不会响应变化。
- 怎么认出：`package.json` 里 `vue` 低于 3.5，且有 `const { foo } = defineProps(...)` 后在 `watch`、`computed` 里使用 `foo`；或任何版本里出现 `watch(foo, ...)`、`useXxx(foo)`，而 `foo` 来自解构的 props。
- 修法：低于 3.5 时用 `props.foo`、`toRef(props, 'foo')`；3.5 起传给 `watch` 或组合式函数时包成 getter：`watch(() => foo, ...)`、`useXxx(() => foo)`。
- 出处：https://vuejs.org/guide/components/props.html#reactive-props-destructure 、https://vuejs.org/guide/components/props.html#passing-destructured-props-into-functions

### 13. 解构 Pinia store 丢失响应式
- 问题：store 里的 state 和 getter 是响应式属性，解构后得到固定值，store 更新时这里不再变化。
- 怎么认出：`const { count, name } = useCounterStore()`，之后在模板里用 `count`。
- 修法：状态和 getter 用 `const { count } = storeToRefs(store)`；action 可以直接解构，因为它们已绑定在 store 上。
- 出处：https://pinia.vuejs.org/core-concepts/#Destructuring-from-a-Store

### 14. ref 放进 reactive 的数组或 Map 后不会自动解包
- 问题：ref 在 reactive 对象的属性上会自动解包，但放在数组或 Map 里不会，直接当值用会拿到 ref 对象本身。
- 怎么认出：`reactive([ref(1)])`、`reactive(new Map([['a', ref(0)]]))` 之后读 `list[0]` 或 `map.get('a')` 当数字用。
- 修法：读取时写 `.value`，或不要把 ref 放进集合，直接放普通值。
- 出处：https://vuejs.org/guide/essentials/reactivity-fundamentals.html#caveat-in-arrays-and-collections

## 监听、清理与模板写法
### 15. onMounted 里加的监听和定时器，没在 onUnmounted 清理
- 问题：组件销毁后，`addEventListener`、`setInterval`、WebSocket 仍在运行，持有组件的引用，内存越积越多，回调还会去改已销毁的组件。
- 怎么认出：`onMounted` 里有 `window.addEventListener`、`setInterval`、`new WebSocket`、`new ResizeObserver`，同一个文件没有对应的 `removeEventListener`、`clearInterval`、`close()`、`disconnect()` 或 `onUnmounted`。
- 修法：保存句柄，在 `onUnmounted(() => { window.removeEventListener('resize', onResize); clearInterval(timer) })` 里释放；复用的逻辑封装成组合式函数，在函数内自己清理。
- 出处：https://vuejs.org/guide/reusability/composables.html#side-effects

### 16. 生命周期钩子在异步回调里注册
- 问题：`onMounted` 等钩子必须在组件初始化（`setup`）期间同步调用。放进 `setTimeout`、`.then`、事件回调里，Vue 找不到当前组件，钩子不会生效。
- 怎么认出：`setTimeout(() => { onMounted(...) })`、`fetch().then(() => onUnmounted(...))`、按钮点击函数里调用 `onMounted`。
- 修法：把钩子写在 `setup` 同步执行的位置；钩子可以放在被 `setup` 同步调用的外部函数里。
- 出处：https://vuejs.org/guide/essentials/lifecycle.html#registering-lifecycle-hooks

### 17. 在异步回调里创建的 watch 不会自动停止
- 问题：只有在 `setup` 里同步创建的监听器，才会随组件销毁而停止。异步回调里创建的不会，组件销毁后继续运行，造成内存泄漏。
- 怎么认出：`setTimeout(() => { watch(...) })`、`.then(() => { watchEffect(...) })`、事件处理函数里新建 `watch`，且没有保存返回值。
- 修法：把 `watch` 移到 `setup` 同步位置；必须异步创建时，保存返回的停止函数，在 `onUnmounted` 里调用。
- 出处：https://vuejs.org/guide/essentials/watchers.html#stopping-a-watcher

### 18. watch 里发请求，旧请求结果覆盖新结果
- 问题：监听的 id 连续变化时，先发的请求可能后返回，把过期数据写进界面。
- 怎么认出：`watch(id, async (newId) => { data.value = await fetch(...) })`，没有取消旧请求或比较 id。
- 修法：用 `onWatcherCleanup`（3.5 起）或回调第三个参数 `onCleanup`，在里面 `controller.abort()` 取消旧请求。
- 出处：https://vuejs.org/guide/essentials/watchers.html#side-effect-cleanup

### 19. 对大对象开 deep watch
- 问题：`deep: true` 会遍历被监听对象的所有嵌套属性，对象大时每次改动都有明显开销，而且回调里旧值和新值是同一个对象。
- 怎么认出：`watch(bigObject, cb, { deep: true })`，被监听的是长列表或整份表单、整张表。
- 修法：用 getter 只监听关心的字段 `watch(() => obj.user.id, cb)`；确实要深度监听时给 `deep` 传数字限制层数（3.5 起）。
- 出处：https://vuejs.org/guide/essentials/watchers.html#deep-watchers

### 20. 在模板里调用方法算出列表数据，每次更新都重新计算
- 问题：模板里 `{{ filterList() }}` 或 `v-for="x in sortItems()"`，组件每次重新渲染都会重新执行这个函数；`computed` 则只在依赖变化时才重新计算。数据量大时会明显变慢。
- 怎么认出：模板里调用方法做过滤、排序、汇总，如 `v-for="u in getActiveUsers()"`，函数体里只读取响应式数据、不接收事件参数；列表很长或计算很重时才列为阻塞。
- 修法：改成 `const activeUsers = computed(() => ...)`，模板里直接写 `activeUsers`。
- 出处：https://vuejs.org/guide/essentials/computed.html#computed-caching-vs-methods

### 21. watchEffect 里 await 之后读取的数据不会被追踪
- 问题：`watchEffect` 只追踪同步执行阶段读到的响应式数据。写成 `async` 函数时，第一个 `await` 之后才读的数据，变化时不会触发重新执行。
- 怎么认出：`watchEffect(async () => { const r = await fetch(...); use(state.keyword) })`，响应式变量在 `await` 之后才读。
- 修法：把需要追踪的变量在 `await` 之前读出来；或改用 `watch(() => state.keyword, handler)` 明确指定监听源。
- 出处：https://vuejs.org/guide/essentials/watchers.html#watcheffect

## 路由、权限与错误处理
### 22. 路由守卫只当作体验优化，权限必须后端校验
- 问题：前端的路由守卫运行在用户浏览器里，用户可以改代码、直接调接口绕过。只靠它拦截，等于没有权限控制。
- 怎么认出：`router.beforeEach` 里用 `role === 'admin'`、`meta.requiresAdmin` 来保护页面。同一个 diff 里有后端代码时，检查对应接口有没有校验身份和权限；只有前端代码时无法判定，只能标“需确认后端已校验”，不算阻塞问题。
- 修法：守卫只负责跳转登录页、隐藏入口；每个接口在后端校验身份和权限，返回 401/403，前端收到后统一处理。
- 出处：https://owasp.org/Top10/2025/A01_2025-Broken_Access_Control/ 、https://router.vuejs.org/guide/advanced/navigation-guards.html

### 23. 同一路由组件被复用，params 变了 onMounted 不再执行
- 问题：从 `/users/1` 跳到 `/users/2` 时，Vue 复用同一个组件实例，`onMounted` 不会再跑，页面还显示上一个用户的数据。
- 怎么认出：动态路由组件在 `onMounted` 里根据 `route.params.id` 取数，没有 `watch(() => route.params.id, ...)`。
- 修法：用 `watch(() => route.params.id, load, { immediate: true })` 监听参数变化并取数。
- 出处：https://router.vuejs.org/guide/essentials/dynamic-matching.html

### 24. 异步组件没有加载失败的处理
- 问题：`defineAsyncComponent` 加载失败（网络断开、发布后旧文件被删）时，没有错误组件，页面这一块空白，用户不知道发生了什么。
- 怎么认出：`defineAsyncComponent(() => import('./Heavy.vue'))` 只传了函数，没有 `errorComponent`、`timeout`、`onError`。
- 修法：传选项对象：`{ loader, loadingComponent, errorComponent, timeout: 3000 }`；需要重试时用 `onError(error, retry, fail, attempts)` 回调。
- 出处：https://vuejs.org/guide/components/async.html#loading-and-error-states 、https://vuejs.org/api/general.html#defineasynccomponent

