// Assemble the 9-gate chain and run it. Short-circuits on the first hard
// failure (cheap gates run first so we fail fast). Soft fails accumulate
// and surface as warnings in the PR body.

import type Anthropic from "@anthropic-ai/sdk";
import type { Runner } from "../runner.ts";
import { buildGate, lintGate, scopeGate, testGate, typecheckGate } from "./shell-gates.ts";
import { mutationGate, newTestsGate } from "./diff-gates.ts";
import { redTeamGate, selfReviewGate } from "./llm-gates.ts";
import { secretGate } from "./secret-gate.ts";
import { detectStack } from "./stack-detect.ts";
import { parseNumstat, type Gate, type GateResult, type VerifierContext } from "./types.ts";

export interface VerifyOpts {
  workDir: string;
  baseBranch: string;
  taskText: string;
  runner: Runner;
  anthropic: Pick<Anthropic, "messages">;
  anthropicModel: string;
}

export interface VerifyReport {
  pass: boolean;
  hardFailures: GateResult[];
  softFailures: GateResult[];
  allResults: GateResult[];
  /** Stops after first hard failure, so not every gate runs on failing PRs. */
  stoppedEarly: boolean;
}

/** Run all gates in order. Short-circuits on first hard failure. */
export async function verify(opts: VerifyOpts): Promise<VerifyReport> {
  const numstat = await opts.runner({
    cmd: ["git", "diff", `origin/${opts.baseBranch}...HEAD`, "--numstat"],
    cwd: opts.workDir,
    timeoutMs: 60_000,
  }).catch(() => ({ stdout: "", stderr: "", code: 1 }));

  const ctx: VerifierContext = {
    workDir: opts.workDir,
    baseBranch: opts.baseBranch,
    taskText: opts.taskText,
    diff: parseNumstat(numstat.stdout),
    stack: detectStack(opts.workDir),
    runner: opts.runner,
    anthropicModel: opts.anthropicModel,
  };

  const gates: Gate[] = [
    scopeGate,          // cheap: inspect numstat
    secretGate(),       // cheap-ish: one `git diff`
    newTestsGate,       // cheap: inspect numstat + path rules
    buildGate,          // expensive: runs the build
    testGate,           // expensive: runs the tests
    lintGate,           // soft: warns but doesn't block
    typecheckGate,      // expensive: runs typecheck
    mutationGate,       // expensive: reverts + retests
    selfReviewGate({ client: opts.anthropic, model: opts.anthropicModel }),
    redTeamGate({ client: opts.anthropic, model: opts.anthropicModel }),
  ];

  const all: GateResult[] = [];
  const hardFailures: GateResult[] = [];
  const softFailures: GateResult[] = [];
  let stoppedEarly = false;

  for (const gate of gates) {
    const r = await gate(ctx);
    all.push(r);
    if (!r.pass) {
      if (r.severity === "hard") {
        hardFailures.push(r);
        stoppedEarly = true;
        break;
      }
      softFailures.push(r);
    }
  }

  return { pass: hardFailures.length === 0, hardFailures, softFailures, allResults: all, stoppedEarly };
}

/** Render the verifier report as markdown for the PR body. */
export function renderReport(report: VerifyReport): string {
  const rows = report.allResults.map((r) => {
    const icon = r.pass ? "✓" : r.severity === "hard" ? "✗" : "⚠";
    return `- ${icon} **${r.name}** — ${r.reason}`;
  });
  return rows.join("\n");
}
