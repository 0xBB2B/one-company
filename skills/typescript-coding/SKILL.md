---
name: typescript-coding
description: TypeScript 编码规范：strict、避免 any、少用类型断言、联合类型穷尽检查、不可变，写 TS 代码时遵守、审查时逐项对照。
---
# TypeScript 编码规范

## 类型安全
### 1. 开启 strict
- 问题：没开 strict 时，null、undefined、隐式 any 都不检查，编译器能挡住的错误全部漏到运行时。
- 怎么认出：tsconfig.json 里没有 `"strict": true`，或被单独关掉某项（`strictNullChecks: false`、`noImplicitAny: false`）。
- 修法：`compilerOptions` 里设 `"strict": true`；老代码报错就逐个修，不要关开关。
- 出处：https://www.typescriptlang.org/tsconfig/#strict

### 2. 不用 any，外部数据用 unknown 再收窄
- 问题：`any` 会关掉这个值的所有检查，还会传染给用到它的变量，类型保护形同虚设。
- 怎么认出：`: any`、`as any`、`Array<any>`、`JSON.parse` 的结果直接当具体类型用。
- 修法：不确定类型时写 `unknown`，用 `typeof`、`in`、自定义类型守卫收窄后再用。
- 出处：https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-0.html#new-unknown-top-type

### 3. 不用 `as` 断言外部输入
- 问题：`as` 只是告诉编译器“相信我”，不做任何运行时检查。外部输入实际形状不对时，错误在远离入口的地方才爆出来。
- 怎么认出：`req.body as User`、`JSON.parse(s) as Config`、`as unknown as T`。
- 修法：用运行时校验得到类型（类型守卫或校验库的 parse），校验通过后再使用。
- 出处：https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions

## 联合类型与不可变
### 4. 联合类型用 never 做穷尽检查
- 问题：给联合类型新增一个成员后，`switch` 里没处理的分支不会报错，运行时静默走错路径。
- 怎么认出：对联合类型或枚举做 `switch`，`default` 分支缺失，或 `default` 里只是返回默认值。
- 修法：`default` 分支里把值赋给 `never` 类型变量：`const _exhaustive: never = x;`，漏掉的成员会在编译期报错。
- 出处：https://www.typescriptlang.org/docs/handbook/2/narrowing.html#exhaustiveness-checking

### 5. 能 readonly / const 就不可变
- 问题：对象和数组被随意修改，调用方不知道自己传进去的数据被改了，排查困难。
- 怎么认出：用 `let` 但从未重新赋值；接口字段、函数参数里的数组没有 `readonly`；函数里直接 `push` 参数数组。
- 修法：默认用 `const`；字段写 `readonly`，数组参数写 `readonly T[]`（或 `ReadonlyArray<T>`）；要改就复制出新值。
- 出处：https://www.typescriptlang.org/docs/handbook/2/objects.html#readonly-properties

## tsconfig 严格选项
### 6. 数组和索引取值用 noUncheckedIndexedAccess
- 问题：`arr[i]` 和 `record[key]` 默认被当成一定有值，实际越界时拿到 undefined，运行时才报错。
- 怎么认出：tsconfig 没开 `noUncheckedIndexedAccess`；代码里 `list[0].name` 之类直接取下标。
- 修法：开启该选项，取值后先判断 undefined，或用 `at()`、解构加默认值。
- 出处：https://www.typescriptlang.org/tsconfig/#noUncheckedIndexedAccess

### 7. catch 里的错误当 unknown 处理
- 问题：`catch (e)` 里的 e 可能是任何东西，直接 `e.message` 在抛出字符串时会得到 undefined 或再次抛错。
- 怎么认出：`catch (e: any)`；`e.message` 之前没有 `instanceof Error` 判断。
- 修法：strict 下 `useUnknownInCatchVariables` 默认开启，先 `if (e instanceof Error)` 再用。
- 出处：https://www.typescriptlang.org/tsconfig/#useUnknownInCatchVariables

### 8. 类属性要在构造时初始化
- 问题：声明了属性但没赋初值，类型却说它一定有值，使用时是 undefined。
- 怎么认出：关闭了 `strictPropertyInitialization`；属性后面加了 `!` 来消除报错。
- 修法：在构造函数里赋值或给初始值；确实延迟赋值的把类型写成 `T | undefined`。
- 出处：https://www.typescriptlang.org/tsconfig/#strictPropertyInitialization

### 9. 每个分支都返回值，switch 不穿透
- 问题：函数有的路径没返回值，调用方拿到 undefined；switch 漏写 break 会执行下一个分支。
- 怎么认出：没开 `noImplicitReturns` / `noFallthroughCasesInSwitch`；case 末尾既无 break 也无 return。
- 修法：两个选项都打开，补全每条路径。
- 出处：https://www.typescriptlang.org/tsconfig/#noImplicitReturns

### 10. 子类重写方法加 override
- 问题：父类方法改名后，子类里原来的“重写”变成一个无关的新方法，父类逻辑不再被覆盖，编译器不报错。
- 怎么认出：子类方法与父类同名但没有 `override`，tsconfig 没开 `noImplicitOverride`。
- 修法：开启 `noImplicitOverride`，重写时写 `override`。
- 出处：https://www.typescriptlang.org/tsconfig/#noImplicitOverride

### 11. 可选属性区分“缺失”和“undefined”
- 问题：`a?: string` 默认也允许显式写 `a: undefined`，序列化后行为不同，容易混淆。
- 怎么认出：接口里大量 `?:` 字段，代码里既判断 `in` 又判断 `=== undefined`。
- 修法：需要严格区分时开启 `exactOptionalPropertyTypes`；否则统一用 `=== undefined` 判断。
- 出处：https://www.typescriptlang.org/tsconfig/#exactOptionalPropertyTypes

### 12. 类型导入用 import type
- 问题：只用于类型的导入在编译后若被保留，会引起不必要的模块加载或循环依赖。
- 怎么认出：`import { User } from "./user"`，而 User 只是接口或类型别名。
- 修法：写成 `import type { User } from "./user"`，并开启 `verbatimModuleSyntax`。
- 出处：https://www.typescriptlang.org/tsconfig/#verbatimModuleSyntax

## 类型使用
### 13. 非空断言 ! 只在确定时使用
- 问题：`x!` 只是让编译器闭嘴，不做任何检查，x 实际为空时运行时就崩。
- 怎么认出：`map.get(key)!.value`、`document.getElementById("a")!`。
- 修法：用 `if (!x) throw ...` 或可选链 `x?.value` 处理空值。
- 出处：https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#non-null-assertion-operator-postfix-

### 14. 用 @ts-expect-error 代替 @ts-ignore
- 问题：`@ts-ignore` 在问题被修好后依然留着，会一直压制后面可能出现的新错误。
- 怎么认出：`// @ts-ignore`。
- 修法：必须压制时用 `// @ts-expect-error 原因`，问题消失后编译器会提醒删除。
- 出处：https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-9.html#-ts-expect-error-comments

### 15. 不用 Object、Function、{} 这些宽泛类型
- 问题：`Object` 和 `{}` 几乎接受任何值，`Function` 不检查参数和返回值，类型保护形同虚设。
- 怎么认出：参数或字段类型写成 `Object`、`Function`、`{}`、`String`、`Number`。
- 修法：用具体类型：`object`、`Record<string, unknown>`、`(x: number) => void`、`string`。
- 出处：https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html#general-types 、https://typescript-eslint.io/rules/no-unsafe-function-type/ 、https://typescript-eslint.io/rules/no-empty-object-type/

### 16. 回调的参数不要标成可选
- 问题：回调参数写成可选，调用方必须处理 undefined，实际上你总会传入它。
- 怎么认出：`callback: (data: string, elapsed?: number) => void`。
- 修法：回调参数按实际都传入的写成必填；回调可以少声明参数。
- 出处：https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html#callback-types

### 17. 联合类型加判别字段，用类型守卫收窄
- 问题：靠 `as` 或多重 if 区分不同形状的对象，容易漏掉情况。
- 怎么认出：`(x as A).foo`；用多个可选字段区分形状。
- 修法：给每种形状一个字面量判别字段（如 `kind: "a"`），用 `switch (x.kind)` 收窄；复杂判断写 `x is A` 类型守卫函数。
- 出处：https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions

### 18. 自定义类型守卫要写对判断逻辑
- 问题：`x is User` 的函数返回值由你保证，写错了编译器照信，等于一种隐蔽的 `as`。
- 怎么认出：`function isUser(x): x is User { return true }`，或只检查一两个字段就声称整个类型。
- 修法：逐个检查必需字段的类型；复杂结构交给校验库。
- 出处：https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates

### 19. 用 satisfies 检查形状而不丢字面量类型
- 问题：给配置对象加类型标注会把字面量类型放宽成 string，后续无法精确使用；用 `as` 又不做检查。
- 怎么认出：`const cfg: Config = {...}` 之后需要 `as const`，或 `const cfg = {...} as Config`。
- 修法：`const cfg = { ... } satisfies Config`。
- 出处：https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator

### 20. 优先用字面量联合代替 enum
- 问题：普通 enum 会生成运行时代码，增加打包体积，也让只想要几个固定值的场景变重；同样效果的联合类型只存在于编译期。
- 怎么认出：`enum Status { A, B }`，且不需要反向映射。
- 修法：`type Status = "a" | "b"`，或 `as const` 对象加 `typeof obj[keyof typeof obj]`。
- 出处：https://www.typescriptlang.org/docs/handbook/enums.html#objects-vs-enums

## 异步与比较
### 21. Promise 不能放着不管
- 问题：调用异步函数既不 await 也不 catch，出错时没人知道，在 Node 中还会让进程退出。
- 怎么认出：语句里直接 `save(user);`，save 返回 Promise。
- 修法：`await` 它，或 `.catch(...)`；用 `@typescript-eslint/no-floating-promises` 检查。
- 出处：https://typescript-eslint.io/rules/no-floating-promises/

### 22. 比较用 ===
- 问题：`==` 会做隐式类型转换，`0 == ""`、`null == undefined` 的结果常常出乎意料。
- 怎么认出：代码里出现 `==` 或 `!=`。
- 修法：一律用 `===` 和 `!==`；要同时判断 null 与 undefined 时才写 `x == null`，并让规则明确允许。
- 出处：https://eslint.org/docs/latest/rules/eqeqeq

### 23. 默认值用 ??，不用 ||
- 问题：`||` 会把 `0`、`""`、`false` 也当成“没有值”，用户明确填的 0 被默认值覆盖。
- 怎么认出：`const port = config.port || 3000`，其中 `port` 可能是 0；`name || "匿名"` 而空字符串是合法值。
- 修法：用空值合并运算符 `config.port ?? 3000`，只在 `null` 或 `undefined` 时取默认值。
- 出处：https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#nullish-coalescing

### 24. 开启 noUnusedLocals，清掉没用的变量和导入
- 问题：没用到的变量和导入留在代码里，读者会误以为有作用，改动时也容易漏掉。
- 怎么认出：tsconfig 没开 `noUnusedLocals` / `noUnusedParameters`；diff 里新增的变量或 import 没被使用。
- 修法：开启这两个选项；确实要保留的参数名加下划线前缀。
- 出处：https://www.typescriptlang.org/tsconfig/#noUnusedLocals

### 25. 严格选项只在新建或修改 tsconfig 时写，没有 tsconfig 不自行加参数检查
- 问题：strict、noUncheckedIndexedAccess 这类选项是 tsconfig 的 `compilerOptions`，不是随手加的命令行参数。项目没有 tsconfig 时，自己给 `tsc` 加严格参数去检查（包括测试文件），会报出项目从没要求过的大量错误，把无关的老代码问题算到本次改动头上。
- 怎么认出：项目里找不到 tsconfig.json，却在检查命令里自行加了 `--strict` 之类的参数；或为了让检查通过去改与本次需求无关的代码。
- 修法：新建或修改 tsconfig 时按上面各项写严格选项；没有 tsconfig 时不自行加严格参数，按项目已有的检查方式（脚本、CI、编辑器）来，项目 AGENTS.md 里另有规定的以它为准。
- 出处：https://www.typescriptlang.org/docs/handbook/tsconfig-json.html
