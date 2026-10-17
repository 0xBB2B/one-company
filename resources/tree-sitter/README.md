# 本机语法解析资源

`src/modules/project-index/syntax-parser.ts` 提供内部函数 `withSyntaxTree(language, source, inspect)`。只接受 `ts`、`tsx`、`js`、`jsx`、`go` 和调用方提供的源码字符串；不扫描项目、不索引 PRD、不写数据库，也不注册业务工具。

## 分发与来源

- `web-tree-sitter@0.27.0` 是固定版本运行时依赖；它的 npm 包包含 JS 绑定与 `web-tree-sitter.wasm`。
- 本目录的四份语法 WASM 直接取自官方 npm 发行包：`tree-sitter-typescript@0.23.2`（TS/TSX）、`tree-sitter-javascript@0.25.0`（JS/JSX）、`tree-sitter-go@0.25.0`。
- `manifest.json` 记录精确版本、发行包地址及 SHA-512 完整性值、WASM SHA-256、语法 ABI（解析器接口版本）与许可证路径。四个上游包均使用 MIT 许可证，原始声明保留在对应 `.LICENSE` 文件。
- 语法 npm 包不作为产品运行时依赖；使用随产品分发的预构建文件，不执行它们的原生安装脚本，不需要 CodeGraph、语法 CLI 或本机编译器。
- 安装可下载正常依赖；安装完成后的解析只读本机资源，不自动下载、修复或重新编译资源。`pnpm run test:installation` 验证真实产品 tarball 的离线安装和解析。

资源升级须同时核对官方发行包、版本、许可证、指纹、ABI 与真实安装测试。不能只修改 manifest 中的 hash 来接受未知字节。安装文件及清单属于可信产品资源；指纹用于检查损坏和版本配套，不是防止同用户恶意篡改整个安装包的签名机制。

## 使用和释放

```typescript
import { withSyntaxTree } from "../../src/modules/project-index/syntax-parser.ts";

const summary = await withSyntaxTree("ts", "export const count = 1;", (tree) => ({
  rootType: tree.rootNode.type,
  hasSyntaxError: tree.rootNode.hasError,
}));
```

`inspect` 可以返回 Promise。函数等待它完成后，在正常返回或抛错时释放本次 Tree 和 Parser。回调必须提取普通数据，不能向外保留 Tree、Node 或 Cursor；自行创建的 cursor/query/copy 仍由调用方按 Tree-sitter API 释放。语法错误由树的 `hasError` 表达，不等于安装失败。

坐标使用 JavaScript 字符串的 UTF-16 索引，不是 UTF-8 字节偏移；中文、emoji 与 CRLF 的切片行为由测试素材验证。这里只提供语法树，不承诺语义理解、调用图或完整符号引用关系。

官方绑定不提供 Language 卸载接口。本模块实例缓存运行时和最多四种语法，不缓存源码或解析树；每次调用仍读取并核对本机资源指纹，已有缓存不能掩盖安装文件损坏。WASM 初始化或语法加载失败会保留失败状态，核对并修复安装后应在新进程中重试，不在同一损坏实例内自动重初始化。

## 失败类别

- `unsupported_language`：不在固定语言白名单中。
- `resource_missing`：运行时依赖、WASM 或清单缺失。
- `resource_invalid`：资源不可读、清单格式错误或字节指纹不匹配。
- `resource_incompatible`：运行时版本、语法 ABI 或加载结果不兼容。

失败不会降级为静默空结果、联网加载或现场编译。解析跨平台能力不代表命令沙箱跨平台；现有无安全后端时拒绝命令的策略保持不变。安装测试的 OS 禁网后端目前只覆盖 macOS，其他平台明确跳过该项，不能报告成通过。
