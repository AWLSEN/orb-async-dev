#!/usr/bin/env bun
// Orchestrator entry point. Runs on the Orb computer, listens for inbound
// HTTP (Orb wakes the computer when a request arrives), routes GitHub
// webhooks to sub-agents. Batch 1 wires only /health; /github/webhook is
// implemented in batch 2.

export interface OrchestratorOpts {
  port?: number;
}

export function createOrchestrator(opts: OrchestratorOpts = {}): ReturnType<typeof Bun.serve> {
  const port = opts.port ?? Number.parseInt(process.env.ORB_PORT ?? "8000", 10);
  return Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/health") {
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (req.method === "POST" && url.pathname === "/github/webhook") {
        return new Response("not yet implemented (batch 2)", { status: 501 });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

if (import.meta.main) {
  const server = createOrchestrator();
  console.error(`[orchestrator] listening on :${server.port}`);
}
