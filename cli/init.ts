#!/usr/bin/env bun
// `npx orb-async-dev init` — four-question wizard that writes .env, renders
// orb.toml, and deploys to the user's own Orb Cloud account. Reads
// existing .env values so re-running is idempotent (lets you bump config).

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OrbClient } from "../deploy/orb-api.ts";

interface Answers {
  ghRepo: string;
  ghToken: string;
  orbApiKey: string;
  anthropicAuthToken: string;
  anthropicBaseUrl: string;
  webhookSecret: string;
  cap: string;
}

const QUESTIONS = [
  { key: "ghRepo", prompt: "GitHub repo (owner/name) to connect:", required: true },
  { key: "ghToken", prompt: "GitHub PAT (repo + issues + pull_requests scope):", required: true, secret: true },
  { key: "orbApiKey", prompt: "Orb API key (leave blank to auto-register):", required: false, secret: true },
  { key: "anthropicAuthToken", prompt: "Anthropic key OR Z.AI/OpenRouter proxy token:", required: true, secret: true },
  { key: "anthropicBaseUrl", prompt: "LLM base URL [default https://api.anthropic.com]:", required: false, default: "https://api.anthropic.com" },
  { key: "webhookSecret", prompt: "Webhook shared secret (leave blank to generate):", required: false, secret: true },
  { key: "cap", prompt: "Daily cost cap in USD [default 5]:", required: false, default: "5" },
] as const;

export async function loadExistingEnv(envPath: string): Promise<Partial<Answers>> {
  if (!existsSync(envPath)) return {};
  const body = await readFile(envPath, "utf8");
  const map: Record<string, string> = {};
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    map[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  const out: Partial<Answers> = {};
  if (map.GITHUB_REPO) out.ghRepo = map.GITHUB_REPO;
  if (map.GITHUB_TOKEN) out.ghToken = map.GITHUB_TOKEN;
  if (map.ORB_API_KEY) out.orbApiKey = map.ORB_API_KEY;
  const authValue = map.ANTHROPIC_AUTH_TOKEN || map.ANTHROPIC_API_KEY;
  if (authValue) out.anthropicAuthToken = authValue;
  if (map.ANTHROPIC_BASE_URL) out.anthropicBaseUrl = map.ANTHROPIC_BASE_URL;
  if (map.WEBHOOK_SECRET) out.webhookSecret = map.WEBHOOK_SECRET;
  if (map.DAILY_COST_CAP_USD) out.cap = map.DAILY_COST_CAP_USD;
  return out;
}

export function renderEnvFile(a: Answers): string {
  const useAuthToken =
    !!a.anthropicBaseUrl && a.anthropicBaseUrl !== "https://api.anthropic.com";
  const lines = [
    "# --- Orb Cloud ---",
    `ORB_API_KEY=${a.orbApiKey}`,
    "ORB_BASE_URL=https://api.orbcloud.dev",
    "ORB_COMPUTER_NAME=orb-async-dev",
    "",
    "# --- GitHub ---",
    `GITHUB_TOKEN=${a.ghToken}`,
    `GITHUB_REPO=${a.ghRepo}`,
    `WEBHOOK_SECRET=${a.webhookSecret}`,
    "",
    "# --- LLM ---",
    useAuthToken ? `ANTHROPIC_AUTH_TOKEN=${a.anthropicAuthToken}` : `ANTHROPIC_API_KEY=${a.anthropicAuthToken}`,
    `ANTHROPIC_BASE_URL=${a.anthropicBaseUrl}`,
    "ANTHROPIC_MODEL=claude-opus-4-7",
    "",
    "# --- Health ---",
    `DAILY_COST_CAP_USD=${a.cap}`,
    "",
  ];
  return lines.join("\n");
}

export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

// --- interactive flow (only when run as a script) ------------------------

async function prompt(question: string, opts: { secret?: boolean } = {}): Promise<string> {
  process.stderr.write(`${question} `);
  for await (const chunk of Bun.stdin.stream()) {
    const input = new TextDecoder().decode(chunk);
    if (opts.secret && input.trim()) process.stderr.write("********\n");
    return input.split(/\r?\n/)[0] ?? "";
  }
  return "";
}

async function runWizard(): Promise<void> {
  const cwd = process.cwd();
  const envPath = path.join(cwd, ".env");
  const existing = await loadExistingEnv(envPath);

  process.stderr.write("\norb-async-dev init — four quick questions.\n\n");
  const answers: Answers = {
    ghRepo: "",
    ghToken: "",
    orbApiKey: "",
    anthropicAuthToken: "",
    anthropicBaseUrl: "",
    webhookSecret: "",
    cap: "",
  };

  for (const q of QUESTIONS) {
    const current = (existing as Record<string, string | undefined>)[q.key];
    const hint = current ? ` [${mask(current, q.key !== "ghRepo" && q.key !== "anthropicBaseUrl" && q.key !== "cap")}]` : "";
    const isSecret = (q as { secret?: boolean }).secret === true;
    const line = await prompt(`${q.prompt}${hint}`, isSecret ? { secret: true } : {});
    const value = line.trim() || current || ("default" in q ? q.default : "");
    if (q.required && !value) throw new Error(`${q.key} is required`);
    (answers as unknown as Record<string, string>)[q.key] = value;
  }

  if (!answers.webhookSecret) answers.webhookSecret = generateWebhookSecret();
  if (!answers.anthropicBaseUrl) answers.anthropicBaseUrl = "https://api.anthropic.com";

  // Auto-register if no ORB_API_KEY supplied.
  if (!answers.orbApiKey) {
    const email = process.env.ORB_REGISTER_EMAIL;
    if (!email) {
      process.stderr.write("No ORB_API_KEY supplied. Set ORB_REGISTER_EMAIL and re-run to auto-register, or obtain a key at app.orbcloud.dev.\n");
      process.exit(2);
    }
    const client = new OrbClient();
    const r = await client.register(email);
    answers.orbApiKey = r.api_key;
    process.stderr.write(`registered new Orb key for ${email}\n`);
  }

  await writeFile(envPath, renderEnvFile(answers));
  process.stderr.write(`\nwrote ${envPath}. next steps:\n`);
  process.stderr.write(`  1. bun install\n`);
  process.stderr.write(`  2. bun run deploy\n`);
  process.stderr.write(`  3. register the webhook at https://github.com/${answers.ghRepo}/settings/hooks\n`);
  process.stderr.write(`     (payload URL: the {short_id}.orbcloud.dev URL deploy printed, path /github/webhook, secret above, events: Issues + Issue comments + PR review comments)\n`);
}

function mask(s: string, hide: boolean): string {
  if (!s) return "";
  if (!hide) return s;
  return s.length <= 6 ? "***" : `${s.slice(0, 3)}…${s.slice(-3)}`;
}

// create the work root the runtime expects — keeps first deploy clean
await mkdir(path.join(process.cwd(), "work"), { recursive: true }).catch(() => undefined);

if (import.meta.main) {
  runWizard().catch((e) => {
    process.stderr.write(`init failed: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
