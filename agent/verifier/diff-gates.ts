// Diff-aware gates. These reason about the change set rather than re-running
// a shell command once.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Gate, GateResult, VerifierContext } from "./types.ts";
import { isSrcPath, isTestPath } from "./types.ts";

/** Threshold above which a src change must be accompanied by a test change. */
export const NEW_TESTS_SRC_LOC_THRESHOLD = 20;

/** A src change of this size requires a *new* test (not just an edited one). */
export const NEW_TESTS_REQUIRE_NEW_FILE_THRESHOLD = 200;

export const newTestsGate: Gate = async (ctx): Promise<GateResult> => {
  const srcAdded = ctx.diff.files.filter((f) => isSrcPath(f.path)).reduce((n, f) => n + f.added, 0);
  const testFiles = ctx.diff.files.filter((f) => isTestPath(f.path));
  const testAdded = testFiles.reduce((n, f) => n + f.added, 0);

  if (srcAdded <= NEW_TESTS_SRC_LOC_THRESHOLD) {
    return {
      name: "new_tests",
      pass: true,
      reason: `src diff ${srcAdded} LOC ≤ ${NEW_TESTS_SRC_LOC_THRESHOLD} (threshold); no test required`,
      severity: "hard",
    };
  }
  if (testFiles.length === 0 || testAdded === 0) {
    return {
      name: "new_tests",
      pass: false,
      reason: `src diff is ${srcAdded} LOC but the PR adds no test lines`,
      severity: "hard",
    };
  }
  return {
    name: "new_tests",
    pass: true,
    reason: `src ${srcAdded} LOC + tests ${testAdded} LOC across ${testFiles.length} test file(s)`,
    severity: "hard",
  };
};

/**
 * Mutation check: revert the src changes, re-run the test suite, confirm
 * at least one test now fails. Restores the src on the way out no matter
 * what. Skipped when the stack has no test command or when the PR changes
 * no src files.
 */
export const mutationGate: Gate = async (ctx): Promise<GateResult> => {
  const srcFiles = ctx.diff.files.filter((f) => isSrcPath(f.path));
  if (srcFiles.length === 0) {
    return { name: "mutation", pass: true, reason: "no src changes to mutate", severity: "hard" };
  }
  if (!ctx.stack.test) {
    return { name: "mutation", pass: true, reason: "skipped (no test command for this stack)", severity: "hard" };
  }

  const saved = await snapshotSrc(srcFiles, ctx);
  try {
    await revertSrc(srcFiles, ctx);
    const res = await ctx.runner({
      cmd: ["bash", "-c", ctx.stack.test],
      cwd: ctx.workDir,
      timeoutMs: 600_000,
    }).catch((e) => {
      const err = e as { result?: { code: number; stderr: string; stdout: string } };
      return err.result ?? { code: 1, stderr: String((e as Error).message), stdout: "" };
    });
    if (res.code === 0) {
      return {
        name: "mutation",
        pass: false,
        reason: "tests pass even without the src change — new tests don't exercise the fix",
        severity: "hard",
      };
    }
    return {
      name: "mutation",
      pass: true,
      reason: `tests red without src changes (exit=${res.code}) — confirmed new tests exercise the fix`,
      severity: "hard",
    };
  } finally {
    await restoreSrc(saved, ctx).catch(() => undefined);
    // After worktree restore, resync the index so `git status` is clean again.
    // Any previous `git checkout origin/base -- <path>` mutated the index; this
    // resets it back to HEAD (which is our real commit).
    for (const f of srcFiles) {
      await ctx
        .runner({ cmd: ["git", "checkout", "HEAD", "--", f.path], cwd: ctx.workDir })
        .catch(() => undefined);
    }
  }
};

async function snapshotSrc(srcFiles: VerifierContext["diff"]["files"], ctx: VerifierContext): Promise<Map<string, string | null>> {
  const saved = new Map<string, string | null>();
  for (const f of srcFiles) {
    const abs = path.join(ctx.workDir, f.path);
    try {
      saved.set(f.path, await readFile(abs, "utf8"));
    } catch {
      saved.set(f.path, null); // newly-added file
    }
  }
  return saved;
}

async function revertSrc(srcFiles: VerifierContext["diff"]["files"], ctx: VerifierContext): Promise<void> {
  for (const f of srcFiles) {
    await ctx
      .runner({
        cmd: ["git", "checkout", `origin/${ctx.baseBranch}`, "--", f.path],
        cwd: ctx.workDir,
      })
      .catch(async () => {
        // Newly-added files aren't on origin/base — remove them instead.
        const { rm } = await import("node:fs/promises");
        await rm(path.join(ctx.workDir, f.path), { force: true });
      });
  }
}

async function restoreSrc(saved: Map<string, string | null>, ctx: VerifierContext): Promise<void> {
  for (const [p, content] of saved) {
    const abs = path.join(ctx.workDir, p);
    if (content === null) {
      // Was a new file — nothing to restore beyond the revert's rm.
      continue;
    }
    await writeFile(abs, content, "utf8");
  }
}
