## 前端设计约定

本项目前端的关键设计决定。PM 规划任务、worker 写代码、审查核对时都按这里执行；和内置 skill 的写法冲突时，以这里为准。

### 技术栈
- 用 Vue 3（Composition API，`<script setup lang="ts">`）、TypeScript（开启 strict）、Vite、Tailwind CSS，状态管理用 Pinia。
- 不用 Vue 2、纯 JavaScript、直接配置 webpack 或 rollup、styled-components 这类 CSS-in-JS、Vuex。要偏离必须先经用户同意。
- 包管理器：新项目用 bun；已有项目沿用仓库里现有 lockfile 对应的工具，不混用，也不擅自迁移。

### 请求与错误
- 组件里不直接调用 `fetch` 或 HTTP 库。所有请求都经过统一的 client，组件只调用领域方法，例如 `api.orders.get(id)`。
- 统一 client 负责几件事：base URL、加鉴权头、解析错误码、刷新 token、超时。
- 后端错误码格式是 `A-BBB-CCCC`。在请求层统一解析成领域错误，再集中映射成提示文案。
  - 组件里不写 `if (code === ...)` 这样的判断。
  - 认不出的错误码用兜底文案，不把后端的原始 message 直接给用户看。
- 请求和响应都写明确的 TS 类型，类型优先从后端契约（如 OpenAPI）生成；不用 `any`，也不用 `as any`。

### 登录与权限
- access token 放在运行时内存里；refresh token 存在 localStorage。
  - 这是本项目的决定，内置 skill 里"token 存 localStorage 会被 XSS 读走"那一条在本项目不算问题。
- 收到 401 时，用 refresh token 换一对新 token，再重放原请求。
  - 多个请求同时 401 时只刷新一次。
  - 刷新失败就清掉本地凭证，跳到登录页。
- 路由守卫只决定界面上显示什么，不算安全边界；同样的数据和操作，后端必须再校验一次权限。

### 状态、表单与环境变量
- Pinia store 只放跨组件共享的客户端状态和会话状态，比如当前用户、主题。不把组件的局部状态提升到全局，也不把接口返回的数据长期挂在 store 里当缓存。
- 表单前端校验只用来即时提示，后端校验才算数；两边的规则要保持一致。
- 前端环境变量（`VITE_*`）会被打包进代码、浏览器里看得见，只能放公开配置，不放任何密钥。
