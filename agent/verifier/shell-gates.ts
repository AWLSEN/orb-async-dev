// Shell-backed gates. They take a command from the detected stack and
// interpret its exit code. Non-applicable commands (e.g. typecheck on a Go
// repo) just pass with a "(skipped)" reason.

import type { Gate, GateResult } from "./types.ts";

async function runGate(
  name: string,
  ctx: Parameters<Gate>[0],
  command: string | undefined,
  opts: { severity?: "hard" | "soft"; timeoutMs?: number } = {},
): Promise<GateResult> {
  const severity = opts.severity ?? "hard";
  if (!command) return { name, pass: true, reason: "skipped (no command for this stack)", severity };
  try {
    const res = await ctx.runner({
      cmd: ["bash", "-c", command],
      cwd: ctx.workDir,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (res.code === 0) {
      return { name, pass: true, reason: "passed", severity };
    }
    return {
      name,
      pass: false,
      reason: `exit=${res.code} while running \`${command}\``,
      details: tail(res.stderr || res.stdout, 4000),
      severity,
    };
  } catch (e) {
    const err = e as { result?: { stdout: string; stderr: string; code: number }; message?: string };
    if (err.result) {
      return {
        name,
        pass: false,
        reason: `exit=${err.result.code} while running \`${command}\``,
        details: tail(err.result.stderr || err.result.stdout, 4000),
        severity,
      };
    }
    return { name, pass: false, reason: `runtime error: ${err.message ?? "unknown"}`, severity };
  }
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : "…" + s.slice(-n);
}

export const buildGate: Gate = (ctx) => runGate("build", ctx, ctx.stack.build, { timeoutMs: 600_000 });
export const testGate: Gate = (ctx) => runGate("tests", ctx, ctx.stack.test, { timeoutMs: 600_000 });
export const typecheckGate: Gate = (ctx) => runGate("typecheck", ctx, ctx.stack.typecheck, { timeoutMs: 180_000 });
export const lintGate: Gate = (ctx) => runGate("lint", ctx, ctx.stack.lint, { timeoutMs: 180_000, severity: "soft" });

export const SCOPE_MAX_FILES = 20;
export const SCOPE_MAX_LOC = 500;

export const scopeGate: Gate = async (ctx): Promise<GateResult> => {
  const files = ctx.diff.files.length;
  const loc = ctx.diff.totalAdded + ctx.diff.totalDeleted;
  if (files > SCOPE_MAX_FILES) {
    return { name: "scope", pass: false, reason: `diff touches ${files} files (>${SCOPE_MAX_FILES})`, severity: "hard" };
  }
  if (loc > SCOPE_MAX_LOC) {
    return { name: "scope", pass: false, reason: `diff is ${loc} LOC (>${SCOPE_MAX_LOC})`, severity: "hard" };
  }
  return { name: "scope", pass: true, reason: `${files} files, ${loc} LOC`, severity: "hard" };
};
