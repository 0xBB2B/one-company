import { createJiti } from "jiti";

// 框架 TS 由包自身的加载器处理；SDK 与已发布 JS 依赖使用 Node 原生模块实例。
// 禁用磁盘缓存，避免在业务目录或共享临时目录留下转换后的源码。
export const daemonLoader = createJiti(import.meta.url, {
  fsCache: false,
  moduleCache: true,
  interopDefault: false,
  tryNative: false,
  debug: false,
  alias: {},
  tsconfigPaths: false,
  transformModules: [],
  nativeModules: [
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
    "typebox",
    "web-tree-sitter",
  ],
});
