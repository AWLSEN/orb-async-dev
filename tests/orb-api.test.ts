import { describe, expect, it } from "bun:test";
import { OrbApiError, OrbClient } from "../deploy/orb-api.ts";

function stubFetch(routes: Record<string, (req: Request) => Response | Promise<Response>>): {
  fetch: typeof fetch;
  calls: { method: string; url: string; headers: Record<string, string>; body: string | null }[];
} {
  const calls: { method: string; url: string; headers: Record<string, string>; body: string | null }[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as any, init);
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
        return new Response(JSON.stringify({ api_key: "orb_test_123" }), { status: 200 });
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
        return new Response(JSON.stringify({ id: "abcdef1234", name: "dev", runtime_mb: 2048, disk_mb: 10240 }), { status: 201 });
      },
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "orb_k" });
    const comp = await c.createComputer({ name: "dev", runtime_mb: 2048, disk_mb: 10240 });
    expect(comp.id).toBe("abcdef1234");
  });

  it("uploadConfig sends TOML content-type", async () => {
    const { fetch, calls } = stubFetch({
      "POST /v1/computers/c1/config": () => new Response(null, { status: 204 }),
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "k" });
    await c.uploadConfig("c1", "[agent]\nname=\"x\"\n");
    expect(calls[0]?.headers["content-type"]).toBe("application/toml");
    expect(calls[0]?.body).toContain("[agent]");
  });

  it("startAgent omits org_secrets when empty, includes when present", async () => {
    const seen: string[] = [];
    const { fetch } = stubFetch({
      "POST /v1/computers/c1/agents": async (req) => {
        seen.push((await req.text()) || "");
        return new Response(JSON.stringify({ id: "a1", computer_id: "c1" }), { status: 200 });
      },
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "k" });
    await c.startAgent("c1");
    await c.startAgent("c1", { ANTHROPIC_API_KEY: "sk-xxx" });
    expect(seen[0]).toBe("{}");
    expect(JSON.parse(seen[1]!)).toEqual({ org_secrets: { ANTHROPIC_API_KEY: "sk-xxx" } });
  });

  it("promote + demote hit the right paths", async () => {
    const hit: string[] = [];
    const { fetch } = stubFetch({
      "POST /v1/computers/c1/agents/promote": (r) => {
        hit.push(new URL(r.url).pathname);
        return new Response(null, { status: 204 });
      },
      "POST /v1/computers/c1/agents/demote": (r) => {
        hit.push(new URL(r.url).pathname);
        return new Response(null, { status: 204 });
      },
    });
    const c = new OrbClient({ fetchImpl: fetch, apiKey: "k" });
    await c.promote("c1");
    await c.demote("c1");
    expect(hit).toEqual(["/v1/computers/c1/agents/promote", "/v1/computers/c1/agents/demote"]);
  });

  it("usage normalizes row-shape and array-shape responses", async () => {
    for (const payload of [[{ period_start: "a", period_end: "b" }], { rows: [{ period_start: "a", period_end: "b" }] }]) {
      const { fetch } = stubFetch({
        "GET /v1/usage": () => new Response(JSON.stringify(payload), { status: 200 }),
      });
      const c = new OrbClient({ fetchImpl: fetch, apiKey: "k" });
      const rows = await c.usage();
      expect(rows.length).toBe(1);
      expect(rows[0]?.period_start).toBe("a");
    }
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

  it("liveUrl uses first-8-chars-of-id", () => {
    const c = new OrbClient({ apiKey: "k" });
    expect(c.liveUrl("abcdef1234567890")).toBe("https://abcdef12.orbcloud.dev");
  });

  it("refuses authed call without api_key", async () => {
    const c = new OrbClient();
    await expect(c.getComputer("x")).rejects.toThrow(/no api_key/);
  });
});
