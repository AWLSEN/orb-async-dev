// Secret-scan gate. Scans the unified diff for three kinds of hits:
//   1. Known-shape tokens (GitHub PAT, AWS access key, private-key header, etc.).
//   2. High-entropy strings >= 20 chars appearing on added lines.
//   3. Added lines that define a well-known secret env name with a literal value.
//
// Runs on the *added* lines only so old, already-committed content doesn't
// keep failing a re-run. Hard severity — if anything matches, we block.

import type { Gate, GateResult, VerifierContext } from "./types.ts";

interface Hit {
  reason: string;
  line: string;
}

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "GitHub PAT",          re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: "GitHub OAuth",        re: /\bgho_[A-Za-z0-9]{36,}\b/ },
  { name: "GitHub install",      re: /\bghs_[A-Za-z0-9]{36,}\b/ },
  { name: "GitHub fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { name: "AWS access key",      re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "AWS secret key",      re: /\baws(?:_|\s+)secret[^=]*=\s*["']?[A-Za-z0-9+/=]{40}\b/i },
  { name: "Anthropic key",       re: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/ },
  { name: "OpenAI key",          re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: "Slack bot token",     re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Stripe secret",       re: /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "Google API key",      re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "PEM private key",     re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/ },
  { name: "JWT (3 segments)",    re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/ },
];

const SECRET_ENV_NAMES =
  /\b(API|ACCESS|SECRET|PRIVATE|CLIENT|AUTH|BEARER|SESSION|PASSWORD|PASSWD|TOKEN|KEY)(_[A-Z0-9]+)*\s*[:=]\s*["']?([^"'\s]{8,})/;

/** Shannon entropy in bits/char. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq: Record<string, number> = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  let e = 0;
  for (const k of Object.keys(freq)) {
    const p = freq[k]! / s.length;
    e -= p * Math.log2(p);
  }
  return e;
}

/** Pull the longest continuous "token-like" substring (alnum + [-_./+=]). */
function longestToken(line: string): string {
  const matches = line.match(/[A-Za-z0-9_\-./+=]+/g) ?? [];
  return matches.reduce((best, cur) => (cur.length > best.length ? cur : best), "");
}

/** Added lines in a unified diff: those that start with "+" (not "+++"). */
export function extractAddedLines(unifiedDiff: string): string[] {
  const added: string[] = [];
  for (const raw of unifiedDiff.split(/\r?\n/)) {
    if (raw.startsWith("+++")) continue;
    if (raw.startsWith("+")) added.push(raw.slice(1));
  }
  return added;
}

/** Lock-file / binary patches generate noise; skip their hunks. */
function isNoisyFileHeader(line: string): boolean {
  return /^(?:diff --git|index |Binary files?)/.test(line);
}

export function scanDiffForSecrets(unifiedDiff: string, opts: { entropyThreshold?: number; minTokenLen?: number } = {}): Hit[] {
  const entropyThreshold = opts.entropyThreshold ?? 4.5;
  const minTokenLen = opts.minTokenLen ?? 20;
  const hits: Hit[] = [];

  let currentFile: string | null = null;
  let skipCurrent = false;
  for (const raw of unifiedDiff.split(/\r?\n/)) {
    // Track file headers so lockfile hunks can be skipped.
    const m = raw.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (m) {
      currentFile = m[2] ?? null;
      skipCurrent = isLockOrBinary(currentFile);
      continue;
    }
    if (isNoisyFileHeader(raw)) continue;
    if (skipCurrent) continue;
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const line = raw.slice(1);

    // 1. Known patterns.
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        hits.push({ reason: p.name, line: truncate(line, 160) });
      }
    }
    // 2. Entropy on the longest token.
    const tok = longestToken(line);
    if (tok.length >= minTokenLen && shannonEntropy(tok) >= entropyThreshold) {
      // 3. Higher confidence when accompanied by a secret-like env name.
      if (SECRET_ENV_NAMES.test(line)) {
        hits.push({ reason: `high-entropy literal in secret-named assignment (${tok.length} chars)`, line: truncate(line, 160) });
      }
    }
  }
  return hits;
}

function isLockOrBinary(filePath: string | null): boolean {
  if (!filePath) return false;
  return (
    /(^|\/)(bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock|Pipfile\.lock)$/i.test(filePath) ||
    /\.(png|jpe?g|gif|webp|pdf|zip|gz|tar|tgz|woff2?|ttf|mp[34]|mov|wasm|ico)$/i.test(filePath)
  );
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export interface SecretGateOpts {
  maxDiffBytes?: number;
}

export function secretGate(opts: SecretGateOpts = {}): Gate {
  const max = opts.maxDiffBytes ?? 500_000;
  return async (ctx: VerifierContext): Promise<GateResult> => {
    const res = await ctx
      .runner({ cmd: ["git", "diff", `origin/${ctx.baseBranch}...HEAD`], cwd: ctx.workDir, timeoutMs: 60_000 })
      .catch((e) => {
        const err = e as { result?: { stdout: string; stderr: string; code: number } };
        return err.result ?? { stdout: "", stderr: String((e as Error).message), code: 1 };
      });
    const diff = res.stdout.length > max ? res.stdout.slice(0, max) : res.stdout;
    if (!diff) {
      return { name: "secret_scan", pass: true, reason: "no diff", severity: "hard" };
    }
    const hits = scanDiffForSecrets(diff);
    if (hits.length === 0) {
      return { name: "secret_scan", pass: true, reason: "clean", severity: "hard" };
    }
    const summary = hits
      .slice(0, 3)
      .map((h) => `- ${h.reason}: ${h.line}`)
      .join("\n");
    return {
      name: "secret_scan",
      pass: false,
      reason: `${hits.length} potential secret(s); first: ${hits[0]!.reason}`,
      details: summary,
      severity: "hard",
    };
  };
}
