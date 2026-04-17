import { afterAll, describe, expect, it } from "bun:test";
import { createOrchestrator, type Orchestrator } from "../agent/orchestrator.ts";
import { computeSignature } from "../adapters/webhook-verify.ts";
import type { TaskRequest } from "../adapters/event-router.ts";

const SECRET = "wh-secret";

interface Harness {
  orch: Orchestrator;
  base: string;
  tasks: TaskRequest[];
  logs: string[];
}

function boot(opts: { secret?: string; onTask?: (t: TaskRequest) => void } = {}): Harness {
  const tasks: TaskRequest[] = [];
  const logs: string[] = [];
  const orch = createOrchestrator({
    port: 0,
    webhookSecret: opts.secret ?? SECRET,
    onTask: (t) => {
      tasks.push(t);
      opts.onTask?.(t);
    },
    log: (line) => logs.push(line),
  });
  return { orch, base: `http://localhost:${orch.server.port}`, tasks, logs };
}

async function post(h: Harness, payload: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const body = JSON.stringify(payload);
  const sig = headers["x-hub-signature-256"] ?? (await computeSignature(body, SECRET));
  return fetch(`${h.base}/github/webhook`, {
    method: "POST",
    body,
    headers: {
      "x-hub-signature-256": sig,
      "x-github-event": headers["x-github-event"] ?? "issue_comment",
      "x-github-delivery": headers["x-github-delivery"] ?? "test-1",
      "content-type": "application/json",
    },
  });
}

const commentPayload = (overrides: Record<string, unknown> = {}) => ({
  action: "created",
  issue: { number: 12 },
  comment: { id: 999, body: "@orb fix the bug", user: { login: "sam" } },
  repository: { full_name: "nextbysam/demo" },
  ...overrides,
});

describe("orchestrator — core surface", () => {
  const h = boot();
  afterAll(() => h.orch.server.stop(true));

  it("GET /health returns 200 ok", async () => {
    const res = await fetch(`${h.base}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("GET /github/webhook returns 404 (only POST)", async () => {
    const res = await fetch(`${h.base}/github/webhook`);
    expect(res.status).toBe(404);
  });

  it("unknown path 404", async () => {
    const res = await fetch(`${h.base}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("orchestrator — webhook verify", () => {
  const h = boot();
  afterAll(() => h.orch.server.stop(true));

  it("rejects unsigned webhooks", async () => {
    const res = await fetch(`${h.base}/github/webhook`, {
      method: "POST",
      body: "{}",
      headers: { "x-github-event": "issue_comment" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects wrong signature", async () => {
    const res = await post(h, commentPayload(), { "x-hub-signature-256": "sha256=deadbeef" });
    expect(res.status).toBe(401);
  });

  it("rejects invalid json", async () => {
    const body = "not json";
    const sig = await computeSignature(body, SECRET);
    const res = await fetch(`${h.base}/github/webhook`, {
      method: "POST",
      body,
      headers: { "x-hub-signature-256": sig, "x-github-event": "issue_comment" },
    });
    expect(res.status).toBe(400);
  });
});

describe("orchestrator — routing", () => {
  const h = boot();
  afterAll(() => h.orch.server.stop(true));

  it("accepts a valid @orb issue_comment, enqueues task, returns 202", async () => {
    const res = await post(h, commentPayload());
    expect(res.status).toBe(202);
    const body = (await res.json()) as { accepted: boolean };
    expect(body.accepted).toBe(true);
    // onTask runs in the background; give it a tick.
    await Bun.sleep(30);
    expect(h.tasks.length).toBe(1);
    expect(h.tasks[0]?.taskText).toBe("fix the bug");
  });

  it("dedups a retry for the same commentId", async () => {
    const res = await post(h, commentPayload(), { "x-github-delivery": "test-2" });
    expect(res.status).toBe(204);
    expect(res.headers.get("x-orb-ignored")).toBe("duplicate");
    await Bun.sleep(30);
    expect(h.tasks.length).toBe(1); // unchanged
  });

  it("ignores comments without a mention with 204", async () => {
    const p = commentPayload({ comment: { id: 111, body: "just a regular comment", user: { login: "sam" } } });
    const res = await post(h, p, { "x-github-delivery": "test-3" });
    expect(res.status).toBe(204);
    expect(res.headers.get("x-orb-ignored")).toBe("no_mention");
  });

  it("ignores self-authored comments from the bot login", async () => {
    const p = commentPayload({ comment: { id: 222, body: "@orb try again", user: { login: "orb-bot" } } });
    const res = await post(h, p, { "x-github-delivery": "test-4" });
    expect(res.status).toBe(204);
    expect(res.headers.get("x-orb-ignored")).toBe("bot_author");
  });

  it("ignores unsupported events with 204 + x-orb-ignored reason", async () => {
    const res = await post(h, commentPayload(), { "x-github-event": "push", "x-github-delivery": "test-5" });
    expect(res.status).toBe(204);
    expect(res.headers.get("x-orb-ignored")).toBe("wrong_event");
  });
});

describe("orchestrator — missing secret", () => {
  it("returns 500 when WEBHOOK_SECRET is absent", async () => {
    const h = boot({ secret: "" });
    try {
      const res = await fetch(`${h.base}/github/webhook`, { method: "POST", body: "{}" });
      expect(res.status).toBe(500);
    } finally {
      h.orch.server.stop(true);
    }
  });
});
