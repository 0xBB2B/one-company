---
name: react-coding
description: React 编码规范：按 Rules of React 写组件和 Hooks，保持纯、列表 key 稳定、能算出来的值不存 state、useEffect 只做外部同步，写 React 代码时遵守、审查时逐项对照。
---
# React 编码规范

## Hooks 规则
### 1. Hooks 只在顶层调用
- 问题：React 靠每次渲染里 Hook 的调用顺序来对应状态。把 Hook 放进条件、循环、嵌套函数或 try/catch，顺序一变，状态就串位或直接报错。
- 怎么认出：`if (...) { useState(...) }`、`for` 或 `.map` 回调里调用 Hook、提前 `return` 之后才调用 Hook、事件处理函数里调用 `useContext`。
- 修法：Hook 全部放在组件函数最顶层、任何提前 `return` 之前；条件放进 Hook 的参数或 Hook 之后的逻辑里。
- 出处：https://react.dev/reference/rules/rules-of-hooks#only-call-hooks-at-the-top-level

### 2. Hooks 只在组件和自定义 Hook 里调用
- 问题：在普通函数、类组件或事件回调里调用 Hook，React 找不到当前组件，会报错或行为错乱。
- 怎么认出：名字不以 `use` 开头、也不是组件的函数里出现 `useState`、`useEffect`；类组件里调用 Hook。
- 修法：把逻辑搬到组件里，或把这个函数改名为 `useXxx` 并只在组件和其他自定义 Hook 里调用。
- 出处：https://react.dev/reference/rules/rules-of-hooks#only-call-hooks-from-react-functions

### 3. 组件和 Hooks 保持纯
- 问题：渲染可能被重复执行（开发模式的 StrictMode 会故意渲染两次）。渲染过程里改外部变量、读写随机数和当前时间，会让同样的输入出现不同的结果。
- 怎么认出：组件函数体里直接 `counter++`（改外部变量）、`Math.random()`、`Date.now()`、`document.title = ...`、改 props 对象。
- 修法：渲染只根据 props、state、context 计算并返回 JSX；有副作用的操作放进事件处理函数或 `useEffect`；函数内部新建再修改的局部对象不算问题。
- 出处：https://react.dev/reference/rules/components-and-hooks-must-be-pure

### 4. 不直接修改 state 和 props
- 问题：直接改对象或数组（`push`、`obj.x = 1`），React 看到的还是同一个引用，不会重新渲染，或者渲染结果和 state 不一致。
- 怎么认出：`setItems(items)` 之前先 `items.push(x)`；`user.name = 'a'; setUser(user)`；对 `props.xxx` 赋值。
- 修法：每次都生成新值：`setItems([...items, x])`、`setUser({ ...user, name: 'a' })`；嵌套较深的结构用 Immer。
- 出处：https://react.dev/learn/updating-objects-in-state#treat-state-as-read-only

### 5. 组件和自定义 Hook 按规定命名
- 问题：组件名小写开头，JSX 会把它当成 HTML 标签；Hook 不以 `use` 开头，代码检查工具就无法检查它的调用规则。
- 怎么认出：`function profile() { return <div/> }` 却被 `<profile />` 使用；包含 Hook 调用的函数叫 `getUser`、`fetchData`。
- 修法：组件用大写开头 `Profile`；用到 Hook 的共用函数命名成 `useUser`。
- 出处：https://react.dev/learn/your-first-component#defining-a-component 、https://react.dev/learn/reusing-logic-with-custom-hooks#hook-names-always-start-with-use

### 6. 不要在组件内部定义另一个组件
- 问题：外层每次渲染都会创建一个新的组件函数，React 认为是另一个组件，会销毁再重建整棵子树，子树的 state 和输入框焦点全部丢失，还很慢。
- 怎么认出：一个组件函数体里出现 `function Row() { return ... }` 或 `const Row = () => ...`，随后 `<Row />` 被渲染。
- 修法：把内部组件移到文件顶层，需要的数据通过 props 传入。
- 出处：https://react.dev/learn/your-first-component#nesting-and-organizing-components

### 7. 不要自己制造自定义生命周期 Hook
- 问题：`useMount`、`useEffectOnce` 这类包装把 `useEffect` 变成“挂载时执行”的写法，会隐藏依赖，Lint 无法发现漏写的依赖。
- 怎么认出：自定义的 `useMount(fn)`、`useUpdateEffect(fn)`、`useEffectOnce(fn)`，内部直接 `useEffect(fn, [])`。
- 修法：自定义 Hook 围绕具体用途命名（如 `useChatRoom(roomId)`），内部写完整的 `useEffect` 和依赖。
- 出处：https://react.dev/learn/reusing-logic-with-custom-hooks#keep-your-custom-hooks-focused-on-concrete-high-level-use-cases

## State
### 8. 能算出来的值不存 state
- 问题：由 props 或其他 state 算得出的值，再存一份 state，就要手动保持两份同步，漏一处就出现矛盾的界面。
- 怎么认出：`const [fullName, setFullName] = useState(...)`，而 `fullName` 完全由 `firstName`、`lastName` 算出，事件处理函数里要同时 set 几个值；`filtered` 列表存在 state 里。
- 修法：渲染时直接算：`const fullName = firstName + ' ' + lastName`；计算很慢才考虑 `useMemo`。
- 出处：https://react.dev/learn/choosing-the-state-structure#avoid-redundant-state

### 9. 不要把 props 复制进 state
- 问题：`useState(props.color)` 只在第一次渲染读取 props。之后父组件传来新值，这里不会更新，界面停留在旧值。
- 怎么认出：`const [color, setColor] = useState(messageColor)`，但代码里 `setColor` 从未被调用，或根本没有编辑入口。
- 修法：直接使用 props；确实要“初始值 + 本地修改”时，把 prop 命名成 `initialColor` 表明只用一次。
- 出处：https://react.dev/learn/choosing-the-state-structure#don-t-mirror-props-in-state

### 10. state 里存 id，不存对象副本
- 问题：同一份数据同时放在两个 state 里（列表里一份，选中项又一份），编辑列表里的数据后，选中项仍是旧内容。
- 怎么认出：`const [selectedItem, setSelectedItem] = useState(items[0])`，`items` 本身也是 state。
- 修法：存 `selectedId`，渲染时 `const selectedItem = items.find(i => i.id === selectedId)`。
- 出处：https://react.dev/learn/choosing-the-state-structure#avoid-duplication-in-state

### 11. 基于旧值更新 state 时用更新函数
- 问题：同一个事件里连续 `setCount(count + 1)` 三次，三次读到的都是这一轮渲染的 `count`，最终只加 1。
- 怎么认出：同一个函数里多次 `setX(x + 1)`，或者 `await` 之后用 `x` 计算新值再 `setX`。
- 修法：写成 `setCount(c => c + 1)`，React 会依次把上一次的结果传给下一个更新函数。
- 出处：https://react.dev/learn/queueing-a-series-of-state-updates

### 12. 更新逻辑复杂时用 useReducer
- 问题：很多事件处理函数各自改同一组 state，逻辑分散在多处，要排查某个状态怎么变成这样很困难。
- 怎么认出：多个事件处理函数里总是成组调用同样的几个 setter（如 `setLoading(false); setError(null); setData(x)` 反复出现），而且各处写法略有不同。
- 修法：把 state 合成一个对象，用 `useReducer(reducer, initial)`，所有变化通过 `dispatch({ type: ... })` 进入同一个 reducer 函数。
- 出处：https://react.dev/learn/extracting-state-logic-into-a-reducer

### 13. useState 的联合类型显式写泛型
- 问题：`useState('idle')` 会被推断成 `string`，之后写成 `'idel'` 之类的拼写错误编译器也不会报。
- 怎么认出：`useState('idle')`、`useState(null)` 但后面会赋其他字符串或对象。
- 修法：`useState<'idle' | 'loading' | 'error'>('idle')`、`useState<User | null>(null)`。
- 出处：https://react.dev/learn/typescript#example-hooks

## 列表与渲染
### 14. 列表 key 稳定且唯一
- 问题：key 是 React 识别每一项的依据。key 重复或缺失，会导致项被错误复用，输入框内容和动画状态错位。
- 怎么认出：`.map` 返回的元素没有 `key`；同一列表里 key 有重复（如用名字、类型做 key）。
- 修法：key 要稳定且唯一，用数据自带的 id：`key={item.id}`；没有 id 就在创建数据时生成一次并保存。
- 出处：https://react.dev/learn/rendering-lists#rules-of-keys

### 15. 一个列表项渲染多个节点时用 Fragment 带 key
- 问题：简写 `<>...</>` 不能带 `key`，在 `.map` 里使用会触发缺少 key 的警告，列表重排时项会错位。
- 怎么认出：`.map(p => (<> <h1/> <p/> </>))`。
- 修法：`import { Fragment } from 'react'`，写成 `<Fragment key={p.id}>...</Fragment>`。
- 出处：https://react.dev/learn/rendering-lists#displaying-several-dom-nodes-for-each-list-item

### 16. 受控输入用 value 加 onChange
- 问题：受控输入指输入框的值由 state 决定。只写 `value` 不写 `onChange`，React 会在控制台报错，并把这个输入框渲染成只读，用户打不了字。
- 怎么认出：`<input value={text} />` 没有 `onChange`，也没有 `readOnly`。
- 修法：`<input value={text} onChange={e => setText(e.target.value)} />`；不需要实时同步就用 `defaultValue` 加 `ref` 或表单提交时读取。
- 出处：https://react.dev/reference/react-dom/components/input#controlling-an-input-with-a-state-variable

### 17. 不在渲染时读写 ref.current
- 问题：ref 的变化不触发重新渲染，在渲染中读取它，会得到不稳定的结果，违反“渲染要纯”。
- 怎么认出：组件函数体里直接 `ref.current = x`，或用 `ref.current` 的值决定渲染内容；允许的例外是初始化，如 `if (ref.current === null) { ref.current = new Foo() }`。
- 修法：渲染用 state；ref 只在事件处理函数和 `useEffect` 中读写，用来放计时器 id、DOM 节点等不影响画面的值。
- 出处：https://react.dev/learn/referencing-values-with-refs#best-practices-for-refs 、https://react.dev/reference/react/useRef#avoiding-recreating-the-ref-contents

### 18. 表单控件的 id 用 useId 生成
- 问题：手写固定 id（`id="email"`），同一个组件渲染多次时 id 重复，label 点击会指向错误的输入框；用全局递增计数器生成，在服务端渲染时，客户端组件的挂载顺序可能和服务端输出顺序不同，id 两边对不上。
- 怎么认出：可复用组件里 `<label htmlFor="name">` 配 `<input id="name">`，id 是写死的字符串；或模块级 `let nextId = 0` 递增生成 id。
- 修法：`const id = useId()`，`<input id={id} />`，`<label htmlFor={id}>`。
- 出处：https://react.dev/reference/react/useId

## Effect
### 19. useEffect 只用来和外部系统同步
- 问题：useEffect 是为了让组件与 React 之外的东西（网络连接、浏览器 API、第三方库）保持同步。拿它来转换数据，会多一次无用的渲染，逻辑也绕。
- 怎么认出：`useEffect(() => { setX(f(props.y)) }, [props.y])` 里只有 `setState`，没有外部 API。
- 修法：渲染时直接计算；用户操作引起的变化放进事件处理函数；只有与外部系统同步才写 `useEffect`。
- 出处：https://react.dev/learn/you-might-not-need-an-effect

### 20. 用户操作引起的逻辑放事件处理函数，不放 useEffect
- 问题：把“点击购买后弹通知”放进监听状态的 `useEffect`，页面刷新、状态从别处变化时也会触发，通知被重复弹出。
- 怎么认出：`useEffect(() => { if (cart.includes(product)) showNotification() }, [cart])`、`useEffect` 里调用 `post('/api/buy')`，由用户点击触发。
- 修法：把 `showNotification()` 和请求写进 `handleBuyClick`，由点击直接调用。
- 出处：https://react.dev/learn/you-might-not-need-an-effect#sharing-logic-between-event-handlers

### 21. props 变化时要重置整个子组件的 state，用 key
- 问题：切换用户后，评论输入框里还留着上一个用户的草稿。靠 `useEffect` 在 id 变化时清空，会先渲染一次错误内容。
- 怎么认出：`useEffect(() => { setComment('') }, [userId])`。
- 修法：渲染时传 `<Profile userId={id} key={id} />`，key 变了 React 会重建组件并重置所有 state。
- 出处：https://react.dev/learn/preserving-and-resetting-state#option-2-resetting-state-with-a-key

### 22. 订阅外部数据源用 useSyncExternalStore
- 问题：自己用 `useEffect` 加 `useState` 订阅浏览器 API 或外部 store，容易漏掉初始值同步和服务端渲染兼容。
- 怎么认出：`useEffect` 里 `addEventListener('online', () => setOnline(...))` 再配 `useState(navigator.onLine)`。
- 修法：`const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true)`。
- 出处：https://react.dev/learn/you-might-not-need-an-effect#subscribing-to-an-external-store

### 23. 不要用一串 useEffect 互相触发来更新 state
- 问题：一个 Effect 改 state，触发下一个 Effect 再改 state，一次操作引起多次重新渲染，每一步都慢一拍，也很难理清顺序。
- 怎么认出：多个 `useEffect` 依赖彼此设置的 state，如 `useEffect(() => { if (card.gold) setCount(c => c + 1) }, [card])`、`useEffect(() => { if (count > 3) setRound(r => r + 1) }, [count])`。
- 修法：在事件处理函数里一次算出所有新值，再依次调用 setter。
- 出处：https://react.dev/learn/you-might-not-need-an-effect#chains-of-computations

### 24. 通知父组件状态变化，在事件处理函数里调用，不放 Effect
- 问题：在 `useEffect` 里调用父组件传来的 `onChange(value)`，要等本组件渲染完才通知，父组件多渲染一轮，两边状态有一瞬间不一致。
- 怎么认出：`useEffect(() => { onChange(isOn) }, [isOn, onChange])`。
- 修法：在引起变化的事件处理函数里同时 `setIsOn(next)` 和 `onChange(next)`；或把状态提到父组件，做成完全受控。
- 出处：https://react.dev/learn/you-might-not-need-an-effect#notifying-parent-components-about-state-changes

### 25. 初始值需要昂贵计算时传初始化函数
- 问题：`useState(createInitialTodos())` 里的函数每次渲染都会被调用，虽然结果只在第一次用，白白浪费计算。
- 怎么认出：`useState(expensive())`、`useState(JSON.parse(localStorage.getItem(...)))`，调用写在括号里。
- 修法：传函数本身而不是调用结果：`useState(createInitialTodos)` 或 `useState(() => load())`。
- 出处：https://react.dev/reference/react/useState#avoiding-recreating-the-initial-state
