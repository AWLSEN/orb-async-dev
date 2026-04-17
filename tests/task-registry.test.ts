import { describe, expect, it } from "bun:test";
import { createTaskRegistry, reapStuckTasks } from "../agent/health/task-registry.ts";

describe("createTaskRegistry", () => {
  it("start/active/has/finish round-trip", () => {
    const r = createTaskRegistry();
    r.start({ id: "t1", startedAt: 0, label: "fix bug", cancel: () => undefined });
    expect(r.has("t1")).toBe(true);
    expect(r.active().length).toBe(1);
    r.finish("t1");
    expect(r.has("t1")).toBe(false);
    expect(r.active().length).toBe(0);
  });

  it("start overwrites duplicates by id", () => {
    const r = createTaskRegistry();
    r.start({ id: "t1", startedAt: 1, label: "a", cancel: () => undefined });
    r.start({ id: "t1", startedAt: 2, label: "b", cancel: () => undefined });
    expect(r.active()[0]?.label).toBe("b");
  });
});

describe("reapStuckTasks", () => {
  it("reaps entries older than maxRuntimeMs and calls cancel + onReap", async () => {
    const r = createTaskRegistry();
    let cancelled = 0;
    r.start({ id: "old", startedAt: 0, label: "old task", cancel: () => { cancelled += 1; } });
    r.start({ id: "new", startedAt: 900, label: "recent", cancel: () => { cancelled += 10; } });
    const reaped: string[] = [];
    const tick = await reapStuckTasks({
      registry: r,
      maxRuntimeMs: 500,
      now: () => 1000,
      onReap: (entry, reason) => { reaped.push(`${entry.id}:${reason}`); },
    });
    expect(tick.reaped).toEqual(["old"]);
    expect(tick.stillRunning).toEqual(["new"]);
    expect(cancelled).toBe(1);
    expect(reaped[0]).toMatch(/^old:exceeded 500ms/);
    expect(r.has("old")).toBe(false);
    expect(r.has("new")).toBe(true);
  });

  it("swallows cancel() exceptions but still removes + notifies", async () => {
    const r = createTaskRegistry();
    r.start({
      id: "boom",
      startedAt: 0,
      label: "will throw",
      cancel: () => { throw new Error("cancel failed"); },
    });
    const reaped: string[] = [];
    const tick = await reapStuckTasks({
      registry: r,
      maxRuntimeMs: 100,
      now: () => 1000,
      onReap: (e) => { reaped.push(e.id); },
    });
    expect(tick.reaped).toEqual(["boom"]);
    expect(reaped).toEqual(["boom"]);
    expect(r.has("boom")).toBe(false);
  });

  it("no reap when all entries young", async () => {
    const r = createTaskRegistry();
    r.start({ id: "a", startedAt: 800, label: "a", cancel: () => undefined });
    r.start({ id: "b", startedAt: 900, label: "b", cancel: () => undefined });
    const tick = await reapStuckTasks({ registry: r, maxRuntimeMs: 500, now: () => 1000 });
    expect(tick.reaped).toEqual([]);
    expect(tick.stillRunning.sort()).toEqual(["a", "b"]);
  });

  it("exactly-at-threshold counts as reapable", async () => {
    const r = createTaskRegistry();
    r.start({ id: "edge", startedAt: 500, label: "x", cancel: () => undefined });
    const tick = await reapStuckTasks({ registry: r, maxRuntimeMs: 500, now: () => 1000 });
    expect(tick.reaped).toEqual(["edge"]);
  });
});
