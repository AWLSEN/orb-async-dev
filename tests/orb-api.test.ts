import { describe, expect, it } from "bun:test";
import { OrbApiError, OrbClient } from "../deploy/orb-api.ts";

function stubFetch(routes: Record<string, (req: Request) => Response | Promise<Response>>): {
  fetch: typeof fetch;
  calls: { method: string; url: string; headers: Record<string, string>; body: string | null }[];
} {
  const calls: { method: string; url: string; headers: Record<string, string>; body: string | null }[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const req = new Request(target, init);
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    const body = init?.body ? String(init.body) : null;
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    calls.push({ method: req.method, url: req.url, headers, body });
    const handler = routes[key];
    if (!handler) return new Response(`unrouted: ${key}`, { status: 500 });
    return handler(req);
  };
  return { fetch: impl as typeof fetch, calls };
}

describe("OrbClient", () => {
  it("register mints api_key and stores it", async () => {
    const { fetch, calls } = stubFetch({
      "POST /api/v1/auth/register": async (req) => {
        const body = (await req.json()) as { email: string };
        expect(body.email).toBe("sam@example.com");
        expect(req.headers.get("authorization")).toBeNull();
        return new Response(JSON.stringify({ api_key: "orb_test_123", tenant_id: "t1" }), { status: 200 });
      },
    });
    const c = new OrbClient({ fetchImpl: fetch });
    const out = await c.register("sam@example.com");
    expect(out.api_key).toBe("orb_test_123");
    expect(c.apiKey).toBe("orb_test_123");
    expect(calls.length).toBe(1);
  });

  it("createComputer sends bearer + json body", async () => {
    const { fetch } = stubFetch({
      "POST /v1/computers": async (req) => {
        expect(req.headers.get("authorization")).toBe("Bearer orb_k");
        const body = (await req.json()) as { name: string; runtime_mb: number; disk_mb: number };
        expect(body).toEqual({ name: "dev", runtime_mb: 2048, disk_mb: 10240 });
        return new Response(
          JSON.stringify({ computer_id: "abcdef1234567890", short_id: "abcd1234", name: "dev", runtime_mb: 2048, disk_mb: 10240 }),
          { status: 201 },
        );
      },
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "orb_k" });
    const comp = await c.createComputer({ name: "dev", runtime_mb: 2048, disk_mb: 10240 });
    expect(comp.computer_id).toBe("abcdef1234567890");
    expect(comp.short_id).toBe("abcd1234");
  });

  it("uploadConfig sends TOML content-type", async () => {
    const { fetch, calls } = stubFetch({
      "POST /v1/computers/c1/config": () => new Response(null, { status: 200 }),
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "k" });
    await c.uploadConfig("c1", "[agent]\nname=\"x\"\n");
    expect(calls[0]?.headers["content-type"]).toBe("application/toml");
    expect(calls[0]?.body).toContain("[agent]");
  });

  it("build sends no body by default, includes org_secrets when provided", async () => {
    const bodies: (string | null)[] = [];
    const { fetch } = stubFetch({
      "POST /v1/computers/c1/build": async (req) => {
        bodies.push((await req.text()) || null);
        return new Response(null, { status: 200 });
      },
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "k" });
    await c.build("c1");
    await c.build("c1", { orgSecrets: { GITHUB_TOKEN: "ghp_x" } });
    expect(bodies[0]).toBeNull();
    expect(JSON.parse(bodies[1]!)).toEqual({ org_secrets: { GITHUB_TOKEN: "ghp_x" } });
  });

  it("startAgent builds body from task/count/org_secrets/orb_config", async () => {
    const bodies: string[] = [];
    const { fetch } = stubFetch({
      "POST /v1/computers/c1/agents": async (req) => {
        bodies.push(await req.text());
        return new Response(JSON.stringify({ computer_id: "c1", port: 10000, pid: 42, state: "Running" }), { status: 201 });
      },
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "k" });
    const a1 = await c.startAgent("c1");
    const a2 = await c.startAgent("c1", { orgSecrets: { ANTHROPIC_API_KEY: "sk" } });
    const a3 = await c.startAgent("c1", { task: "fix bug", count: 2, orgSecrets: { GITHUB_TOKEN: "t" } });
    expect(a1.port).toBe(10000);
    expect(a1.pid).toBe(42);
    expect(JSON.parse(bodies[0]!)).toEqual({});
    expect(JSON.parse(bodies[1]!)).toEqual({ org_secrets: { ANTHROPIC_API_KEY: "sk" } });
    expect(JSON.parse(bodies[2]!)).toEqual({ task: "fix bug", count: 2, org_secrets: { GITHUB_TOKEN: "t" } });
  });

  it("promote + demote require port in body", async () => {
    const seen: Array<{ path: string; body: string }> = [];
    const { fetch } = stubFetch({
      "POST /v1/computers/c1/agents/promote": async (r) => {
        seen.push({ path: new URL(r.url).pathname, body: await r.text() });
        return new Response(null, { status: 200 });
      },
      "POST /v1/computers/c1/agents/demote": async (r) => {
        seen.push({ path: new URL(r.url).pathname, body: await r.text() });
        return new Response(null, { status: 200 });
      },
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "k" });
    await c.promote("c1", 10000);
    await c.demote("c1", 10001);
    expect(seen[0]).toEqual({ path: "/v1/computers/c1/agents/promote", body: '{"port":10000}' });
    expect(seen[1]).toEqual({ path: "/v1/computers/c1/agents/demote", body: '{"port":10001}' });
  });

  it("usage requires start + end query params", async () => {
    const { fetch, calls } = stubFetch({
      "GET /v1/usage": () => new Response(JSON.stringify({ runtime_gb_hours: 1.2, disk_gb_hours: 3.4 }), { status: 200 }),
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "k" });
    const r = await c.usage({ start: "2026-03-01T00:00:00Z", end: "2026-03-15T23:59:59Z" });
    expect(r.runtime_gb_hours).toBe(1.2);
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("start")).toBe("2026-03-01T00:00:00Z");
    expect(u.searchParams.get("end")).toBe("2026-03-15T23:59:59Z");
  });

  it("usage refuses missing params", async () => {
    const c = new OrbClient({ apiKey: "k" });
    await expect(c.usage({ start: "", end: "" })).rejects.toThrow(/start and end/);
  });

  it("raw throws OrbApiError on non-2xx with body text", async () => {
    const { fetch } = stubFetch({
      "GET /v1/computers/c1": () => new Response("nope", { status: 404 }),
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "k" });
    try {
      await c.getComputer("c1");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(OrbApiError);
      expect((e as OrbApiError).status).toBe(404);
      expect((e as OrbApiError).body).toBe("nope");
    }
  });

  it("liveUrl prefers short_id from response, falls back to id/string", () => {
    const c = new OrbClient({ apiKey: "k" });
    expect(c.liveUrl({ short_id: "ab12cd34", name: "x", runtime_mb: 1, disk_mb: 1 })).toBe("https://ab12cd34.orbcloud.dev");
    expect(c.liveUrl({ computer_id: "abcdef1234567890", name: "x", runtime_mb: 1, disk_mb: 1 })).toBe("https://abcdef12.orbcloud.dev");
    expect(c.liveUrl("abcdef1234567890")).toBe("https://abcdef12.orbcloud.dev");
  });

  it("listComputers + listAgents normalize array vs wrapped shapes", async () => {
    const { fetch } = stubFetch({
      "GET /v1/computers": () => new Response(JSON.stringify([{ name: "a", runtime_mb: 1, disk_mb: 1 }]), { status: 200 }),
      "GET /v1/computers/c1/agents": () => new Response(JSON.stringify({ agents: [{ computer_id: "c1", port: 10000 }] }), { status: 200 }),
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "k" });
    expect((await c.listComputers()).length).toBe(1);
    const agents = await c.listAgents("c1");
    expect(agents[0]?.port).toBe(10000);
  });

  it("refuses authed call without api_key", async () => {
    const c = new OrbClient();
    await expect(c.getComputer("x")).rejects.toThrow(/no api_key/);
  });
});
