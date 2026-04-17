// Thin typed client for the handful of GitHub REST calls the orchestrator
// actually needs: resolve a branch SHA, create a branch, open a PR, post a
// comment on an issue/PR, reply to a review comment. Keeps the dependency
// surface identical to OrbClient (raw fetch, injectable for tests).

export interface GithubClientOpts {
  token: string;
  repo: string; // "owner/name"
  baseUrl?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export interface Ref {
  ref: string;
  sha: string;
}

export interface PullRequest {
  number: number;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export interface IssueComment {
  id: number;
  html_url: string;
}

export class GithubApiError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`github api ${status} ${url}: ${body.slice(0, 400)}`);
    this.name = "GithubApiError";
  }
}

export class GithubClient {
  readonly baseUrl: string;
  readonly owner: string;
  readonly name: string;
  private readonly token: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GithubClientOpts) {
    if (!opts.token) throw new Error("github client: token required");
    const [owner, name] = opts.repo.split("/");
    if (!owner || !name) throw new Error(`github client: invalid repo "${opts.repo}" (expected owner/name)`);
    this.owner = owner;
    this.name = name;
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.userAgent = opts.userAgent ?? "orb-async-dev";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Repo metadata (just default_branch for now). */
  async getDefaultBranch(): Promise<string> {
    const res = await this.req("GET", `/repos/${this.owner}/${this.name}`);
    const data = (await res.json()) as { default_branch?: string };
    if (!data.default_branch) throw new Error("github: no default_branch on repo");
    return data.default_branch;
  }

  /** Resolve `heads/<branch>` -> {ref, sha}. Returns null if branch missing. */
  async getBranchRef(branch: string): Promise<Ref | null> {
    const res = await this.reqRaw(
      "GET",
      `/repos/${this.owner}/${this.name}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    if (res.status === 404) {
      await res.text().catch(() => "");
      return null;
    }
    if (!res.ok) await this.throwApiError(res);
    const data = (await res.json()) as { ref: string; object: { sha: string } };
    return { ref: data.ref, sha: data.object.sha };
  }

  /** Create a new branch `name` at `fromSha`. */
  async createBranch(name: string, fromSha: string): Promise<Ref> {
    const res = await this.req("POST", `/repos/${this.owner}/${this.name}/git/refs`, {
      ref: `refs/heads/${name}`,
      sha: fromSha,
    });
    const data = (await res.json()) as { ref: string; object: { sha: string } };
    return { ref: data.ref, sha: data.object.sha };
  }

  /** Open a PR from `head` into `base`. */
  async openPullRequest(input: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<PullRequest> {
    const body: Record<string, unknown> = {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
    };
    if (input.draft) body.draft = true;
    const res = await this.req("POST", `/repos/${this.owner}/${this.name}/pulls`, body);
    return (await res.json()) as PullRequest;
  }

  /** Post a comment on an issue or PR thread (same endpoint for both). */
  async postIssueComment(issueNumber: number, body: string): Promise<IssueComment> {
    const res = await this.req("POST", `/repos/${this.owner}/${this.name}/issues/${issueNumber}/comments`, { body });
    return (await res.json()) as IssueComment;
  }

  /** Reply to a PR review comment by commenting in the same review thread. */
  async replyToReviewComment(pullNumber: number, inReplyTo: number, body: string): Promise<IssueComment> {
    const res = await this.req(
      "POST",
      `/repos/${this.owner}/${this.name}/pulls/${pullNumber}/comments`,
      { body, in_reply_to: inReplyTo },
    );
    return (await res.json()) as IssueComment;
  }

  // --- internals ----------------------------------------------------------

  private async req(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.reqRaw(method, path, body);
    if (!res.ok) await this.throwApiError(res);
    return res;
  }

  private async reqRaw(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": this.userAgent,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return this.fetchImpl(url, init);
  }

  private async throwApiError(res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    throw new GithubApiError(res.status, res.url, text);
  }
}
