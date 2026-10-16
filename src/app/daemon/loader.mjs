import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// 框架 TS 由包自身的加载器处理；SDK 与已发布 JS 依赖使用 Node 原生模块实例。
// 禁用磁盘缓存，避免在业务目录或共享临时目录留下转换后的源码。
const loaderOptions = {
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
};

export const daemonLoader = createJiti(import.meta.url, loaderOptions);

// 宿主包必须解析到 pi 自己安装的那一份，否则守护进程会和 SDK 各持一份副本。
export function createHostLoader(sdkDir) {
  const fromSdk = createJiti(pathToFileURL(join(sdkDir, "package.json")).href);
  const resolveFromSdk = (name) =>
    fileURLToPath(fromSdk.esmResolve(name, { conditions: ["node", "import"] }));
  return createJiti(import.meta.url, {
    ...loaderOptions,
    alias: {
      "@earendil-works/pi-coding-agent": join(sdkDir, "dist/index.js"),
      "@earendil-works/pi-ai": resolveFromSdk("@earendil-works/pi-ai/compat"),
      "@earendil-works/pi-tui": resolveFromSdk("@earendil-works/pi-tui"),
      typebox: resolveFromSdk("typebox"),
      "typebox/value": resolveFromSdk("typebox/value"),
      "typebox/compile": resolveFromSdk("typebox/compile"),
    },
  });
}
