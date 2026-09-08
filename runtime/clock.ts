export interface TimeSource {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  unref?(handle: unknown): void;
}

export interface SleepGap {
  durationMs: number;
  sleptFrom: number;
  wokeAt: number;
}

export interface CreateClockOptions {
  timeSource?: TimeSource;
  sleepGapThresholdMs?: number;
  watchdogIntervalMs?: number;
}

export interface TimerHandle {
  cancelled: boolean;
  rawId: unknown;
}

export interface Clock {
  now(): number;
  startGapWatcher(): void;
  stopGapWatcher(): void;
  detectSleepGap(expectedTime: number, actualTime: number): number;
  elapsedExcludingSleep(start: number): number;
  deadline(start: number, timeoutMs: number): boolean;
  setTimeoutExcludingSleep(fn: () => void, ms: number): TimerHandle;
  setIntervalExcludingSleep(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  onSleepGap(callback: (gap: SleepGap) => void): () => void;
  sleepGaps(): SleepGap[];
}

const DEFAULT_SLEEP_GAP_THRESHOLD_MS = 5_000;
const DEFAULT_WATCHDOG_INTERVAL_MS = 1_000;

const realTimeSource: TimeSource = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  unref: (handle) => (handle as ReturnType<typeof setTimeout>).unref(),
};

export function createClock(options: CreateClockOptions = {}): Clock {
  const timeSource = options.timeSource ?? realTimeSource;
  const thresholdMs = options.sleepGapThresholdMs ?? DEFAULT_SLEEP_GAP_THRESHOLD_MS;
  const watchdogIntervalMs = options.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;

  const ledger: SleepGap[] = [];
  const listeners = new Set<(gap: SleepGap) => void>();
  // 触发条件看"比预期晚到多少"（定时器抖动不会超阈值），间隔长度看"距上次确认醒着的时刻多久"；
  // 同一次唤醒里先触发的定时器推进检查点，后触发的算出 0 长度而不重复记录。
  let lastCheckpoint = timeSource.now();
  let watcherHandle: TimerHandle | null = null;

  function detectSleepGap(expectedTime: number, actualTime: number): number {
    const lateness = actualTime - expectedTime;
    if (lateness <= thresholdMs) {
      lastCheckpoint = Math.max(lastCheckpoint, actualTime);
      return 0;
    }
    const sleptFrom = lastCheckpoint;
    const durationMs = actualTime - sleptFrom;
    lastCheckpoint = actualTime;
    if (durationMs <= 0) return 0;
    const gap: SleepGap = { durationMs, sleptFrom, wokeAt: actualTime };
    ledger.push(gap);
    for (const listener of listeners) {
      try {
        listener(gap);
      } catch {
        // 单个唤醒处理器故障不能让账本停摆或殃及其他处理器
      }
    }
    return durationMs;
  }

  function elapsedExcludingSleep(start: number): number {
    const now = timeSource.now();
    let sleptMs = 0;
    for (const gap of ledger) {
      sleptMs += Math.max(0, Math.min(gap.wokeAt, now) - Math.max(gap.sleptFrom, start));
    }
    return Math.max(0, now - start - sleptMs);
  }

  function deadline(start: number, timeoutMs: number): boolean {
    return elapsedExcludingSleep(start) >= timeoutMs;
  }

  function startGapWatcher(): void {
    if (watcherHandle) return;
    lastCheckpoint = timeSource.now();
    const handle: TimerHandle = { cancelled: false, rawId: undefined };
    let expectedAt = timeSource.now() + watchdogIntervalMs;
    function schedule(): void {
      handle.rawId = timeSource.setTimeout(tick, watchdogIntervalMs);
      timeSource.unref?.(handle.rawId);
    }
    function tick(): void {
      if (handle.cancelled) return;
      detectSleepGap(expectedAt, timeSource.now());
      if (handle.cancelled) return;
      expectedAt = timeSource.now() + watchdogIntervalMs;
      schedule();
    }
    schedule();
    watcherHandle = handle;
  }

  function stopGapWatcher(): void {
    if (!watcherHandle) return;
    watcherHandle.cancelled = true;
    timeSource.clearTimeout(watcherHandle.rawId);
    watcherHandle = null;
  }

  // 睡眠落在等待区间内时定时器不会晚到，只有看门狗能发现这段睡眠，所以定时器 API 自行保证看门狗在跑
  function setTimeoutExcludingSleep(fn: () => void, ms: number): TimerHandle {
    startGapWatcher();
    const start = timeSource.now();
    const handle: TimerHandle = { cancelled: false, rawId: undefined };
    let expectedAt = start + ms;
    function fire(): void {
      if (handle.cancelled) return;
      detectSleepGap(expectedAt, timeSource.now());
      if (handle.cancelled) return;
      const remaining = ms - elapsedExcludingSleep(start);
      if (remaining <= 0) {
        fn();
        return;
      }
      expectedAt = timeSource.now() + remaining;
      handle.rawId = timeSource.setTimeout(fire, remaining);
    }
    handle.rawId = timeSource.setTimeout(fire, ms);
    return handle;
  }

  function setIntervalExcludingSleep(fn: () => void, ms: number): TimerHandle {
    startGapWatcher();
    const handle: TimerHandle = { cancelled: false, rawId: undefined };
    let expectedAt = timeSource.now() + ms;
    function tick(): void {
      if (handle.cancelled) return;
      detectSleepGap(expectedAt, timeSource.now());
      if (handle.cancelled) return;
      fn();
      if (handle.cancelled) return;
      expectedAt = timeSource.now() + ms;
      handle.rawId = timeSource.setTimeout(tick, ms);
    }
    handle.rawId = timeSource.setTimeout(tick, ms);
    return handle;
  }

  function clearTimer(handle: TimerHandle): void {
    handle.cancelled = true;
    timeSource.clearTimeout(handle.rawId);
  }

  function onSleepGap(callback: (gap: SleepGap) => void): () => void {
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  function sleepGaps(): SleepGap[] {
    return ledger.slice();
  }

  return {
    now: () => timeSource.now(),
    startGapWatcher,
    stopGapWatcher,
    detectSleepGap,
    elapsedExcludingSleep,
    deadline,
    setTimeoutExcludingSleep,
    setIntervalExcludingSleep,
    clearTimer,
    onSleepGap,
    sleepGaps,
  };
}
