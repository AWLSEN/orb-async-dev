import { describe, expect, it } from "bun:test";
import { routeEvent } from "../adapters/event-router.ts";

const REPO = { full_name: "nextbysam/demo" };

describe("routeEvent — issues", () => {
  it("routes issues.opened with @orb in body", () => {
    const r = routeEvent("issues", {
      action: "opened",
      issue: { number: 12, body: "@orb fix the /login 500 on unicode", user: { login: "sam" } },
      repository: REPO,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.source).toEqual({ kind: "issue", issueNumber: 12 });
    expect(r.task.taskText).toBe("fix the /login 500 on unicode");
    expect(r.task.repo).toBe("nextbysam/demo");
    expect(r.task.author).toBe("sam");
  });

  it("ignores issues.closed", () => {
    const r = routeEvent("issues", {
      action: "closed",
      issue: { number: 1, body: "@orb fix", user: { login: "sam" } },
      repository: REPO,
    });
    expect(r).toEqual({ ok: false, reason: "wrong_action" });
  });

  it("ignores issues with no @orb mention", () => {
    const r = routeEvent("issues", {
      action: "opened",
      issue: { number: 1, body: "regular issue", user: { login: "sam" } },
      repository: REPO,
    });
    expect(r).toEqual({ ok: false, reason: "no_mention" });
  });

  it("ignores bot-author issues when listed in ignoreAuthors", () => {
    const r = routeEvent(
      "issues",
      {
        action: "opened",
        issue: { number: 1, body: "@orb do it", user: { login: "orb-bot" } },
        repository: REPO,
      },
      { ignoreAuthors: ["ORB-BOT"] },
    );
    expect(r).toEqual({ ok: false, reason: "bot_author" });
  });
});

describe("routeEvent — issue_comment", () => {
  it("routes issue_comment.created on an issue", () => {
    const r = routeEvent("issue_comment", {
      action: "created",
      issue: { number: 5 },
      comment: { id: 99, body: "@orb please bump axios", user: { login: "sam" } },
      repository: REPO,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.source).toEqual({ kind: "issue_comment", issueNumber: 5, commentId: 99, isPullRequest: false });
    expect(r.task.taskText).toBe("please bump axios");
  });

  it("flags issue_comment on a PR with isPullRequest=true", () => {
    const r = routeEvent("issue_comment", {
      action: "created",
      issue: { number: 7, pull_request: { url: "..." } },
      comment: { id: 22, body: "@orb fix the review comments", user: { login: "sam" } },
      repository: REPO,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.source).toEqual({ kind: "issue_comment", issueNumber: 7, commentId: 22, isPullRequest: true });
  });

  it("rejects malformed payloads", () => {
    expect(routeEvent("issue_comment", null)).toEqual({ ok: false, reason: "malformed_payload" });
    expect(routeEvent("issue_comment", { repository: REPO, action: "created" })).toEqual({ ok: false, reason: "malformed_payload" });
  });
});

describe("routeEvent — pull_request_review_comment", () => {
  it("routes with PR number + comment id", () => {
    const r = routeEvent("pull_request_review_comment", {
      action: "created",
      pull_request: { number: 42 },
      comment: { id: 3000, body: "@orb address these", user: { login: "sam" } },
      repository: REPO,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.source).toEqual({ kind: "pr_review_comment", pullNumber: 42, commentId: 3000 });
    expect(r.task.taskText).toBe("address these");
  });
});

describe("routeEvent — unsupported events", () => {
  it("returns wrong_event for push", () => {
    expect(routeEvent("push", { repository: REPO })).toEqual({ ok: false, reason: "wrong_event" });
  });
  it("returns wrong_event for star", () => {
    expect(routeEvent("star", { repository: REPO })).toEqual({ ok: false, reason: "wrong_event" });
  });
  it("returns malformed for missing repository", () => {
    expect(routeEvent("issues", { action: "opened" })).toEqual({ ok: false, reason: "malformed_payload" });
  });
});
