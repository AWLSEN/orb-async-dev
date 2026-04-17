import { afterAll, describe, expect, it } from "bun:test";
import { createOrchestrator } from "../agent/orchestrator.ts";

const server = createOrchestrator({ port: 0 });
const base = `http://localhost:${server.port}`;
afterAll(() => server.stop(true));

describe("orchestrator HTTP surface", () => {
  it("GET /health returns 200 ok", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("POST /github/webhook returns 501 until batch 2 wires it", async () => {
    const res = await fetch(`${base}/github/webhook`, { method: "POST", body: "{}" });
    expect(res.status).toBe(501);
  });

  it("unknown path returns 404", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it("GET on webhook path returns 404 (only POST is handled)", async () => {
    const res = await fetch(`${base}/github/webhook`);
    expect(res.status).toBe(404);
  });
});
