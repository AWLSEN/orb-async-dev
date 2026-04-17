// Tiny interval scheduler for the orchestrator's background health loops.
// setInterval with jitter so multiple tasks don't stampede, and a Stop
// handle that cancels in-flight work. Keeps Bun's test runner happy via an
// injectable clock.
//
// The hot path for wake-on-webhook is unaffected — these loops only run
// after Orb promotes the computer.

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface PeriodicTask {
  name: string;
  intervalMs: number;
  /** Absolute time in ms the next run is allowed. Defaults to "immediately". */
  firstRunAt?: number;
  run: () => Promise<void>;
  /** +/- this many ms added to each schedule so tasks don't synchronize. */
  jitterMs?: number;
}

export interface StopHandle {
  stop(): void;
}

export interface Scheduler {
  schedule(task: PeriodicTask): StopHandle;
  stopAll(): void;
}

export function createScheduler(clock: Clock = realClock, onError?: (name: string, err: unknown) => void): Scheduler {
  const handles = new Set<StopHandle>();

  function schedule(task: PeriodicTask): StopHandle {
    let active = true;
    let timer: unknown = null;

    const loop = async (): Promise<void> => {
      if (!active) return;
      try {
        await task.run();
      } catch (e) {
        onError?.(task.name, e);
      }
      if (!active) return;
      const base = task.intervalMs;
      const jitter = task.jitterMs ?? 0;
      const delta = jitter > 0 ? Math.floor((Math.random() * 2 - 1) * jitter) : 0;
      const next = Math.max(1, base + delta);
      timer = clock.setTimeout(loop, next);
    };

    const firstDelay = task.firstRunAt !== undefined ? Math.max(1, task.firstRunAt - clock.now()) : 1;
    timer = clock.setTimeout(loop, firstDelay);

    const handle: StopHandle = {
      stop: () => {
        active = false;
        if (timer !== null) clock.clearTimeout(timer);
        handles.delete(handle);
      },
    };
    handles.add(handle);
    return handle;
  }

  function stopAll(): void {
    for (const h of Array.from(handles)) h.stop();
  }

  return { schedule, stopAll };
}
