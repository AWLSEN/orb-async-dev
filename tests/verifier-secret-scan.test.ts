import { describe, expect, it } from "bun:test";
import { extractAddedLines, scanDiffForSecrets, secretGate, shannonEntropy } from "../agent/verifier/secret-gate.ts";
import type { Runner } from "../agent/runner.ts";
import type { VerifierContext } from "../agent/verifier/types.ts";

function ctx(stdout: string): VerifierContext {
  const runner: Runner = async () => ({ stdout, stderr: "", code: 0 });
  return {
    workDir: "/x",
    baseBranch: "main",
    taskText: "",
    diff: { files: [], totalAdded: 0, totalDeleted: 0 },
    stack: { stack: "unknown" },
    runner,
  } as VerifierContext;
}

describe("shannonEntropy", () => {
  it("zero for single-char strings", () => {
    expect(shannonEntropy("aaaaaa")).toBe(0);
  });
  it("≈8 for random-looking hex", () => {
    expect(shannonEntropy("0123456789abcdef")).toBeGreaterThan(3.9);
  });
  it("empty -> 0", () => {
    expect(shannonEntropy("")).toBe(0);
  });
});

describe("extractAddedLines", () => {
  it("only added lines (ignores +++ file headers)", () => {
    const diff = [
      "+++ b/x.ts",
      "-old line",
      "+new line",
      " context",
      "+another add",
      "-removed",
    ].join("\n");
    expect(extractAddedLines(diff)).toEqual(["new line", "another add"]);
  });
});

describe("scanDiffForSecrets — known patterns", () => {
  const cases: Array<[string, string]> = [
    [`+const TOKEN = "ghp_${"a".repeat(40)}";`, "GitHub PAT"],
    [`+token: AKIAIOSFODNN7EXAMPLE`, "AWS access key"],
    [`+ANTHROPIC_KEY=sk-ant-${"x".repeat(30)}`, "Anthropic key"],
    [`+-----BEGIN RSA PRIVATE KEY-----`, "PEM private key"],
    [`+auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`, "JWT"],
    [`+SLACK_TOKEN=xoxb-1234567890-abc`, "Slack bot token"],
    [`+STRIPE=sk_live_${"1".repeat(24)}`, "Stripe secret"],
    [`+google: AIzaSy${"A".repeat(33)}`, "Google API key"],
  ];
  for (const [line, expectedReason] of cases) {
    it(`flags ${expectedReason}`, () => {
      const hits = scanDiffForSecrets(`diff --git a/x b/x\n+++ b/x\n${line}`);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0]!.reason).toContain(expectedReason);
    });
  }
});

describe("scanDiffForSecrets — entropy fallback", () => {
  it("flags high-entropy value in secret-named assignment", () => {
    const diff =
      "diff --git a/.env b/.env\n+++ b/.env\n+API_SECRET=Zq9JKx8QpL3mvRbT7cN2aYwF0hG6eB5uD4sXHVzO1PC";
    const hits = scanDiffForSecrets(diff);
    expect(hits.some((h) => h.reason.includes("high-entropy"))).toBe(true);
  });

  it("does not flag low-entropy plain English", () => {
    const diff = "diff --git a/README.md b/README.md\n+++ b/README.md\n+We now support three login providers in total.";
    expect(scanDiffForSecrets(diff)).toEqual([]);
  });
});

describe("scanDiffForSecrets — lockfile / binary skip", () => {
  it("ignores lockfile hunks", () => {
    const diff = [
      "diff --git a/bun.lock b/bun.lock",
      "+++ b/bun.lock",
      "+ghp_" + "a".repeat(40), // would otherwise match GitHub PAT
    ].join("\n");
    expect(scanDiffForSecrets(diff)).toEqual([]);
  });

  it("ignores binary file entries", () => {
    const diff = "diff --git a/logo.png b/logo.png\n+++ b/logo.png\n+AKIAIOSFODNN7EXAMPLE";
    expect(scanDiffForSecrets(diff)).toEqual([]);
  });
});

describe("secretGate (runner-level)", () => {
  it("passes on clean diff", async () => {
    const r = await secretGate()(ctx("diff --git a/x b/x\n+++ b/x\n+hello world"));
    expect(r.pass).toBe(true);
  });

  it("hard fails with count + first-hit details", async () => {
    const diff =
      "diff --git a/a b/a\n+++ b/a\n+GH=ghp_" + "A".repeat(40) + "\n+AWS=AKIAIOSFODNN7EXAMPLE";
    const r = await secretGate()(ctx(diff));
    expect(r.pass).toBe(false);
    expect(r.severity).toBe("hard");
    expect(r.reason).toMatch(/potential secret/);
    expect(r.details).toContain("GitHub PAT");
  });

  it("passes when git diff returns no output", async () => {
    const r = await secretGate()(ctx(""));
    expect(r.pass).toBe(true);
    expect(r.reason).toBe("no diff");
  });
});
