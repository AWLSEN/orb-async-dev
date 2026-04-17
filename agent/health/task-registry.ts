// In-memory registry of active tasks + the stuck-task reaper.
//
// TaskRunner.run() wraps its work in registry.start(id)/registry.finish(id);
// the reaper periodically scans entries older than `maxRuntimeMs` and calls
// a caller-supplied cancel() to tear them down + notify.
//
// Intentionally not persisted: a cold-start after Orb resumes the computer
// starts with an empty registry, which is fine because any in-flight task
// died with the previous process anyway.

export interface TaskEntry {
  id: string;
  startedAt: number;
  label: string;
  cancel: () => Promise<void> | void;
}

export interface TaskRegistry {
  start(entry: TaskEntry): void;
  finish(id: string): void;
  active(): TaskEntry[];
  has(id: string): boolean;
}

export function createTaskRegistry(): TaskRegistry {
  const entries = new Map<string, TaskEntry>();
  return {
    start(entry) {
      entries.set(entry.id, entry);
    },
    finish(id) {
      entries.delete(id);
    },
    active: () => Array.from(entries.values()),
    has: (id) => entries.has(id),
  };
}

export interface ReaperDeps {
  registry: TaskRegistry;
  maxRuntimeMs: number;
  now?: () => number;
  onReap?: (entry: TaskEntry, reason: string) => Promise<void> | void;
}

export interface ReaperTick {
  reaped: string[];
  stillRunning: string[];
}

/** One sweep: cancels any entry exceeding maxRuntimeMs. */
export async function reapStuckTasks(deps: ReaperDeps): Promise<ReaperTick> {
  const now = (deps.now ?? Date.now)();
  const reaped: string[] = [];
  const stillRunning: string[] = [];
  for (const entry of deps.registry.active()) {
    const age = now - entry.startedAt;
    if (age >= deps.maxRuntimeMs) {
      try {
        await Promise.resolve(entry.cancel());
      } catch {
        // Cancel best-effort; we still remove from registry.
      }
      deps.registry.finish(entry.id);
      if (deps.onReap) {
        await Promise.resolve(deps.onReap(entry, `exceeded ${deps.maxRuntimeMs}ms (age ${age}ms)`));
      }
      reaped.push(entry.id);
    } else {
      stillRunning.push(entry.id);
    }
  }
  return { reaped, stillRunning };
}
