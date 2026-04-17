// Route a raw GitHub webhook payload (already signature-verified) to a
// TaskRequest that an orchestrator can act on. Narrows the event set to the
// three shapes that matter: new issue body, new issue/PR comment, new PR
// review comment. Anything else returns null (ignored).

import { parseMention, type ParseOptions } from "./mention-parser.ts";

export type GitHubEventName =
  | "issues"
  | "issue_comment"
  | "pull_request_review_comment"
  | string; // catch-all so callers can pass the raw X-GitHub-Event header

export interface TaskRequest {
  source:
    | { kind: "issue"; issueNumber: number }
    | { kind: "issue_comment"; issueNumber: number; commentId: number; isPullRequest: boolean }
    | { kind: "pr_review_comment"; pullNumber: number; commentId: number };
  taskText: string;
  /** Repo in "owner/name" form — lifted from payload.repository.full_name. */
  repo: string;
  /** Login of the commenter/author; used to attribute PR descriptions. */
  author: string;
  /** Always present even when derived, so downstream can echo the raw line. */
  rawMention: string;
}

export interface RouteResult {
  ok: true;
  task: TaskRequest;
}
export interface IgnoredResult {
  ok: false;
  reason:
    | "wrong_event"
    | "wrong_action"
    | "bot_author"
    | "no_mention"
    | "malformed_payload";
}
export type Routed = RouteResult | IgnoredResult;

export interface RouteOptions extends ParseOptions {
  /** Ignore comments/issues from these logins (case-insensitive). Prevents self-trigger loops. */
  ignoreAuthors?: string[];
}

export function routeEvent(event: GitHubEventName, payload: unknown, opts: RouteOptions = {}): Routed {
  if (!isObject(payload)) return { ok: false, reason: "malformed_payload" };

  const repo = getString(payload.repository, "full_name");
  if (!repo) return { ok: false, reason: "malformed_payload" };

  switch (event) {
    case "issues":
      return routeIssues(payload, repo, opts);
    case "issue_comment":
      return routeIssueComment(payload, repo, opts);
    case "pull_request_review_comment":
      return routePrReviewComment(payload, repo, opts);
    default:
      return { ok: false, reason: "wrong_event" };
  }
}

// --- per-event handlers ----------------------------------------------------

function routeIssues(p: AnyRecord, repo: string, opts: RouteOptions): Routed {
  const action = getString(p, "action");
  if (action !== "opened" && action !== "edited") return { ok: false, reason: "wrong_action" };
  const issue = isObject(p.issue) ? p.issue : null;
  if (!issue) return { ok: false, reason: "malformed_payload" };

  const author = getString(issue.user, "login") ?? "";
  if (ignored(author, opts)) return { ok: false, reason: "bot_author" };
  const body = getString(issue, "body") ?? "";
  const issueNumber = getNumber(issue, "number");
  if (issueNumber === undefined) return { ok: false, reason: "malformed_payload" };

  const mention = parseMention(body, opts);
  if (!mention) return { ok: false, reason: "no_mention" };

  return {
    ok: true,
    task: {
      source: { kind: "issue", issueNumber },
      taskText: mention.taskText,
      repo,
      author,
      rawMention: mention.rawLine,
    },
  };
}

function routeIssueComment(p: AnyRecord, repo: string, opts: RouteOptions): Routed {
  const action = getString(p, "action");
  if (action !== "created" && action !== "edited") return { ok: false, reason: "wrong_action" };
  const comment = isObject(p.comment) ? p.comment : null;
  const issue = isObject(p.issue) ? p.issue : null;
  if (!comment || !issue) return { ok: false, reason: "malformed_payload" };

  const author = getString(comment.user, "login") ?? "";
  if (ignored(author, opts)) return { ok: false, reason: "bot_author" };
  const body = getString(comment, "body") ?? "";
  const issueNumber = getNumber(issue, "number");
  const commentId = getNumber(comment, "id");
  if (issueNumber === undefined || commentId === undefined) return { ok: false, reason: "malformed_payload" };

  const mention = parseMention(body, opts);
  if (!mention) return { ok: false, reason: "no_mention" };

  const isPullRequest = isObject(issue.pull_request);
  return {
    ok: true,
    task: {
      source: { kind: "issue_comment", issueNumber, commentId, isPullRequest },
      taskText: mention.taskText,
      repo,
      author,
      rawMention: mention.rawLine,
    },
  };
}

function routePrReviewComment(p: AnyRecord, repo: string, opts: RouteOptions): Routed {
  const action = getString(p, "action");
  if (action !== "created" && action !== "edited") return { ok: false, reason: "wrong_action" };
  const comment = isObject(p.comment) ? p.comment : null;
  const pr = isObject(p.pull_request) ? p.pull_request : null;
  if (!comment || !pr) return { ok: false, reason: "malformed_payload" };

  const author = getString(comment.user, "login") ?? "";
  if (ignored(author, opts)) return { ok: false, reason: "bot_author" };
  const body = getString(comment, "body") ?? "";
  const pullNumber = getNumber(pr, "number");
  const commentId = getNumber(comment, "id");
  if (pullNumber === undefined || commentId === undefined) return { ok: false, reason: "malformed_payload" };

  const mention = parseMention(body, opts);
  if (!mention) return { ok: false, reason: "no_mention" };

  return {
    ok: true,
    task: {
      source: { kind: "pr_review_comment", pullNumber, commentId },
      taskText: mention.taskText,
      repo,
      author,
      rawMention: mention.rawLine,
    },
  };
}

// --- helpers ---------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

function isObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getString(v: unknown, key: string): string | undefined {
  if (!isObject(v)) return undefined;
  const out = v[key];
  return typeof out === "string" ? out : undefined;
}

function getNumber(v: unknown, key: string): number | undefined {
  if (!isObject(v)) return undefined;
  const out = v[key];
  return typeof out === "number" && Number.isFinite(out) ? out : undefined;
}

function ignored(author: string, opts: RouteOptions): boolean {
  if (!author) return false;
  const list = opts.ignoreAuthors?.map((s) => s.toLowerCase()) ?? [];
  return list.includes(author.toLowerCase());
}
