import type { TimeSource } from "../../src/core/policy/clock.ts";

export interface FakeTimeSource extends TimeSource {
  advance(ms: number): void;
  advanceAsync(ms: number): Promise<void>;
  waitPending(): Promise<void>;
  jump(ms: number): void;
}

export function createFakeTimeSource(): FakeTimeSource {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { fireAt: number; fn: () => void }>();

  function setTimeoutFake(fn: () => void, ms: number): unknown {
    const id = nextId++;
    timers.set(id, { fireAt: current + ms, fn });
    return id;
  }

  function clearTimeoutFake(handle: unknown): void {
    timers.delete(handle as number);
  }

  function advance(ms: number): void {
    const target = current + ms;
    while (true) {
      let earliestId: number | undefined;
      let earliestFireAt = Infinity;
      for (const [id, entry] of timers) {
        if (entry.fireAt <= target && entry.fireAt < earliestFireAt) {
          earliestId = id;
          earliestFireAt = entry.fireAt;
        }
      }
      if (earliestId === undefined) break;
      const entry = timers.get(earliestId);
      timers.delete(earliestId);
      current = earliestFireAt;
      entry?.fn();
    }
    current = target;
  }

  // 每触发一个到点定时器就让出事件循环，让依赖它的异步轮询先跑完再推进下一个
  async function advanceAsync(ms: number): Promise<void> {
    const target = current + ms;
    for (;;) {
      let earliestId: number | undefined;
      let earliestFireAt = Infinity;
      for (const [id, entry] of timers) {
        if (entry.fireAt <= target && entry.fireAt < earliestFireAt) {
          earliestId = id;
          earliestFireAt = entry.fireAt;
        }
      }
      if (earliestId === undefined) break;
      const entry = timers.get(earliestId);
      timers.delete(earliestId);
      current = earliestFireAt;
      entry?.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    current = target;
    await new Promise((resolve) => setImmediate(resolve));
  }

  async function waitPending(): Promise<void> {
    for (let i = 0; i < 100 && timers.size === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    if (timers.size === 0) throw new Error("没有等到定时器登记");
  }

  function jump(ms: number): void {
    const target = current + ms;
    current = target;
    const due: Array<{ fireAt: number; fn: () => void }> = [];
    for (const [id, entry] of timers) {
      if (entry.fireAt <= target) {
        due.push(entry);
        timers.delete(id);
      }
    }
    for (const entry of due) entry.fn();
  }

  return { now: () => current, setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, advance, advanceAsync, waitPending, jump };
}

// 停止确认的轮询本身依赖这把注入时钟才能收敛；真实等待与虚拟时间推进并行，
// 而不是等真实墙钟走完停止上限
export async function withClockPump<T>(timeSource: FakeTimeSource, fn: () => Promise<T>): Promise<T> {
  const handle = setInterval(() => timeSource.advance(500), 20);
  (handle as unknown as { unref?: () => void }).unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(handle);
  }
}
