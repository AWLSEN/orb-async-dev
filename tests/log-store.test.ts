import { describe, expect, it } from "bun:test";
import { createLogStore, renderLogsHtml } from "../agent/log-store.ts";

describe("createLogStore", () => {
  it("push + snapshot round-trip", () => {
    const s = createLogStore(100);
    s.push("one");
    s.push("two");
    const snap = s.snapshot();
    expect(snap.length).toBe(2);
    expect(snap[0]?.line).toBe("one");
    expect(snap[1]?.line).toBe("two");
    expect(typeof snap[0]?.ts).toBe("number");
  });

  it("evicts oldest when capacity exceeded (FIFO)", () => {
    const s = createLogStore(3);
    for (const line of ["a", "b", "c", "d", "e"]) s.push(line);
    const snap = s.snapshot();
    expect(snap.map((e) => e.line)).toEqual(["c", "d", "e"]);
  });

  it("snapshot returns a copy — callers can't mutate the store", () => {
    const s = createLogStore(5);
    s.push("x");
    const snap = s.snapshot();
    snap.push({ ts: 0, line: "injected" });
    expect(s.snapshot().length).toBe(1);
  });
});

describe("renderLogsHtml", () => {
  it("shows count + capacity in the header", () => {
    const s = createLogStore(500);
    s.push("task received");
    const html = renderLogsHtml(s);
    expect(html).toContain("1/500");
    expect(html).toContain("task received");
  });

  it("escapes HTML so log content can't inject tags", () => {
    const s = createLogStore(5);
    s.push("<script>alert(1)</script>");
    const html = renderLogsHtml(s);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("adds the err class for failure keywords", () => {
    const s = createLogStore(5);
    s.push("[cost-watchdog] TRIPPED at $5.00");
    const html = renderLogsHtml(s);
    expect(html).toContain('class="err"');
  });

  it("adds the ok class for success markers", () => {
    const s = createLogStore(5);
    s.push("[orchestrator] task done branch=orb/fix-x pr=42");
    const html = renderLogsHtml(s);
    expect(html).toContain('class="ok"');
  });

  it('shows "(no events)" when the store is empty', () => {
    const s = createLogStore(5);
    expect(renderLogsHtml(s)).toContain("(no events)");
  });

  it("respects tail to show only the last N entries", () => {
    const s = createLogStore(500);
    for (let i = 0; i < 10; i++) s.push(`line-${i}`);
    const html = renderLogsHtml(s, { tail: 3 });
    expect(html).toContain("line-7");
    expect(html).toContain("line-8");
    expect(html).toContain("line-9");
    expect(html).not.toContain("line-6");
  });

  it("auto-refresh meta tag is present (5s)", () => {
    expect(renderLogsHtml(createLogStore(1))).toContain('http-equiv="refresh" content="5"');
  });
});
