import { describe, expect, it } from "bun:test";
import { createCostWatchdog, startOfUtcDay } from "../agent/health/cost-watchdog.ts";
import type { UsageResponse } from "../deploy/orb-api.ts";

function fixed(iso: string): Date {
  return new Date(iso);
}

function usageClient(responses: UsageResponse[]): { orb: { usage: () => Promise<UsageResponse> }; calls: number } {
  let i = 0;
  return {
    orb: {
      usage: async () => {
        const r = responses[i] ?? responses[responses.length - 1];
        i += 1;
        return r!;
      },
    },
    get calls() {
      return i;
    },
  };
}

describe("startOfUtcDay", () => {
  it("zeros hours/minutes/seconds at UTC", () => {
    const d = fixed("2026-04-17T13:45:01.123Z");
    expect(startOfUtcDay(d).toISOString()).toBe("2026-04-17T00:00:00.000Z");
  });
});

describe("createCostWatchdog", () => {
  it("records ok when under cap", async () => {
    const { orb } = usageClient([{ runtime_gb_hours: 1, disk_gb_hours: 10 }]);
    const oks: number[] = [];
    const wd = createCostWatchdog({
      orb,
      dailyCapUsd: 1,
      now: () => fixed("2026-04-17T12:00:00Z"),
      onOk: (s) => oks.push(s.usd),
    });
    const snap = await wd.tick();
    expect(snap.tripped).toBe(false);
    expect(wd.isTripped()).toBe(false);
    expect(oks.length).toBe(1);
    expect(snap.usd).toBeLessThan(1);
  });

  it("trips + notifies once when usd >= cap", async () => {
    const { orb } = usageClient([
      { runtime_gb_hours: 100, disk_gb_hours: 0 }, // ~$3.60
      { runtime_gb_hours: 120, disk_gb_hours: 0 },
      { runtime_gb_hours: 150, disk_gb_hours: 0 },
    ]);
    const trips: number[] = [];
    const wd = createCostWatchdog({
      orb,
      dailyCapUsd: 1,
      now: () => fixed("2026-04-17T12:00:00Z"),
      onTrip: async (s) => { trips.push(s.usd); },
    });
    const s1 = await wd.tick();
    expect(s1.tripped).toBe(true);
    expect(wd.isTripped()).toBe(true);
    expect(trips.length).toBe(1);

    // Subsequent ticks stay tripped but don't re-notify.
    await wd.tick();
    await wd.tick();
    expect(trips.length).toBe(1);
  });

  it("stays tripped even after readings dip below cap", async () => {
    const { orb } = usageClient([
      { runtime_gb_hours: 100, disk_gb_hours: 0 }, // trips
      { runtime_gb_hours: 0.01, disk_gb_hours: 0 }, // under cap
    ]);
    const wd = createCostWatchdog({ orb, dailyCapUsd: 1, now: () => fixed("2026-04-17T12:00:00Z") });
    await wd.tick();
    const s = await wd.tick();
    expect(s.tripped).toBe(true);
    expect(wd.isTripped()).toBe(true);
  });

  it("resetTripped() clears the sticky state", async () => {
    const { orb } = usageClient([
      { runtime_gb_hours: 100, disk_gb_hours: 0 },
      { runtime_gb_hours: 0.01, disk_gb_hours: 0 },
    ]);
    const wd = createCostWatchdog({ orb, dailyCapUsd: 1, now: () => fixed("2026-04-17T12:00:00Z") });
    await wd.tick();
    expect(wd.isTripped()).toBe(true);
    wd.resetTripped();
    expect(wd.isTripped()).toBe(false);
    const s = await wd.tick();
    expect(s.tripped).toBe(false);
  });

  it("prefers server-provided row-level cost_usd when present", async () => {
    const { orb } = usageClient([{ rows: [{ cost_usd: 42 }] }]);
    const wd = createCostWatchdog({ orb, dailyCapUsd: 100, now: () => fixed("2026-04-17T12:00:00Z") });
    const s = await wd.tick();
    expect(s.usd).toBeCloseTo(42);
  });

  it("falls back to row-level gb_hours sum when runtime_gb_hours absent", async () => {
    const { orb } = usageClient([{ rows: [{ gb_hours: 10 }, { gb_hours: 20 }] }]);
    const wd = createCostWatchdog({ orb, dailyCapUsd: 100, now: () => fixed("2026-04-17T12:00:00Z") });
    const s = await wd.tick();
    expect(s.gbHoursRuntime).toBeCloseTo(30);
  });

  it("passes ISO start (day boundary) + end (now) to the API", async () => {
    const calls: Array<{ start: string; end: string }> = [];
    const orb = {
      usage: async (q: { start: string; end: string }) => {
        calls.push(q);
        return { runtime_gb_hours: 0, disk_gb_hours: 0 };
      },
    };
    const wd = createCostWatchdog({ orb, dailyCapUsd: 1, now: () => fixed("2026-04-17T13:45:01Z") });
    await wd.tick();
    expect(calls[0]?.start).toBe("2026-04-17T00:00:00.000Z");
    expect(calls[0]?.end).toBe("2026-04-17T13:45:01.000Z");
  });
});
