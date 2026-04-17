// Canary health probe. Runs periodically and verifies the pipeline is alive:
// the warm repo clone exists, `git status` works, stack detection still
// recognizes the repo, and the test command runs. No LLM calls — deterministic
// so a failure always means infrastructure drift, not model flakiness.
//
// Wired by orchestrator bootstrap into the Scheduler with a conservative
// hourly cadence + 5-minute jitter so dozens of canaries don't sync.

import path from "node:path";
import { WorktreeManager } from "../worktree.ts";
import { detectStack } from "../verifier/stack-detect.ts";
import type { Runner } from "../runner.ts";

export interface CanaryDeps {
  workRoot: string;
  runner: Runner;
  repoName: string;
  cloneUrl: string;
  defaultBranch: string;
  /** Called on failure only; no-op when unset. */
  notify?: (msg: string) => Promise<void> | void;
}

export type CanaryStage = "clone" | "status" | "detect" | "test";

export interface CanaryResult {
  ok: boolean;
  /** Stage that failed, or "test" for the final-pass label. */
  stage: CanaryStage;
  /** One-line reason (shown in notifications + logs). */
  reason: string;
  /** Optional verbose tail (last few KB of stderr/stdout). */
  details?: string;
  /** Total wall-clock of the probe. */
  durationMs: number;
}

export async function runCanary(deps: CanaryDeps): Promise<CanaryResult> {
  const started = Date.now();
  const wt = new WorktreeManager({ workRoot: deps.workRoot, runner: deps.runner });

  try {
    await wt.ensureRepo({ repoName: deps.repoName, cloneUrl: deps.cloneUrl, defaultBranch: deps.defaultBranch });
  } catch (e) {
    return finish({ ok: false, stage: "clone", reason: (e as Error).message, started });
  }

  const repoDir = path.join(deps.workRoot, deps.repoName.replace(/[^A-Za-z0-9._-]+/g, "-"));
  try {
    const res = await deps.runner({ cmd: ["git", "status", "--porcelain"], cwd: repoDir, timeoutMs: 30_000 });
    if (res.code !== 0) {
      return finish({ ok: false, stage: "status", reason: `git status exit=${res.code}`, details: tail(res.stderr), started });
    }
  } catch (e) {
    return finish({ ok: false, stage: "status", reason: (e as Error).message, started });
  }

  const stack = detectStack(repoDir);
  if (stack.stack === "unknown") {
    return finish({ ok: false, stage: "detect", reason: "stack detection returned unknown", started });
  }

  if (stack.test) {
    try {
      const res = await deps.runner({ cmd: ["bash", "-c", stack.test], cwd: repoDir, timeoutMs: 300_000 });
      if (res.code !== 0) {
        return finish({ ok: false, stage: "test", reason: `tests exit=${res.code}`, details: tail(res.stderr || res.stdout), started });
      }
    } catch (e) {
      const err = e as { result?: { stdout: string; stderr: string; code: number } };
      if (err.result) {
        return finish({ ok: false, stage: "test", reason: `tests exit=${err.result.code}`, details: tail(err.result.stderr), started });
      }
      return finish({ ok: false, stage: "test", reason: (e as Error).message, started });
    }
  }

  return finish({ ok: true, stage: "test", reason: "all canary stages passed", started });
}

export async function runCanaryAndNotify(deps: CanaryDeps): Promise<CanaryResult> {
  const r = await runCanary(deps);
  if (!r.ok && deps.notify) {
    await Promise.resolve(
      deps.notify(`[canary] ${r.stage} failed: ${r.reason}${r.details ? `\n\n${r.details}` : ""}`),
    );
  }
  return r;
}

function finish(input: { ok: boolean; stage: CanaryStage; reason: string; details?: string; started: number }): CanaryResult {
  const result: CanaryResult = {
    ok: input.ok,
    stage: input.stage,
    reason: input.reason,
    durationMs: Date.now() - input.started,
  };
  if (input.details) result.details = input.details;
  return result;
}

function tail(s: string, n = 2000): string {
  return s.length <= n ? s : "…" + s.slice(-n);
}
