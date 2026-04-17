#!/usr/bin/env bun
// Orchestrator entry point. Runs on the Orb computer, listens for inbound
// HTTP (Orb wakes the computer when a request arrives), routes GitHub
// webhooks through the verify -> route -> enqueue pipeline.
//
// Task execution itself lives in batch 3; for batch 2 we verify + route +
// post an ack comment so you can see the agent receive webhooks end-to-end.

import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { GithubClient } from "../adapters/github-client.ts";
import { routeEvent, type TaskRequest } from "../adapters/event-router.ts";
import { WEBHOOK_SIGNATURE_HEADER, verifyWebhook } from "../adapters/webhook-verify.ts";
import { TaskRunner } from "./task-runner.ts";
import { createScheduler } from "./health/scheduler.ts";
import { runCanaryAndNotify } from "./health/canary.ts";
import { createCostWatchdog } from "./health/cost-watchdog.ts";
import { createTaskRegistry, reapStuckTasks } from "./health/task-registry.ts";
import { createLogStore, renderLogsHtml, type LogStore } from "./log-store.ts";
import { OrbClient } from "../deploy/orb-api.ts";

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
  /** When provided, /logs renders an HTML page of recent entries. */
  logStore?: LogStore;
}

export interface Orchestrator {
  server: ReturnType<typeof Bun.serve>;
  seen: Set<number>;
  logStore?: LogStore;
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

      if (req.method === "GET" && url.pathname === "/logs") {
        if (!opts.logStore) return new Response("logs disabled", { status: 404 });
        return new Response(renderLogsHtml(opts.logStore), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const result: Orchestrator = { server, seen };
  if (opts.logStore) result.logStore = opts.logStore;
  return result;
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

/** Boot an orchestrator wired to real GitHub + Anthropic clients from env.
 * Also starts background health loops (canary hourly, cost 10min, reaper 5min).
 */
export function createOrchestratorFromEnv(): Orchestrator & { stopHealthLoops: () => void } {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
  const orbApiKey = process.env.ORB_API_KEY;
  const orbBaseUrl = process.env.ORB_BASE_URL;
  const dailyCapUsdEnv = process.env.DAILY_COST_CAP_USD;
  const dailyCapUsd = dailyCapUsdEnv ? Number.parseFloat(dailyCapUsdEnv) : 5;

  if (!token || !repo) {
    throw new Error("GITHUB_TOKEN + GITHUB_REPO required to run the orchestrator");
  }
  if (!apiKey && !authToken) {
    throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN required");
  }

  const github = new GithubClient({ token, repo });
  const anthropic = new Anthropic({
    ...(authToken ? { authToken } : { apiKey: apiKey! }),
    ...(baseURL ? { baseURL } : {}),
  });

  const registry = createTaskRegistry();
  const logStore = createLogStore(500);
  const pushLog = (line: string): void => {
    logStore.push(line);
    process.stderr.write(`${line}\n`);
  };
  const scheduler = createScheduler(undefined, (name, err) => {
    pushLog(`[health:${name}] ${(err as Error).message}`);
  });

  // Cost watchdog (only if Orb API key is available).
  let costWd: ReturnType<typeof createCostWatchdog> | undefined;
  if (orbApiKey) {
    const orb = new OrbClient(orbBaseUrl ? { apiKey: orbApiKey, baseUrl: orbBaseUrl } : { apiKey: orbApiKey });
    costWd = createCostWatchdog({
      orb,
      dailyCapUsd,
      onTrip: (s) => { pushLog(`[cost-watchdog] TRIPPED at $${s.usd.toFixed(2)} >= $${dailyCapUsd}`); },
    });
    scheduler.schedule({
      name: "cost-watchdog",
      intervalMs: 10 * 60_000,
      jitterMs: 60_000,
      run: async () => {
        await costWd!.tick();
      },
    });
  }

  const taskRunner = new TaskRunner({
    github,
    anthropic,
    workRoot: path.join(process.cwd(), "work"),
    model,
    githubToken: token,
    registry,
    ...(costWd ? { isCostTripped: () => costWd!.isTripped() } : {}),
  });

  // Canary (once per hour, 5min jitter).
  scheduler.schedule({
    name: "canary",
    intervalMs: 60 * 60_000,
    jitterMs: 5 * 60_000,
    firstRunAt: Date.now() + 30_000, // wait 30s after boot so the first webhook isn't delayed
    run: async () => {
      await runCanaryAndNotify({
        workRoot: path.join(process.cwd(), "work"),
        runner: (await import("./runner.ts")).nodeRunner,
        repoName: repo,
        cloneUrl: `https://x-access-token:${token}@github.com/${repo}.git`,
        defaultBranch: await github.getDefaultBranch().catch(() => "main"),
        notify: (m) => { pushLog(`[canary] ${m}`); },
      });
    },
  });

  // Stuck-task reaper (every 5min, max-age 2h).
  scheduler.schedule({
    name: "reaper",
    intervalMs: 5 * 60_000,
    run: async () => {
      await reapStuckTasks({
        registry,
        maxRuntimeMs: 2 * 60 * 60_000,
        onReap: (e, reason) => { pushLog(`[reaper] cancelled ${e.id}: ${reason}`); },
      });
    },
  });

  const orch = createOrchestrator({
    github,
    logStore,
    log: pushLog,
    onTask: (t) => {
      pushLog(`[orchestrator] accepted task from @${t.author} on ${t.repo}`);
      taskRunner
        .run(t)
        .then((r) => pushLog(`[orchestrator] task done branch=${r.branch} pr=${r.pullNumber ?? "-"}`))
        .catch((e) => pushLog(`[orchestrator] task error: ${(e as Error).message}`));
    },
  });

  return { ...orch, stopHealthLoops: () => scheduler.stopAll() };
}

if (import.meta.main) {
  const orch = createOrchestratorFromEnv();
  console.error(`[orchestrator] listening on :${orch.server.port}`);
}
