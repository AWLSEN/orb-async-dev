// Shared types for the 9-gate PR verifier. Each gate produces a GateResult;
// the verifier runs them in order and stops on the first hard failure.

import type { Runner } from "../runner.ts";
import type { DetectedStack } from "./stack-detect.ts";

export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
}

export interface DiffStats {
  files: DiffFile[];
  totalAdded: number;
  totalDeleted: number;
}

export interface VerifierContext {
  workDir: string;
  baseBranch: string;
  taskText: string;
  diff: DiffStats;
  stack: DetectedStack;
  runner: Runner;
  /** Optional: used by LLM-backed gates (self-review, red-team). */
  anthropicModel?: string;
}

export interface GateResult {
  name: string;
  pass: boolean;
  /** One-line reason shown in logs and PR body. */
  reason: string;
  /** Verbose details (stdout/stderr/snippet) — stored, not shown in PR body. */
  details?: string;
  /** "hard" fails block the PR; "soft" fails become warnings in the PR body. */
  severity: "hard" | "soft";
}

export type Gate = (ctx: VerifierContext) => Promise<GateResult>;

/** Parse `git diff --numstat` output into a DiffStats. */
export function parseNumstat(numstat: string): DiffStats {
  const files: DiffFile[] = [];
  let totalAdded = 0;
  let totalDeleted = 0;
  for (const rawLine of numstat.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\t+/);
    if (parts.length < 3) continue;
    const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0] ?? "0", 10);
    const deleted = parts[1] === "-" ? 0 : Number.parseInt(parts[1] ?? "0", 10);
    const path = parts.slice(2).join("\t");
    if (Number.isNaN(added) || Number.isNaN(deleted)) continue;
    files.push({ path, added, deleted });
    totalAdded += added;
    totalDeleted += deleted;
  }
  return { files, totalAdded, totalDeleted };
}

/** True when a path looks like a test file (framework-agnostic heuristic). */
export function isTestPath(p: string): boolean {
  return (
    /(^|\/)tests?\//i.test(p) ||
    /(^|\/)__tests__\//.test(p) ||
    /\.(test|spec)\.(js|ts|jsx|tsx|py|go|rs|mjs|cjs)$/i.test(p) ||
    /_test\.(go|py)$/i.test(p)
  );
}

/** Rough heuristic: a path looks like src code (not config/docs/lockfile). */
export function isSrcPath(p: string): boolean {
  if (isTestPath(p)) return false;
  if (/^(\.github|\.vscode|\.husky|\.devcontainer)\//.test(p)) return false;
  if (/(^|\/)(README|CHANGELOG|LICENSE|NOTICE|AUTHORS|CONTRIBUTING)(\.\w+)?$/i.test(p)) return false;
  if (/\.(md|txt|rst|adoc)$/i.test(p)) return false;
  if (/(^|\/)package(-lock)?\.json$/.test(p)) return false;
  if (/(^|\/)(bun\.lock|bun\.lockb|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock|go\.sum)$/.test(p)) return false;
  if (/\.(lock|lockfile)$/i.test(p)) return false;
  return true;
}
