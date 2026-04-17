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
import { State, loadDotEnvInto, mbFromSize } from "./state.ts";

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
  const runtime_mb = mbFromSize(input.runtime);
  const disk_mb = mbFromSize(input.disk);

  let computerId = await STATE.read("computer-id");
  if (!computerId) {
    log(`creating computer ${input.computerName} (runtime=${runtime_mb}MB disk=${disk_mb}MB)`);
    const comp = await client.createComputer({ name: input.computerName, runtime_mb, disk_mb });
    computerId = comp.id;
    await STATE.write("computer-id", computerId);
    log(`computer created: ${computerId}`);
  } else {
    log(`reusing computer ${computerId}`);
  }

  const toml = renderOrbToml(input);
  await STATE.write("orb.toml", toml);
  log(`uploading orb.toml (${toml.length} bytes)`);
  await client.uploadConfig(computerId, toml);

  log(`building (clone + install; this may take several minutes)`);
  await client.build(computerId, AbortSignal.timeout(600_000));

  const secrets = collectSecrets(input.secrets);
  log(`starting agent with secrets: ${Object.keys(secrets).sort().join(", ")}`);
  const agent = await client.startAgent(computerId, secrets);
  await STATE.write("agent-id", agent.id);

  const liveUrl = client.liveUrl(computerId);
  await STATE.write("live-url", liveUrl);
  log(`deployed → ${liveUrl}`);
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
  const agentId = (await STATE.read("agent-id")) ?? "(none)";
  const liveUrl = client.liveUrl(computerId);
  console.log(JSON.stringify({ computer: comp, agentId, liveUrl }, null, 2));
}

async function cmdPromote(): Promise<void> {
  const client = await clientWithState();
  const id = await requireComputerId();
  await client.promote(id);
  log(`promoted ${id}`);
}

async function cmdDemote(): Promise<void> {
  const client = await clientWithState();
  const id = await requireComputerId();
  await client.demote(id);
  log(`demoted ${id}`);
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
