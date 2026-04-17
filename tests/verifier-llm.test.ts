import { describe, expect, it } from "bun:test";
import { extractJson, redTeamGate, selfReviewGate } from "../agent/verifier/llm-gates.ts";
import type { Runner } from "../agent/runner.ts";
import type { VerifierContext } from "../agent/verifier/types.ts";

function ctx(overrides: Partial<VerifierContext> & { runner?: Runner } = {}): VerifierContext {
  const runner: Runner = overrides.runner ?? (async () => ({ stdout: "diff --git a/x b/x\n+hello\n", stderr: "", code: 0 }));
  return {
    workDir: "/x",
    baseBranch: "main",
    taskText: "fix the login bug",
    diff: { files: [{ path: "src/a.ts", added: 1, deleted: 0 }], totalAdded: 1, totalDeleted: 0 },
    stack: { stack: "bun" },
    runner,
    ...overrides,
  } as VerifierContext;
}

function clientThatReturns(text: string): { client: { messages: { create: () => Promise<{ content: Array<{ type: "text"; text: string }>; stop_reason: string }> } }; calls: number } {
  let calls = 0;
  return {
    client: {
      messages: {
        create: async () => {
          calls += 1;
          return { content: [{ type: "text", text }], stop_reason: "end_turn" };
        },
      },
    },
    get calls() {
      return calls;
    },
  } as any;
}

describe("extractJson", () => {
  it("extracts clean JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("extracts JSON wrapped in prose", () => {
    expect(extractJson('Sure — here you go:\n{"b": "yes"}\nHope that helps!')).toEqual({ b: "yes" });
  });
  it("returns undefined on garbage", () => {
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson("{ this is not json }")).toBeUndefined();
  });
});

describe("selfReviewGate", () => {
  it("pass with risk line when matches_task=true", async () => {
    const { client } = clientThatReturns(
      JSON.stringify({ matches_task: true, top_risk: "missing test for the unicode edge case", notes: "tests added for ascii only" }),
    );
    const r = await selfReviewGate({ client: client as any, model: "m" })(ctx());
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/risk: missing test for the unicode edge case/);
    expect(r.details).toMatch(/tests added for ascii only/);
  });

  it("hard fail when matches_task=false", async () => {
    const { client } = clientThatReturns(
      JSON.stringify({ matches_task: false, top_risk: "PR edits the wrong file", notes: "" }),
    );
    const r = await selfReviewGate({ client: client as any, model: "m" })(ctx());
    expect(r.pass).toBe(false);
    expect(r.severity).toBe("hard");
    expect(r.reason).toMatch(/does not match task/);
    expect(r.reason).toMatch(/wrong file/);
  });

  it("soft-skips when model returns unparseable output", async () => {
    const { client } = clientThatReturns("I am a chatty model without JSON");
    const r = await selfReviewGate({ client: client as any, model: "m" })(ctx());
    expect(r.pass).toBe(true);
    expect(r.severity).toBe("soft");
    expect(r.reason).toMatch(/soft-skipped/);
  });

  it("passes trivially when there is no diff", async () => {
    const noDiff = ctx({ runner: async () => ({ stdout: "", stderr: "", code: 0 }) });
    const { client } = clientThatReturns('{"matches_task": true, "top_risk": ""}');
    const r = await selfReviewGate({ client: client as any, model: "m" })(noDiff);
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/no diff/);
  });

  it("soft-passes on LLM exception without blocking the PR", async () => {
    const client = { messages: { create: async () => { throw new Error("rate limited"); } } };
    const r = await selfReviewGate({ client: client as any, model: "m" })(ctx());
    expect(r.pass).toBe(true);
    expect(r.severity).toBe("soft");
    expect(r.reason).toMatch(/rate limited/);
  });
});

describe("redTeamGate", () => {
  it("hard fails when substantive_flaws present", async () => {
    const { client } = clientThatReturns(
      JSON.stringify({
        substantive_flaws: ["test asserts old behavior", "race condition in the lock release"],
        non_issues: ["formatting"],
        one_line_verdict: "would not merge",
      }),
    );
    const r = await redTeamGate({ client: client as any, model: "m" })(ctx());
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/2 substantive flaw/);
    expect(r.details).toMatch(/1\. test asserts old behavior/);
    expect(r.details).toMatch(/2\. race condition/);
  });

  it("passes when flaws array empty", async () => {
    const { client } = clientThatReturns(
      JSON.stringify({ substantive_flaws: [], non_issues: ["style nits"], one_line_verdict: "looks fine" }),
    );
    const r = await redTeamGate({ client: client as any, model: "m" })(ctx());
    expect(r.pass).toBe(true);
    expect(r.reason).toBe("looks fine");
  });

  it("filters out non-string entries in substantive_flaws", async () => {
    const { client } = clientThatReturns(JSON.stringify({ substantive_flaws: ["", null, "real flaw"] }));
    const r = await redTeamGate({ client: client as any, model: "m" })(ctx());
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/1 substantive/);
  });

  it("soft-skips on bad JSON", async () => {
    const { client } = clientThatReturns("the model went rogue");
    const r = await redTeamGate({ client: client as any, model: "m" })(ctx());
    expect(r.severity).toBe("soft");
    expect(r.pass).toBe(true);
  });
});
