import { describe, expect, it } from "bun:test";
import { GithubApiError, GithubClient } from "../adapters/github-client.ts";

type Route = (req: Request) => Response | Promise<Response>;
type Call = { method: string; path: string; headers: Record<string, string>; body: string | null };

function stub(routes: Record<string, Route>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const headers: Record<string, string> = {};
    const reqHeaders = new Headers(init?.headers);
    reqHeaders.forEach((v, k) => (headers[k] = v));
    const body = init?.body ? String(init.body) : null;
    calls.push({ method, path, headers, body });
    const key = `${method} ${path}`;
    const handler = routes[key];
    if (!handler) return new Response(`unrouted: ${key}`, { status: 500 });
    return handler(new Request(url, init));
  };
  return { fetch: impl as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch): GithubClient {
  return new GithubClient({ token: "tok", repo: "nextbysam/demo", fetchImpl });
}

describe("GithubClient constructor", () => {
  it("rejects missing token", () => {
    expect(() => new GithubClient({ token: "", repo: "a/b" })).toThrow(/token required/);
  });
  it("rejects malformed repo", () => {
    expect(() => new GithubClient({ token: "t", repo: "nope" })).toThrow(/invalid repo/);
  });
});

describe("getDefaultBranch", () => {
  it("reads default_branch", async () => {
    const { fetch } = stub({
      "GET /repos/nextbysam/demo": () => new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }),
    });
    expect(await client(fetch).getDefaultBranch()).toBe("main");
  });
  it("throws when absent", async () => {
    const { fetch } = stub({
      "GET /repos/nextbysam/demo": () => new Response("{}", { status: 200 }),
    });
    await expect(client(fetch).getDefaultBranch()).rejects.toThrow(/default_branch/);
  });
});

describe("getBranchRef", () => {
  it("returns {ref, sha} on 200", async () => {
    const { fetch } = stub({
      "GET /repos/nextbysam/demo/git/ref/heads/main": () =>
        new Response(JSON.stringify({ ref: "refs/heads/main", object: { sha: "abc" } }), { status: 200 }),
    });
    const ref = await client(fetch).getBranchRef("main");
    expect(ref).toEqual({ ref: "refs/heads/main", sha: "abc" });
  });
  it("returns null on 404", async () => {
    const { fetch } = stub({
      "GET /repos/nextbysam/demo/git/ref/heads/missing": () => new Response("not found", { status: 404 }),
    });
    expect(await client(fetch).getBranchRef("missing")).toBeNull();
  });
  it("url-encodes slashes in branch names", async () => {
    const { fetch, calls } = stub({
      "GET /repos/nextbysam/demo/git/ref/heads/feat%2Fnew": () =>
        new Response(JSON.stringify({ ref: "x", object: { sha: "s" } }), { status: 200 }),
    });
    await client(fetch).getBranchRef("feat/new");
    expect(calls[0]?.path).toBe("/repos/nextbysam/demo/git/ref/heads/feat%2Fnew");
  });
});

describe("createBranch", () => {
  it("POSTs refs/heads/<name>", async () => {
    const { fetch, calls } = stub({
      "POST /repos/nextbysam/demo/git/refs": () =>
        new Response(JSON.stringify({ ref: "refs/heads/fix/x", object: { sha: "d" } }), { status: 201 }),
    });
    const out = await client(fetch).createBranch("fix/x", "c1");
    expect(out).toEqual({ ref: "refs/heads/fix/x", sha: "d" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ ref: "refs/heads/fix/x", sha: "c1" });
  });
});

describe("openPullRequest", () => {
  it("sends title/head/base/body and optional draft", async () => {
    const { fetch, calls } = stub({
      "POST /repos/nextbysam/demo/pulls": () =>
        new Response(JSON.stringify({ number: 42, html_url: "https://github.com/p/42", head: { ref: "h", sha: "s" }, base: { ref: "main" } }), { status: 201 }),
    });
    const pr = await client(fetch).openPullRequest({ head: "h", base: "main", title: "t", body: "b", draft: true });
    expect(pr.number).toBe(42);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ title: "t", head: "h", base: "main", body: "b", draft: true });
  });
  it("omits draft when false/unset", async () => {
    const { fetch, calls } = stub({
      "POST /repos/nextbysam/demo/pulls": () =>
        new Response(JSON.stringify({ number: 1, html_url: "x", head: { ref: "h", sha: "s" }, base: { ref: "main" } }), { status: 201 }),
    });
    await client(fetch).openPullRequest({ head: "h", base: "main", title: "t", body: "b" });
    const parsed = JSON.parse(calls[0]!.body!);
    expect(parsed).not.toHaveProperty("draft");
  });
});

describe("postIssueComment + replyToReviewComment", () => {
  it("posts to /issues/{n}/comments", async () => {
    const { fetch, calls } = stub({
      "POST /repos/nextbysam/demo/issues/7/comments": () =>
        new Response(JSON.stringify({ id: 1, html_url: "u" }), { status: 201 }),
    });
    await client(fetch).postIssueComment(7, "hello");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ body: "hello" });
  });
  it("review reply includes in_reply_to", async () => {
    const { fetch, calls } = stub({
      "POST /repos/nextbysam/demo/pulls/5/comments": () =>
        new Response(JSON.stringify({ id: 2, html_url: "u" }), { status: 201 }),
    });
    await client(fetch).replyToReviewComment(5, 3000, "ack");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ body: "ack", in_reply_to: 3000 });
  });
});

describe("request shape + errors", () => {
  it("sends auth + accept + api-version + ua headers", async () => {
    const { fetch, calls } = stub({
      "GET /repos/nextbysam/demo": () => new Response(JSON.stringify({ default_branch: "m" }), { status: 200 }),
    });
    await client(fetch).getDefaultBranch();
    const h = calls[0]!.headers;
    expect(h["authorization"]).toBe("Bearer tok");
    expect(h["accept"]).toBe("application/vnd.github+json");
    expect(h["x-github-api-version"]).toBe("2022-11-28");
    expect(h["user-agent"]).toBe("orb-async-dev");
  });
  it("throws GithubApiError with body on non-2xx", async () => {
    const { fetch } = stub({
      "POST /repos/nextbysam/demo/pulls": () => new Response('{"message":"validation failed"}', { status: 422 }),
    });
    try {
      await client(fetch).openPullRequest({ head: "h", base: "m", title: "t", body: "b" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GithubApiError);
      expect((e as GithubApiError).status).toBe(422);
      expect((e as GithubApiError).body).toContain("validation failed");
    }
  });
});
