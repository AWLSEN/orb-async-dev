#!/usr/bin/env bun
// Orchestrator entry point. Runs on the Orb computer, listens for inbound
// HTTP (Orb wakes the computer when a request arrives), routes GitHub
// webhooks through the verify -> route -> enqueue pipeline.
//
// Task execution itself lives in batch 3; for batch 2 we verify + route +
// post an ack comment so you can see the agent receive webhooks end-to-end.

import { GithubClient } from "../adapters/github-client.ts";
import { routeEvent, type TaskRequest } from "../adapters/event-router.ts";
import { WEBHOOK_SIGNATURE_HEADER, verifyWebhook } from "../adapters/webhook-verify.ts";

export interface OrchestratorOpts {
  port?: number;
  webhookSecret?: string;
  github?: GithubClient;
  /** Enqueue work. Batch 3 swaps in the real per-task sub-agent spawner. */
  onTask?: (task: TaskRequest) => void | Promise<void>;
  /** Comment IDs already seen (dedup across webhook retries). */
  seen?: Set<number>;
  /** Injectable logger for tests. */
  log?: (line: string) => void;
}

export interface Orchestrator {
  server: ReturnType<typeof Bun.serve>;
  seen: Set<number>;
}

export function createOrchestrator(opts: OrchestratorOpts = {}): Orchestrator {
  const port = opts.port ?? Number.parseInt(process.env.ORB_PORT ?? "8000", 10);
  const secret = opts.webhookSecret ?? process.env.WEBHOOK_SECRET ?? "";
  const seen = opts.seen ?? new Set<number>();
  const log = opts.log ?? ((line: string) => process.stderr.write(`[orchestrator] ${line}\n`));

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }

      if (req.method === "POST" && url.pathname === "/github/webhook") {
        return handleWebhook(req, { secret, seen, github: opts.github, onTask: opts.onTask, log });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return { server, seen };
}

async function handleWebhook(
  req: Request,
  ctx: {
    secret: string;
    seen: Set<number>;
    github: GithubClient | undefined;
    onTask: OrchestratorOpts["onTask"];
    log: (line: string) => void;
  },
): Promise<Response> {
  const event = req.headers.get("x-github-event");
  const delivery = req.headers.get("x-github-delivery") ?? "(no-delivery-id)";
  const sig = req.headers.get(WEBHOOK_SIGNATURE_HEADER);
  const body = await req.text();

  if (!ctx.secret) {
    ctx.log(`refuse ${delivery}: no WEBHOOK_SECRET configured`);
    return jsonError(500, "server misconfigured: no WEBHOOK_SECRET");
  }

  const verified = await verifyWebhook({ header: sig, body, secret: ctx.secret });
  if (!verified.ok) {
    ctx.log(`reject ${delivery}: ${verified.reason}`);
    return jsonError(401, `signature check failed: ${verified.reason ?? "unknown"}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    ctx.log(`reject ${delivery}: invalid json`);
    return jsonError(400, "invalid json");
  }

  const routed = routeEvent(event ?? "", payload, { ignoreAuthors: ["orb-async-dev[bot]", "orb-bot"] });
  if (!routed.ok) {
    ctx.log(`ignore ${delivery} (${event}): ${routed.reason}`);
    return new Response(null, { status: 204, headers: { "x-orb-ignored": routed.reason } });
  }

  const task = routed.task;
  const dedupKey = taskDedupKey(task);
  if (ctx.seen.has(dedupKey)) {
    ctx.log(`dedup ${delivery}: already processed ${dedupKey}`);
    return new Response(null, { status: 204, headers: { "x-orb-ignored": "duplicate" } });
  }
  ctx.seen.add(dedupKey);

  ctx.log(`accept ${delivery} ${task.source.kind} repo=${task.repo} author=${task.author} task=${truncate(task.taskText, 80)}`);

  // Fire-and-forget ack + enqueue. Errors in the background don't block the 202.
  void ackAndEnqueue(task, ctx).catch((e) => ctx.log(`bg error: ${(e as Error).message}`));

  return new Response(JSON.stringify({ accepted: true, delivery }), {
    status: 202,
    headers: { "content-type": "application/json" },
  });
}

async function ackAndEnqueue(
  task: TaskRequest,
  ctx: { github: GithubClient | undefined; onTask: OrchestratorOpts["onTask"]; log: (line: string) => void },
): Promise<void> {
  if (ctx.github) {
    const issueNumber = task.source.kind === "pr_review_comment" ? task.source.pullNumber : task.source.issueNumber;
    const ack = `Task queued. I'll reply when I have something.\n\n> ${truncate(task.rawMention, 240)}`;
    try {
      await ctx.github.postIssueComment(issueNumber, ack);
    } catch (e) {
      ctx.log(`ack failed for ${task.repo}#${issueNumber}: ${(e as Error).message}`);
    }
  }
  if (ctx.onTask) await ctx.onTask(task);
}

function taskDedupKey(task: TaskRequest): number {
  switch (task.source.kind) {
    case "issue":
      return task.source.issueNumber * -1; // separate namespace from comment IDs (comment IDs are positive)
    case "issue_comment":
      return task.source.commentId;
    case "pr_review_comment":
      return task.source.commentId;
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

if (import.meta.main) {
  let github: GithubClient | undefined;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  if (token && repo) github = new GithubClient({ token, repo });
  const orch = createOrchestrator(github ? { github } : {});
  console.error(`[orchestrator] listening on :${orch.server.port}`);
}
