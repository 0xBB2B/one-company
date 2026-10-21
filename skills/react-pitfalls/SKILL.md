---
name: react-pitfalls
description: React 安全与鲁棒性常见坑：dangerouslySetInnerHTML 与用户 URL、useEffect 依赖和清理、请求竞态、过期的 state、数组下标当 key、渲染性能、错误边界、表单重复提交。
---
# React 常见坑排查清单

## 用户内容注入
### 1. dangerouslySetInnerHTML 渲染用户内容（XSS）
- 问题：这个属性把字符串当 HTML 原样塞进页面，不做转义。用户提交的 `<img onerror=...>` 会执行。XSS 指攻击者的脚本在别人浏览器里运行。JSX 里 `{text}` 默认会转义，这个属性绕过了它。
- 怎么认出：`dangerouslySetInnerHTML={{ __html: xxx }}`，`xxx` 来自用户输入、接口、富文本编辑器或 Markdown 转换结果。
- 修法：能用文本就用 `{text}`；必须渲染富文本时，先用 DOMPurify 这类净化库处理，再传给 `__html`。
- 出处：https://react.dev/reference/react-dom/components/common#dangerously-setting-the-inner-html 、https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html#html-sanitization

### 2. 通过 ref 直接写 innerHTML
- 问题：绕过 React，用 `ref.current.innerHTML = ...` 写入用户内容，效果和 `dangerouslySetInnerHTML` 一样，而且不容易被代码审查发现。
- 怎么认出：`ref.current.innerHTML =`，内容含用户数据。
- 修法：改用 `textContent` 或 JSX 渲染；一定要写 HTML 时先净化。
- 出处：https://developer.mozilla.org/en-US/docs/Web/API/Element/innerHTML#security_considerations

### 3. href 绑定用户给的 URL（javascript:）
- 问题：`javascript:alert(1)` 是合法链接，用户点击就执行。React 19 起会把渲染到 `href` 上的 `javascript:` 地址替换成点击就抛错的地址，但 React 18 及更早只在开发环境打印警告，仍然会原样渲染。
- 怎么认出：`<a href={user.website}>`、`<a href={profile.url}>`，值来自用户输入，没有协议校验；项目 `react` 版本低于 19 时风险最高。
- 修法：后端存入前校验协议只允许 `http:`、`https:`、`mailto:`；前端渲染前用 `try { new URL(v, location.origin).protocol } catch {}` 做白名单，解析出错或不在白名单里就不渲染成链接。升级到 19 不能代替校验。
- 出处：https://github.com/facebook/react/blob/v19.0.0/packages/react-dom-bindings/src/shared/sanitizeURL.js 、https://github.com/facebook/react/blob/v18.3.1/packages/react-dom/src/shared/sanitizeURL.js 、https://github.com/facebook/react/blob/main/CHANGELOG.md

### 4. 服务端渲染时把状态序列化进 script 标签
- 问题：用 `JSON.stringify` 把初始状态写进 `<script>`，数据里含 `</script><script>...` 时，会提前结束标签并执行后面的脚本。
- 怎么认出：服务端 `<script>window.__STATE__ = ${JSON.stringify(state)}</script>` 的写法，state 里有用户数据。
- 修法：不引入新依赖的写法：`JSON.stringify(state).replace(/</g, '\\u003c')`，把 `<` 转成转义序列；也可以用 `serialize-javascript` 库（新增依赖要先经团队同意）。
- 出处：https://redux.js.org/usage/server-rendering#security-considerations

### 5. Server Function 的参数当成可信输入
- 问题：Server Function（用 `'use server'` 标记的函数）可以被浏览器直接调用，参数完全由调用方控制，不会因为“只有我的页面调用它”就变得可信。
- 怎么认出：`'use server'` 函数里直接用参数拼 SQL、读文件、改数据，没有校验参数，也没有检查当前用户的权限。
- 修法：把它当成公开接口：校验参数类型和取值，检查调用者身份和权限。
- 出处：https://react.dev/reference/rsc/use-server#security

## useEffect
### 6. useEffect 依赖漏写
- 问题：Effect 里用到的 props、state、由它们算出的变量都属于依赖。漏写就会一直用第一次渲染时的旧值，界面和数据对不上。
- 怎么认出：`useEffect(() => { fetch(url + id) }, [])`，空依赖数组但里面用了外部变量；`// eslint-disable-next-line react-hooks/exhaustive-deps`。
- 修法：补全依赖；不想因某个值变化重新执行时，把它移出 Effect，或用 `useEffectEvent`（React 19.2 起）提取不需要响应的逻辑。
- 出处：https://react.dev/learn/lifecycle-of-reactive-effects#all-variables-declared-in-the-component-body-are-reactive 、https://react.dev/learn/separating-events-from-effects

### 7. useEffect 没有清理函数
- 问题：订阅、定时器、事件监听、连接在组件卸载或依赖变化后仍在运行，造成泄漏和重复触发。
- 怎么认出：`useEffect` 里有 `addEventListener`、`setInterval`、`setTimeout`、`new WebSocket`、`subscribe(`，没有 `return () => ...`。
- 修法：返回清理函数：`return () => { window.removeEventListener('resize', fn); clearInterval(id) }`。
- 出处：https://react.dev/learn/synchronizing-with-effects#step-3-add-cleanup-if-needed

### 8. useEffect 请求竞态：旧请求结果覆盖新的
- 问题：竞态指两个请求谁先返回不确定。用户快速切换时，先发的请求后返回，把过期数据写进界面。
- 怎么认出：`useEffect(() => { fetch(...).then(r => setData(r)) }, [query])`，没有取消请求，也没有“是否已过期”的标记。
- 修法：写 `let ignore = false`，`.then` 里先判断 `if (!ignore)`，清理函数里设为 `true`；或用 `AbortController`；更推荐框架或数据请求库自带的处理。
- 出处：https://react.dev/learn/you-might-not-need-an-effect#fetching-data

### 9. StrictMode 下 effect 执行两次暴露缺失的清理
- 问题：开发环境的 StrictMode 会故意把 Effect 多执行一轮（启动、清理、再启动）。没写清理时，会看到重复请求、重复订阅，有人误以为是 React 的 bug 而用 ref 屏蔽。
- 怎么认出：`const didRun = useRef(false); useEffect(() => { if (didRun.current) return; didRun.current = true; ... })`；去掉 StrictMode 来“解决”重复请求。
- 修法：给 Effect 补上对称的清理函数（连接对应断开、订阅对应取消订阅），确认多执行一轮后行为仍然正确。
- 出处：https://react.dev/reference/react/StrictMode#fixing-bugs-found-by-re-running-effects-in-development

### 10. 把对象或函数作为依赖，每次渲染都重新执行
- 问题：组件里新建的对象、数组、函数每次渲染都是新引用，Effect 把它们当依赖，每次渲染都会重跑，常见后果是请求死循环。
- 怎么认出：`const options = { roomId }; useEffect(() => connect(options), [options])`；Effect 里 `setState` 又触发重新渲染。
- 修法：把对象创建挪进 Effect 内部，依赖写原始值（`roomId`）；函数同理放进 Effect 内。
- 出处：https://react.dev/reference/react/useEffect#removing-unnecessary-object-dependencies

## 异步回调与 state
### 11. 异步回调里读到过期的 state
- 问题：每次渲染都有自己的 state 快照，函数会记住创建它时周围变量的值（这叫闭包）。所以异步回调、定时器、事件监听里读到的是创建它们那一刻的值，不是最新值。
- 怎么认出：`useEffect(() => { setInterval(() => console.log(count), 1000) }, [])`；`setTimeout(() => alert(count), 3000)`；`addEventListener` 的回调里读 state，但依赖数组为空。
- 修法：把用到的 state 加进依赖，并在清理函数里 `clearInterval`；只想读最新值、又不想让定时器重启时，用 `useEffectEvent`（React 19.2 起），低版本把最新值同步进 ref。
- 出处：https://react.dev/learn/state-as-a-snapshot 、https://react.dev/learn/separating-events-from-effects

### 12. 事件处理函数写成了调用而不是传递
- 问题：`onClick={handle()}` 在渲染时就调用了，不是点击时调用；如果里面调用了 `setState`，会引发 “Too many re-renders” 无限重新渲染。直接在组件函数体里无条件调用 `setState` 也是同一个问题。
- 怎么认出：`onClick={handleClick()}`、`onChange={setValue(x)}`；组件函数体顶层直接写 `setCount(1)`，不在事件处理函数或 `useEffect` 里。
- 修法：传函数本身 `onClick={handleClick}`，需要参数时写 `onClick={() => handleClick(id)}`。
- 出处：https://react.dev/learn/responding-to-events 、https://react.dev/reference/react/useState#im-getting-an-error-too-many-re-renders

## 列表与渲染
### 13. 用数组下标当 key
- 问题：列表会插入、删除、排序时，下标对应的内容会变，React 把旧项的 state（输入框内容、勾选状态）错配给新项。
- 怎么认出：`items.map((item, index) => <Row key={index} />)`；`key={i}`。
- 修法：用数据自带的稳定 id 作 key；没有 id 就在创建数据时生成一次并保存。
- 出处：https://react.dev/learn/rendering-lists#where-to-get-your-key

### 14. key 每次渲染都不同
- 问题：`key={Math.random()}` 让 key 每次都对不上，整个列表的 DOM 和组件状态每次渲染都被销毁重建，输入框失焦、动画重来。
- 怎么认出：`key={Math.random()}`、`key={uuid()}`、`key={Date.now()}` 写在 `.map` 渲染里。
- 修法：在创建数据时生成一次 id 并保存，渲染时用 `key={item.id}`。
- 出处：https://react.dev/learn/rendering-lists#where-to-get-your-key

### 15. `{count && <Comp />}` 在 count 为 0 时渲染出 0
- 问题：`&&` 左边是数字 0 时，整个表达式的值就是 0，React 会把 0 显示在页面上。
- 怎么认出：`{items.length && <List />}`、`{messageCount && <p>新消息</p>}`，左边是数字。
- 修法：左边变成布尔值：`{items.length > 0 && <List />}`，或用三元 `cond ? <A/> : null`。
- 出处：https://react.dev/learn/conditional-rendering#logical-and-operator-

### 16. 输入框在受控和非受控之间切换
- 问题：`value` 先是 `undefined` 后来变成字符串，React 会警告“从非受控变成受控”，输入行为不稳定。
- 怎么认出：`useState()` 没有初始值就传给 `<input value={text} />`；接口返回 `null` 的字段直接绑定到 `value`。
- 修法：初始值给空字符串 `useState('')`；接口的 `null` 用 `value={x ?? ''}` 转换。
- 出处：https://react.dev/reference/react-dom/components/input#im-getting-an-error-a-component-is-changing-an-uncontrolled-input-to-be-controlled

### 17. 服务端渲染和客户端首次渲染内容不同
- 问题：服务端输出的 HTML 和客户端水合（接管页面）时渲染的结果不一致，会出现水合错误或页面闪烁。
- 怎么认出：渲染中直接用 `typeof window !== 'undefined'` 分支、`Date.now()`、`Math.random()`、`localStorage.getItem()` 决定输出。
- 修法：首次渲染用两边一致的初始值，在 `useEffect` 里再读取浏览器独有的值并 `setState`。
- 出处：https://react.dev/reference/react-dom/client/hydrateRoot#handling-different-client-and-server-content

## 性能
### 18. 靠 useMemo 保证逻辑只执行一次
- 问题：`useMemo` 只是性能优化，不是语义保证，React 可能在某些情况下丢掉缓存重新计算。把必须只做一次的逻辑（注册、初始化、发请求）放进去，会在意想不到的时候重复执行。给简单计算包 `useMemo` 只是多余，不算问题。
- 怎么认出：`useMemo(() => { register(); return x }, [])`、`useMemo(() => { analytics.track(...) }, [])`，函数体里有副作用，或注释写着“只执行一次”。
- 修法：一次性的副作用放进 `useEffect`（并写清理函数）；只在首次渲染创建的值用 `useState(() => create())` 或 `useRef`；缓存只用来省计算，逻辑不依赖它。
- 出处：https://react.dev/reference/react/useMemo#caveats

### 19. Context 的 value 每次渲染都是新对象
- 问题：Provider 的 `value={{ user, login }}` 每次渲染都创建新对象，所有读取这个 Context 的组件在 Provider 渲染时都会重新渲染，`memo` 也挡不住。
- 怎么认出：`<AuthContext.Provider value={{ user, login }}>`；Provider 所在组件会频繁更新。
- 修法：用 `useMemo` 缓存 value，函数用 `useCallback`；或把频繁变化和很少变化的状态拆成两个 Context。
- 出处：https://react.dev/reference/react/useContext#optimizing-re-renders-when-passing-objects-and-functions

## 错误、DOM 操作与重复提交
### 20. 通过 ref 手动增删 React 管理的 DOM 节点
- 问题：React 会按自己的记录更新页面。用 `ref` 手动删除、插入由 React 渲染的节点，React 的记录和真实页面对不上，下次更新时可能报错或界面错乱。
- 怎么认出：`ref.current.remove()`、`ref.current.appendChild(...)`、`ref.current.parentNode.removeChild(...)`、`ref.current.innerHTML = ''`，且被增删的子节点本身也由 JSX 渲染。JSX 里始终为空的容器（如 `<div ref={box} />`）交给地图、图表这类第三方库挂载内容，不算问题。
- 修法：用 state 控制元素是否渲染；ref 只用来做聚焦、滚动、测量这类不改结构的操作。
- 出处：https://react.dev/learn/manipulating-the-dom-with-refs#best-practices-for-dom-manipulation-with-refs

### 21. 事件处理函数和异步代码里的错误不会被错误边界捕获
- 问题：错误边界只管渲染期间的错误。`onClick`、`setTimeout`、`fetch().then` 里抛出的错误它接不住，界面没有任何提示。
- 怎么认出：`onClick={async () => { await save() }}` 没有 `try/catch`；或 `catch (e) { console.error(e) }` 里只打印日志，界面上没有任何提示。
- 修法：处理函数里用 `try/catch` 接住错误，用 `setError(...)` 把错误信息显示给用户。
- 出处：https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary

### 22. 表单提交按钮没有防重复
- 问题：用户连点提交或网络慢时再点，会发出多次请求，重复下单、重复创建。
- 怎么认出：`<form onSubmit={handleSubmit}>` 或 `<button onClick={submit}>`，提交按钮没有 `disabled` 绑定任何 pending 或 submitting 状态。
- 修法：React 19 起用 `useActionState` 返回的 `isPending`，或子组件里的 `useFormStatus().pending`，给按钮加 `disabled`；React 18 自己写 `const [isSubmitting, setSubmitting] = useState(false)`，提交前置 `true`，`finally` 里置回 `false`。后端接口同时做幂等（同一个请求重复提交，结果和只提交一次相同）。
- 出处：https://react.dev/reference/react-dom/hooks/useFormStatus 、https://react.dev/reference/react/useActionState

### 23. setState 之后立刻读 state，拿到的还是旧值
- 问题：调用 `setCount(count + 1)` 不会改变当前这次渲染里的 `count`，紧接着读到的还是旧值，用它发请求或判断会出错。
- 怎么认出：`setCount(count + 1); console.log(count);`、`setForm(next); submit(form)`、`setItems([...items, x]); save(items)`。
- 修法：先算出新值存进局部变量 `const next = count + 1`，用 `next` 做后续操作；需要在渲染后做事就放进 `useEffect`。
- 出处：https://react.dev/reference/react/useState#ive-updated-the-state-but-logging-gives-me-the-old-value

### 24. fetch 不检查 response.ok，404/500 也当成功解析
- 问题：`fetch` 只在网络层失败时才 reject，服务器返回 404、500 照样走 `.then`，随后 `r.json()` 可能解析出错误页，或把错误对象当正常数据写进 state。
- 怎么认出：`fetch(url).then(r => r.json()).then(setData)`，中间没有 `if (!r.ok)`。
- 修法：先判断 `if (!r.ok) throw new Error(r.status)`，再解析；错误分支更新到界面上。
- 出处：https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_fetch#checking_response_status
