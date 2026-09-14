import { watch } from "node:fs";
import type { WatchListener } from "node:fs";
import net from "node:net";

/** 观察宿主创建的真实连接；只收到 socket close 才确认完成，不以 client.close 返回代替。 */
export function createClientSocketProbe() {
  const connect = net.createConnection;
  const counts = { created: 0, active: 0, closeEvents: 0 };
  const closures: Promise<void>[] = [];
  return {
    connect: ((...args: Parameters<typeof net.createConnection>) => {
      const socket = Reflect.apply(connect, net, args);
      counts.created++; counts.active++;
      // client 的正常销毁会移除监听器；观察实际 emit，透传原事件且不改变移除语义。
      const emit = socket.emit;
      let closed = false;
      closures.push(new Promise<void>((resolve) => {
        socket.emit = ((event: string | symbol, ...values: unknown[]) => {
          if (event === "close" && !closed) {
            closed = true; counts.active--; counts.closeEvents++; resolve();
          }
          return Reflect.apply(emit, socket, [event, ...values]);
        }) as typeof socket.emit;
      }));
      return socket;
    }) as typeof net.createConnection,
    snapshot: () => ({ ...counts }),
    closed: () => Promise.all(closures),
  };
}

/** 只记录真实 native watcher 的调用、事件与错误；close 调用本身不代表资源已释放。 */
export function createClientWatcherProbe(suppressWatch = false) {
  const counts = { created: 0, active: 0, closeCalls: 0, closeEvents: 0, closeErrors: 0, watchErrors: 0 };
  const closures: Promise<void>[] = [];
  return {
    watch(path: string, listener: WatchListener<string>) {
      const watcher = watch(path, (...args) => { if (!suppressWatch) listener?.(...args); });
      counts.created++; counts.active++;
      closures.push(new Promise<void>((resolve) => watcher.once("close", () => {
        counts.active--; counts.closeEvents++; resolve();
      })));
      watcher.on("error", () => { counts.watchErrors++; });
      const close = watcher.close.bind(watcher);
      watcher.close = () => {
        counts.closeCalls++;
        try { close(); } catch (error) { counts.closeErrors++; throw error; }
      };
      return watcher;
    },
    snapshot: () => ({ ...counts }),
    closed: () => Promise.all(closures),
  };
}
