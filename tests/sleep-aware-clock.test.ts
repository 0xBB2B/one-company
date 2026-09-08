import { describe, expect, test } from "bun:test";
import { createClock } from "../runtime/clock.ts";

interface FakeTimeSource {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  advance(ms: number): void;
  jump(ms: number): void;
}

function createFakeTimeSource(): FakeTimeSource {
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

  return { now: () => current, setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, advance, jump };
}

describe("elapsedExcludingSleep", () => {
  test("正常推进 60 秒时经过时间为 60 秒", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    clock.startGapWatcher();
    const start = clock.now();
    timeSource.advance(60_000);
    expect(clock.elapsedExcludingSleep(start)).toBe(60_000);
  });

  test("期间出现一次 300 秒跳变后经过时间仍为 60 秒", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    clock.startGapWatcher();
    const start = clock.now();
    timeSource.advance(30_000);
    timeSource.jump(300_000);
    timeSource.advance(30_000);
    expect(clock.elapsedExcludingSleep(start)).toBe(60_000);
  });
});

describe("startGapWatcher / stopGapWatcher", () => {
  test("定时器每次晚到 1 毫秒不记为睡眠间隔", () => {
    const inner = createFakeTimeSource();
    const jittery = {
      now: () => inner.now(),
      setTimeout: (fn: () => void, ms: number) => inner.setTimeout(fn, ms + 1),
      clearTimeout: (handle: unknown) => inner.clearTimeout(handle),
    };
    const clock = createClock({ timeSource: jittery });
    clock.startGapWatcher();
    const start = clock.now();
    inner.advance(60_000);
    expect(clock.sleepGaps()).toEqual([]);
    expect(clock.elapsedExcludingSleep(start)).toBe(60_000);
  });


  test("未启动看门狗时跳变不记为睡眠间隔，经过时间包含全部跳变时长", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    const start = clock.now();
    timeSource.jump(300_000);
    expect(clock.elapsedExcludingSleep(start)).toBe(300_000);
    expect(clock.sleepGaps()).toEqual([]);
  });

  test("stopGapWatcher 后跳变不再记为睡眠间隔", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    clock.startGapWatcher();
    clock.stopGapWatcher();
    const start = clock.now();
    timeSource.jump(300_000);
    expect(clock.sleepGaps()).toEqual([]);
    expect(clock.elapsedExcludingSleep(start)).toBe(300_000);
  });
});

describe("setTimeoutExcludingSleep", () => {
  test("60 秒超时随睡眠顺延，跳变前后均未触发，累计到 60 秒后才触发", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    clock.startGapWatcher();
    let calls = 0;
    clock.setTimeoutExcludingSleep(() => {
      calls++;
    }, 60_000);

    timeSource.advance(10_000);
    expect(calls).toBe(0);

    timeSource.jump(300_000);
    expect(calls).toBe(0);

    timeSource.advance(50_000);
    expect(calls).toBe(1);
  });

  test("clearTimer 后定时器不再触发", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const handle = clock.setTimeoutExcludingSleep(() => {
      calls++;
    }, 1_000);
    clock.clearTimer(handle);
    timeSource.advance(5_000);
    expect(calls).toBe(0);
  });
});

describe("setIntervalExcludingSleep", () => {
  test("跳变 300 秒唤醒后只触发一次，不补发缺失的周期", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    clock.startGapWatcher();
    let calls = 0;
    clock.setIntervalExcludingSleep(() => {
      calls++;
    }, 5_000);

    timeSource.jump(300_000);
    expect(calls).toBe(1);
  });

  test("唤醒后恢复正常推进仍按周期触发", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    clock.startGapWatcher();
    let calls = 0;
    clock.setIntervalExcludingSleep(() => {
      calls++;
    }, 5_000);

    timeSource.jump(300_000);
    expect(calls).toBe(1);

    timeSource.advance(5_000);
    expect(calls).toBe(2);

    timeSource.advance(5_000);
    expect(calls).toBe(3);
  });

  test("clearTimer 停止周期定时器后不再触发", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    const handle = clock.setIntervalExcludingSleep(() => {
      calls++;
    }, 1_000);
    timeSource.advance(2_500);
    expect(calls).toBe(2);
    clock.clearTimer(handle);
    timeSource.advance(5_000);
    expect(calls).toBe(2);
  });
});

describe("detectSleepGap", () => {
  test("差值超过阈值时记为一次睡眠间隔并返回间隔毫秒数", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource, sleepGapThresholdMs: 5_000 });
    const recorded = clock.detectSleepGap(0, 300_000);
    expect(recorded).toBe(300_000);
    expect(clock.sleepGaps().length).toBe(1);
    expect(clock.sleepGaps()[0]?.durationMs).toBe(300_000);
  });

  test("差值未超过阈值（3 秒）时不记为睡眠间隔，返回 0", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource, sleepGapThresholdMs: 5_000 });
    const recorded = clock.detectSleepGap(0, 3_000);
    expect(recorded).toBe(0);
    expect(clock.sleepGaps()).toEqual([]);
  });

  test("跳变小于阈值时，经过时间如实包含这段跳变", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource, sleepGapThresholdMs: 5_000 });
    clock.startGapWatcher();
    const start = clock.now();
    timeSource.jump(3_000);
    expect(clock.elapsedExcludingSleep(start)).toBe(3_000);
    expect(clock.sleepGaps()).toEqual([]);
  });
});

describe("onSleepGap", () => {
  test("回调收到间隔长度与唤醒时刻，注销后不再收到", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource, sleepGapThresholdMs: 5_000 });
    clock.startGapWatcher();
    const received: Array<{ durationMs: number; wokeAt: number }> = [];
    const unsubscribe = clock.onSleepGap((gap) => received.push(gap));

    timeSource.jump(300_000);
    expect(received.length).toBe(1);
    expect(received[0]?.durationMs).toBeGreaterThan(5_000);
    expect(received[0]?.wokeAt).toBe(300_000);

    unsubscribe();
    timeSource.jump(300_000);
    expect(received.length).toBe(1);
  });
});

describe("deadline", () => {
  test("扣除睡眠后未到期返回 false，到期返回 true", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource, sleepGapThresholdMs: 5_000 });
    clock.startGapWatcher();
    const start = clock.now();

    timeSource.advance(10_000);
    timeSource.jump(300_000);
    expect(clock.deadline(start, 60_000)).toBe(false);

    timeSource.advance(50_000);
    expect(clock.deadline(start, 60_000)).toBe(true);
  });
});

describe("真实时间源", () => {
  test("不传入 timeSource 时使用真实时钟，100 毫秒定时器能正常触发", async () => {
    const clock = createClock();
    await new Promise<void>((resolve) => {
      clock.setTimeoutExcludingSleep(() => resolve(), 100);
    });
  });
});

describe("睡眠区间边界与看门狗依赖", () => {
  test("睡眠始于 since 之前、醒于 since 之后时经过时间只扣交集且非负", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    clock.startGapWatcher();
    timeSource.advance(1_000);
    const since = clock.now() + 500;
    timeSource.advance(500);
    timeSource.jump(300_000);
    timeSource.advance(2_000);
    expect(clock.elapsedExcludingSleep(since)).toBe(2_000);
    expect(clock.sleepGaps()[0]?.sleptFrom).toBe(1_000);
  });

  test("停表一段清醒时间后重启看门狗，随后的睡眠只扣真实睡眠时长", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    clock.startGapWatcher();
    timeSource.advance(1_000);
    clock.stopGapWatcher();
    timeSource.advance(3_600_000);
    clock.startGapWatcher();
    const start = clock.now();
    timeSource.jump(300_000);
    timeSource.advance(10_000);
    expect(clock.sleepGaps()[0]?.durationMs).toBe(300_000);
    expect(clock.elapsedExcludingSleep(start)).toBe(10_000);
  });

  test("未显式启动看门狗时睡眠落在定时器等待区间内也不会早触发", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    clock.setTimeoutExcludingSleep(() => {
      calls++;
    }, 600_000);
    timeSource.advance(10_000);
    timeSource.jump(300_000);
    timeSource.advance(400_000);
    expect(calls).toBe(0);
    timeSource.advance(190_000);
    expect(calls).toBe(1);
  });

  test("在唤醒回调里取消的周期与超时定时器本次不再执行也不再重排", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    clock.startGapWatcher();
    let intervalCalls = 0;
    let timeoutCalls = 0;
    const interval = clock.setIntervalExcludingSleep(() => {
      intervalCalls++;
    }, 5_000);
    const timeout = clock.setTimeoutExcludingSleep(() => {
      timeoutCalls++;
    }, 60_000);
    clock.onSleepGap(() => {
      clock.clearTimer(interval);
      clock.clearTimer(timeout);
    });
    timeSource.advance(20_000);
    const before = intervalCalls;
    timeSource.jump(300_000);
    timeSource.advance(100_000);
    expect(intervalCalls).toBe(before);
    expect(timeoutCalls).toBe(0);
  });

  test("某个唤醒回调抛出异常时其余回调仍收到且看门狗继续工作", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    clock.startGapWatcher();
    let received = 0;
    clock.onSleepGap(() => {
      throw new Error("唤醒处理失败");
    });
    clock.onSleepGap(() => {
      received++;
    });
    const start = clock.now();
    timeSource.jump(300_000);
    timeSource.advance(10_000);
    timeSource.jump(300_000);
    timeSource.advance(10_000);
    expect(received).toBe(2);
    expect(clock.elapsedExcludingSleep(start)).toBe(20_000);
  });

  test("未启动看门狗时长定时器在睡眠后不会早于清醒累计时长触发", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    let calls = 0;
    clock.setTimeoutExcludingSleep(() => {
      calls++;
    }, 60_000);
    timeSource.advance(10_000);
    timeSource.jump(300_000);
    timeSource.advance(49_000);
    expect(calls).toBe(0);
    timeSource.advance(11_000);
    expect(calls).toBe(1);
  });

  test("同一次唤醒中多个定时器只记一条间隔且扣除量准确", () => {
    const timeSource = createFakeTimeSource();
    const clock = createClock({ timeSource });
    clock.startGapWatcher();
    const start = clock.now();
    clock.setTimeoutExcludingSleep(() => {}, 20_000);
    clock.setIntervalExcludingSleep(() => {}, 7_000);
    timeSource.advance(30_000);
    timeSource.jump(300_000);
    expect(clock.sleepGaps().length).toBe(1);
    expect(clock.sleepGaps()[0]?.durationMs).toBe(300_000);
    expect(clock.elapsedExcludingSleep(start)).toBe(30_000);
  });
});
