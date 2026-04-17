import { describe, expect, it } from "bun:test";
import { buildCommitMessage, buildPullBody, buildPullTitle, generateBranchName, slugify } from "../agent/task-runner.ts";
import type { TaskRequest } from "../adapters/event-router.ts";
import type { SubAgentResult } from "../agent/sub-agent.ts";

const task: TaskRequest = {
  source: { kind: "issue_comment", issueNumber: 5, commentId: 123, isPullRequest: false },
  taskText: "Fix the /login 500 on unicode emails\nand add a regression test",
  repo: "nextbysam/demo",
  author: "sam",
  rawMention: "@orb Fix the /login 500 on unicode emails\nand add a regression test",
};

const agent: SubAgentResult = {
  turns: 5,
  finalText: "Changed email normalization to NFC before the regex. Added a test in tests/login.test.ts.",
  stop_reason: "end_turn",
  toolCalls: [
    { name: "read_file", ok: true, summary: "read src/login.ts" },
    { name: "edit_file", ok: true, summary: "edited src/login.ts" },
    { name: "write_file", ok: true, summary: "wrote tests/login.test.ts" },
    { name: "run_bash", ok: true, summary: "bash exit=0" },
  ],
};

describe("slugify", () => {
  it("lowercases and collapses non-alnum runs", () => {
    expect(slugify("Fix /login 500 on Unicode!!")).toBe("fix-login-500-on-unicode");
  });
  it("strips leading/trailing dashes", () => {
    expect(slugify("--hi--")).toBe("hi");
  });
  it("empty + punctuation only -> empty", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("generateBranchName", () => {
  it("prefixes orb/, slugifies, truncates, appends ts suffix", () => {
    const b = generateBranchName(task, 1712345678901);
    expect(b.startsWith("orb/")).toBe(true);
    expect(b).toMatch(/fix-the-login-500-on-unicode/);
    expect(b.length).toBeLessThan(70);
  });
  it("falls back to 'task' when slug is empty", () => {
    const b = generateBranchName({ ...task, taskText: "!!!" }, 1);
    expect(b.startsWith("orb/task-")).toBe(true);
  });
});

describe("buildPullTitle", () => {
  it("uses first line, truncates >70 chars", () => {
    expect(buildPullTitle(task)).toBe("Fix the /login 500 on unicode emails");
    const long = { ...task, taskText: "a".repeat(100) };
    const t = buildPullTitle(long);
    expect(t.length).toBe(70);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("buildCommitMessage", () => {
  it("has first-line subject, summary body, two co-authors", () => {
    const msg = buildCommitMessage(task, agent);
    const lines = msg.split("\n");
    expect(lines[0]).toBe("Fix the /login 500 on unicode emails");
    expect(msg).toContain("Co-Authored-By: sam <sam@users.noreply.github.com>");
    expect(msg).toContain("Co-Authored-By: orb-async-dev <bot@orb-async-dev>");
    expect(msg).toContain("Changed email normalization to NFC");
  });
});

describe("buildPullBody", () => {
  it("includes requester, raw mention quoted, summary, tool calls with ✓/✗", () => {
    const body = buildPullBody(task, agent);
    expect(body).toContain("Requested via nextbysam/demo#5 (comment) by @sam");
    expect(body).toContain("> @orb Fix the /login 500");
    expect(body).toContain("## Summary");
    expect(body).toContain("Changed email normalization to NFC");
    expect(body).toContain("## Tool calls");
    expect(body).toContain("✓ `read_file`");
    expect(body).toContain("Stopped after 5 turns (end_turn)");
  });

  it("shows ✗ for failed tool calls", () => {
    const bad: SubAgentResult = {
      ...agent,
      toolCalls: [{ name: "read_file", ok: false, summary: "no such path: ghost" }],
    };
    expect(buildPullBody(task, bad)).toContain("✗ `read_file`");
  });

  it("handles empty tool-calls", () => {
    const empty: SubAgentResult = { ...agent, toolCalls: [] };
    expect(buildPullBody(task, empty)).toContain("(no tool calls)");
  });

  it("labels source for issues + PR review comments correctly", () => {
    const issue: TaskRequest = { ...task, source: { kind: "issue", issueNumber: 9 } };
    expect(buildPullBody(issue, agent)).toContain("via nextbysam/demo#9 by @sam");

    const review: TaskRequest = { ...task, source: { kind: "pr_review_comment", pullNumber: 42, commentId: 1 } };
    expect(buildPullBody(review, agent)).toContain("via nextbysam/demo#42 (review comment)");
  });

  it("renders verifier report block when supplied", () => {
    const body = buildPullBody(task, agent, {
      pass: true,
      hardFailures: [],
      softFailures: [{ name: "lint", pass: false, reason: "3 warnings", severity: "soft" }],
      allResults: [
        { name: "build", pass: true, reason: "passed", severity: "hard" },
        { name: "lint", pass: false, reason: "3 warnings", severity: "soft" },
        { name: "tests", pass: true, reason: "passed", severity: "hard" },
      ],
      stoppedEarly: false,
    });
    expect(body).toContain("## Verifier");
    expect(body).toContain("✓ **build** — passed");
    expect(body).toContain("⚠ **lint** — 3 warnings");
    expect(body).toContain("✓ **tests** — passed");
  });

  it("shows '(verifier did not run)' when no report provided", () => {
    expect(buildPullBody(task, agent)).toContain("_(verifier did not run)_");
  });
});
