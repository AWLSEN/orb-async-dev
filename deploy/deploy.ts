#!/usr/bin/env bun
// End-to-end idempotent deploy of orb-async-dev to Orb Cloud.
//
// Usage:
//   bun run deploy              # deploy (create | update | build | start)
//   bun run deploy status       # print current computer + agent status
//   bun run deploy promote      # force wake
//   bun run deploy demote       # force sleep
//   bun run deploy destroy      # delete the computer (prompts once)
//
// Every step persists to .orb-state/ so re-running is safe.

import path from "node:path";
import { OrbClient } from "./orb-api.ts";
import { fromEnv, renderOrbToml } from "./orb-toml.ts";
import { State, loadDotEnvInto } from "./state.ts";

const ROOT = process.cwd();
const STATE = new State(path.join(ROOT, ".orb-state"));

function log(msg: string): void {
  process.stderr.write(`[deploy] ${msg}\n`);
}

async function ensureApiKey(client: OrbClient): Promise<string> {
  const fromEnvVar = process.env.ORB_API_KEY?.trim();
  if (fromEnvVar) {
    client.apiKey = fromEnvVar;
    return fromEnvVar;
  }
  const saved = await STATE.read("api-key");
  if (saved) {
    client.apiKey = saved;
    return saved;
  }
  const email = process.env.ORB_REGISTER_EMAIL?.trim();
  if (!email) throw new Error("set ORB_API_KEY, or ORB_REGISTER_EMAIL to auto-register");
  log(`registering new api key for ${email}`);
  const { api_key } = await client.register(email);
  await STATE.write("api-key", api_key, { secret: true });
  return api_key;
}

function collectSecrets(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v) out[n] = v;
    else missing.push(n);
  }
  if (missing.length) throw new Error(`missing required secret env vars: ${missing.join(", ")}`);
  return out;
}

async function cmdDeploy(): Promise<void> {
  await loadDotEnvInto(path.join(ROOT, ".env"), process.env as Record<string, string | undefined>);

  const client = new OrbClient(process.env.ORB_BASE_URL ? { baseUrl: process.env.ORB_BASE_URL } : {});
  await ensureApiKey(client);

  const input = fromEnv(process.env as Record<string, string | undefined>);
  const runtime_mb = input.runtimeMb;
  const disk_mb = input.diskMb;

  let computerId = await STATE.read("computer-id");
  let shortId = await STATE.read("short-id");
  if (!computerId) {
    log(`creating computer ${input.computerName} (runtime=${runtime_mb}MB disk=${disk_mb}MB)`);
    const comp = await client.createComputer({ name: input.computerName, runtime_mb, disk_mb });
    computerId = comp.computer_id ?? comp.id;
    if (!computerId) throw new Error("create computer returned no computer_id/id");
    await STATE.write("computer-id", computerId);
    if (comp.short_id) {
      shortId = comp.short_id;
      await STATE.write("short-id", shortId);
    }
    log(`computer created: ${computerId} (short=${shortId ?? "?"})`);
  } else {
    log(`reusing computer ${computerId}`);
  }

  const toml = renderOrbToml(input);
  await STATE.write("orb.toml", toml);
  log(`uploading orb.toml (${toml.length} bytes)`);
  await client.uploadConfig(computerId, toml);

  log(`building (clone + install; this may take several minutes)`);
  const buildSecrets = process.env.GITHUB_TOKEN ? { GITHUB_TOKEN: process.env.GITHUB_TOKEN } : undefined;
  await client.build(
    computerId,
    buildSecrets
      ? { orgSecrets: buildSecrets, signal: AbortSignal.timeout(600_000) }
      : { signal: AbortSignal.timeout(600_000) },
  );

  const secrets = collectSecrets(input.secrets);
  log(`starting agent with secrets: ${Object.keys(secrets).sort().join(", ")}`);
  const agent = await client.startAgent(computerId, { orgSecrets: secrets });
  await STATE.write("agent-port", String(agent.port));
  if (agent.pid !== undefined) await STATE.write("agent-pid", String(agent.pid));

  const liveUrl = client.liveUrl(shortId ? { short_id: shortId, name: "", runtime_mb: 0, disk_mb: 0 } : computerId);
  await STATE.write("live-url", liveUrl);
  log(`deployed → ${liveUrl} (agent port=${agent.port})`);
  console.log(liveUrl);
}

async function cmdStatus(): Promise<void> {
  await loadDotEnvInto(path.join(ROOT, ".env"), process.env as Record<string, string | undefined>);
  const client = new OrbClient(process.env.ORB_BASE_URL ? { baseUrl: process.env.ORB_BASE_URL } : {});
  await ensureApiKey(client);
  const computerId = await STATE.read("computer-id");
  if (!computerId) {
    log("not deployed yet");
    process.exit(1);
  }
  const comp = await client.getComputer(computerId);
  const agents = await client.listAgents(computerId).catch(() => []);
  const liveUrl = client.liveUrl(comp);
  console.log(JSON.stringify({ computer: comp, agents, liveUrl }, null, 2));
}

async function cmdPromote(): Promise<void> {
  const client = await clientWithState();
  const id = await requireComputerId();
  const port = await requireAgentPort();
  await client.promote(id, port);
  log(`promoted ${id} port=${port}`);
}

async function cmdDemote(): Promise<void> {
  const client = await clientWithState();
  const id = await requireComputerId();
  const port = await requireAgentPort();
  await client.demote(id, port);
  log(`demoted ${id} port=${port}`);
}

async function requireAgentPort(): Promise<number> {
  const s = await STATE.read("agent-port");
  if (!s) throw new Error(".orb-state/agent-port not found — run `bun run deploy` first");
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) throw new Error(`.orb-state/agent-port invalid: ${s}`);
  return n;
}

async function cmdDestroy(): Promise<void> {
  const client = await clientWithState();
  const id = await requireComputerId();
  if (process.env.CONFIRM !== "yes") {
    log(`refusing to destroy ${id} — re-run with CONFIRM=yes`);
    process.exit(2);
  }
  await client.deleteComputer(id);
  log(`destroyed ${id}`);
}

async function clientWithState(): Promise<OrbClient> {
  await loadDotEnvInto(path.join(ROOT, ".env"), process.env as Record<string, string | undefined>);
  const client = new OrbClient(process.env.ORB_BASE_URL ? { baseUrl: process.env.ORB_BASE_URL } : {});
  await ensureApiKey(client);
  return client;
}

async function requireComputerId(): Promise<string> {
  const id = await STATE.read("computer-id");
  if (!id) throw new Error(".orb-state/computer-id not found — run `bun run deploy` first");
  return id;
}

async function main(): Promise<void> {
  const sub = process.argv[2] ?? "deploy";
  try {
    switch (sub) {
      case "deploy":
        await cmdDeploy();
        break;
      case "status":
        await cmdStatus();
        break;
      case "promote":
        await cmdPromote();
        break;
      case "demote":
        await cmdDemote();
        break;
      case "destroy":
        await cmdDestroy();
        break;
      default:
        process.stderr.write(`unknown subcommand: ${sub}\n`);
        process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`[deploy] ERROR: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
