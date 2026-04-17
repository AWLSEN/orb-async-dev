// Cost watchdog. Reads /v1/usage each tick, compares against a user-set
// daily-$ cap, and pauses + notifies once crossed so an infinite tool-call
// loop can't run up a bill unnoticed. A "trip" is sticky — once paused,
// we stay paused until the operator acknowledges (resetTripped()).

import type { OrbClient, UsageResponse } from "../../deploy/orb-api.ts";

export interface CostWatchdogDeps {
  orb: Pick<OrbClient, "usage">;
  /** Hard cap in USD per day. A reading >= this trips the watchdog. */
  dailyCapUsd: number;
  /** Return current time; injectable for tests. */
  now?: () => Date;
  /** Called exactly once when the watchdog first trips (not on every tick). */
  onTrip?: (snapshot: CostSnapshot) => Promise<void> | void;
  /** Called after a successful reading that is under the cap. */
  onOk?: (snapshot: CostSnapshot) => void;
}

export interface CostSnapshot {
  /** ISO start (midnight of the current day in UTC). */
  start: string;
  /** ISO end (now). */
  end: string;
  usd: number;
  gbHoursRuntime: number;
  gbHoursDisk: number;
  tripped: boolean;
}

export interface CostWatchdog {
  tick(): Promise<CostSnapshot>;
  isTripped(): boolean;
  resetTripped(): void;
}

export function createCostWatchdog(deps: CostWatchdogDeps): CostWatchdog {
  const now = deps.now ?? (() => new Date());
  let tripped = false;
  let notified = false;

  return {
    async tick(): Promise<CostSnapshot> {
      const end = now();
      const start = startOfUtcDay(end);
      const usage = await deps.orb.usage({ start: start.toISOString(), end: end.toISOString() });
      const snapshot = materialize(usage, start, end);
      if (snapshot.usd >= deps.dailyCapUsd) {
        tripped = true;
        snapshot.tripped = true;
        if (!notified && deps.onTrip) {
          notified = true;
          await Promise.resolve(deps.onTrip(snapshot));
        }
      } else {
        snapshot.tripped = tripped; // stays tripped until reset
        if (!tripped) deps.onOk?.(snapshot);
      }
      return snapshot;
    },
    isTripped: () => tripped,
    resetTripped: () => {
      tripped = false;
      notified = false;
    },
  };
}

export function startOfUtcDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

/** Best-effort USD computation from the /v1/usage response shape. */
function materialize(u: UsageResponse, start: Date, end: Date): CostSnapshot {
  const runtime = u.runtime_gb_hours ?? sumField(u.rows, "gb_hours");
  const disk = u.disk_gb_hours ?? 0;
  // Server currently doesn't return a usd column; approximate with
  // published rates (~$0.00001/gb-second = $0.036/gb-hour for runtime,
  // ~$0.0000001/gb-second = $0.00036/gb-hour for disk). These are loose
  // defaults; operators can override by reading the snapshot and comparing
  // against their own model.
  const rowsUsd = sumField(u.rows, "cost_usd");
  const usd = rowsUsd > 0 ? rowsUsd : runtime * 0.036 + disk * 0.00036;
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    usd: Number(usd.toFixed(4)),
    gbHoursRuntime: Number(runtime.toFixed(4)),
    gbHoursDisk: Number(disk.toFixed(4)),
    tripped: false,
  };
}

function sumField(rows: UsageResponse["rows"] | undefined, field: "gb_hours" | "cost_usd"): number {
  if (!rows) return 0;
  let total = 0;
  for (const r of rows) {
    const v = (r as Record<string, unknown>)[field];
    if (typeof v === "number") total += v;
  }
  return total;
}
