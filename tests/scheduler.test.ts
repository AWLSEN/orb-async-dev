import { describe, expect, it } from "bun:test";
import { createScheduler, type Clock } from "../agent/health/scheduler.ts";

interface FakeClock extends Clock {
  tick(ms: number): Promise<void>;
  pending(): number;
}

function fakeClock(): FakeClock {
  let now = 0;
  interface Entry {
    due: number;
    fn: () => void;
    id: number;
    cleared: boolean;
  }
  const entries: Entry[] = [];
  let nextId = 1;

  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      entries.push({ due: now + ms, fn, id, cleared: false });
      return id;
    },
    clearTimeout: (h) => {
      const e = entries.find((x) => x.id === h);
      if (e) e.cleared = true;
    },
  };

  return {
    ...clock,
    tick: async (ms: number) => {
      const target = now + ms;
      for (;;) {
        const due = entries.find((e) => !e.cleared && e.due <= target);
        if (!due) break;
        now = due.due;
        due.cleared = true;
        // Run the callback and let any awaited scheduling happen.
        due.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = target;
    },
    pending: () => entries.filter((e) => !e.cleared).length,
  };
}

describe("scheduler", () => {
  it("fires after intervalMs and reschedules", async () => {
    const clock = fakeClock();
    const calls: number[] = [];
    const s = createScheduler(clock);
    s.schedule({
      name: "tick",
      intervalMs: 1000,
      run: async () => {
        calls.push(clock.now());
      },
    });
    await clock.tick(1); // first run (immediate)
    expect(calls.length).toBe(1);
    await clock.tick(1000);
    expect(calls.length).toBe(2);
    await clock.tick(1000);
    expect(calls.length).toBe(3);
    s.stopAll();
  });

  it("respects firstRunAt to delay the first run", async () => {
    const clock = fakeClock();
    const calls: number[] = [];
    const s = createScheduler(clock);
    s.schedule({
      name: "delayed",
      intervalMs: 1000,
      firstRunAt: 500,
      run: async () => {
        calls.push(clock.now());
      },
    });
    await clock.tick(100);
    expect(calls.length).toBe(0);
    await clock.tick(500);
    expect(calls.length).toBe(1);
    s.stopAll();
  });

  it("stop() cancels the in-flight schedule", async () => {
    const clock = fakeClock();
    let calls = 0;
    const s = createScheduler(clock);
    const handle = s.schedule({
      name: "x",
      intervalMs: 1000,
      run: async () => {
        calls += 1;
      },
    });
    await clock.tick(1);
    expect(calls).toBe(1);
    handle.stop();
    await clock.tick(5000);
    expect(calls).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("routes thrown errors through onError without stopping the loop", async () => {
    const clock = fakeClock();
    const seen: string[] = [];
    const s = createScheduler(clock, (name, err) => seen.push(`${name}:${(err as Error).message}`));
    let calls = 0;
    s.schedule({
      name: "flaky",
      intervalMs: 1000,
      run: async () => {
        calls += 1;
        if (calls === 1) throw new Error("first fail");
      },
    });
    await clock.tick(1);
    expect(seen).toEqual(["flaky:first fail"]);
    await clock.tick(1000);
    expect(calls).toBe(2); // still rescheduled
    s.stopAll();
  });

  it("jitterMs is bounded to +/- jitter (never negative interval)", async () => {
    const clock = fakeClock();
    const s = createScheduler(clock);
    const intervals: number[] = [];
    let last = 0;
    s.schedule({
      name: "j",
      intervalMs: 1000,
      jitterMs: 200,
      run: async () => {
        const now = clock.now();
        if (last > 0) intervals.push(now - last);
        last = now;
      },
    });
    await clock.tick(1);
    for (let i = 0; i < 30; i++) await clock.tick(2000);
    for (const delta of intervals) {
      expect(delta).toBeGreaterThanOrEqual(800);
      expect(delta).toBeLessThanOrEqual(1200);
    }
    s.stopAll();
  });

  it("stopAll clears all pending timers", async () => {
    const clock = fakeClock();
    const s = createScheduler(clock);
    s.schedule({ name: "a", intervalMs: 1000, run: async () => undefined });
    s.schedule({ name: "b", intervalMs: 1000, run: async () => undefined });
    expect(clock.pending()).toBe(2);
    s.stopAll();
    expect(clock.pending()).toBe(0);
  });
});
