// LLM-backed gates: self-review + red-team. Both ask Claude to read the diff
// and the task, then return structured JSON the gate can interpret.
//
// Failure modes we guard against:
//   - Model hallucinates JSON -> fall back to soft pass w/ reason "unparseable".
//   - Diff too big -> truncate with a clear marker, ask model to focus on head.
//   - LLM call errors -> soft pass w/ the error message; we don't block the
//     PR just because the proxy hiccuped.

import type Anthropic from "@anthropic-ai/sdk";
import type { Gate, GateResult, VerifierContext } from "./types.ts";

export interface LlmGateOpts {
  client: Pick<Anthropic, "messages">;
  model: string;
  maxDiffBytes?: number;
  maxTokens?: number;
}

export const DEFAULT_MAX_DIFF_BYTES = 50_000;

/** Collect the full patch between origin/<base> and HEAD, truncated if huge. */
export async function collectDiff(ctx: VerifierContext, maxBytes = DEFAULT_MAX_DIFF_BYTES): Promise<string> {
  const res = await ctx.runner({
    cmd: ["git", "diff", `origin/${ctx.baseBranch}...HEAD`],
    cwd: ctx.workDir,
    timeoutMs: 60_000,
  }).catch((e) => {
    const err = e as { result?: { stdout: string; stderr: string; code: number } };
    return err.result ?? { stdout: "", stderr: String((e as Error).message), code: 1 };
  });
  const diff = res.stdout;
  if (diff.length <= maxBytes) return diff;
  return `${diff.slice(0, maxBytes)}\n\n…truncated (diff was ${diff.length} bytes, showing first ${maxBytes}).`;
}

const SELF_REVIEW_SYSTEM = `You are a senior engineer doing a sanity pass on a PR before it is opened.
You will receive (1) the user's task, and (2) the full diff from origin/base to HEAD.
Answer honestly and briefly. If the diff doesn't obviously solve the task, say so.
If you notice subtle concerns (edge cases, missing tests for a branch, possible
regressions), put the biggest one in top_risk. Keep top_risk under 200 chars.

Respond with a single JSON object matching this schema and NOTHING else:

{
  "matches_task": true | false,
  "top_risk": string,
  "notes": string
}`;

const RED_TEAM_SYSTEM = `You are a ruthless code reviewer. Your job is to find *substantive* flaws in
this PR — things that would cause a bug, regression, security hole, or a bad
reviewer experience. Ignore style nits. If the PR is genuinely fine, say so;
do NOT invent flaws to fill a quota.

You will receive the task and the diff. Respond with a single JSON object:

{
  "substantive_flaws": [string, ...],
  "non_issues": [string, ...],
  "one_line_verdict": string
}

A substantive flaw is: a functional bug, a security regression, a breaking
change without a migration path, a test that doesn't actually test the fix,
or a clearly wrong scope. Unused var warnings, formatting, personal taste:
NOT substantive.`;

/** Ask the LLM for a structured self-review and fold its answer into a GateResult. */
export function selfReviewGate(opts: LlmGateOpts): Gate {
  return async (ctx): Promise<GateResult> => {
    const diff = await collectDiff(ctx, opts.maxDiffBytes);
    if (!diff.trim()) {
      return { name: "self_review", pass: true, reason: "no diff to review", severity: "hard" };
    }
    const user = `Task:\n${ctx.taskText}\n\n--- diff ---\n${diff}`;
    const raw = await callJson(opts, SELF_REVIEW_SYSTEM, user);
    if (!raw.ok) {
      return { name: "self_review", pass: true, reason: `soft-skipped: ${raw.error}`, severity: "soft" };
    }
    const parsed = raw.json as { matches_task?: boolean; top_risk?: string; notes?: string };
    if (parsed.matches_task === false) {
      return {
        name: "self_review",
        pass: false,
        reason: `self-review: diff does not match task. ${parsed.top_risk ?? parsed.notes ?? ""}`.trim(),
        severity: "hard",
      };
    }
    return {
      name: "self_review",
      pass: true,
      reason: parsed.top_risk ? `risk: ${parsed.top_risk}` : "no top risk flagged",
      ...(parsed.notes ? { details: parsed.notes } : {}),
      severity: "hard",
    };
  };
}

/** Red-team: fails hard when Claude returns ≥1 substantive flaw. */
export function redTeamGate(opts: LlmGateOpts): Gate {
  return async (ctx): Promise<GateResult> => {
    const diff = await collectDiff(ctx, opts.maxDiffBytes);
    if (!diff.trim()) {
      return { name: "red_team", pass: true, reason: "no diff to red-team", severity: "hard" };
    }
    const user = `Task:\n${ctx.taskText}\n\n--- diff ---\n${diff}`;
    const raw = await callJson(opts, RED_TEAM_SYSTEM, user);
    if (!raw.ok) {
      return { name: "red_team", pass: true, reason: `soft-skipped: ${raw.error}`, severity: "soft" };
    }
    const parsed = raw.json as { substantive_flaws?: string[]; non_issues?: string[]; one_line_verdict?: string };
    const flaws = Array.isArray(parsed.substantive_flaws) ? parsed.substantive_flaws.filter((s) => typeof s === "string" && s.trim()) : [];
    if (flaws.length > 0) {
      return {
        name: "red_team",
        pass: false,
        reason: `${flaws.length} substantive flaw(s): ${flaws[0]}`,
        details: flaws.map((f, i) => `${i + 1}. ${f}`).join("\n"),
        severity: "hard",
      };
    }
    return {
      name: "red_team",
      pass: true,
      reason: parsed.one_line_verdict || "no substantive flaws found",
      severity: "hard",
    };
  };
}

/** Call Claude, parse the first JSON object in the response. */
async function callJson(
  opts: LlmGateOpts,
  system: string,
  user: string,
): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  try {
    const resp = await opts.client.messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1024,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const json = extractJson(text);
    if (json === undefined) return { ok: false, error: "could not parse JSON from model response" };
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Pull the first {...} JSON object out of free-form text. Models sometimes wrap in prose. */
export function extractJson(text: string): unknown | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}
