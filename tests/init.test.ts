import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateWebhookSecret, loadExistingEnv, renderEnvFile } from "../cli/init.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const d = await mkdtemp(path.join(tmpdir(), "init-"));
  try {
    return await fn(d);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
}

describe("loadExistingEnv", () => {
  it("returns {} when .env doesn't exist", async () => {
    await withDir(async (d) => {
      expect(await loadExistingEnv(path.join(d, ".env"))).toEqual({});
    });
  });

  it("parses values from an existing .env, quotes stripped", async () => {
    await withDir(async (d) => {
      const p = path.join(d, ".env");
      await writeFile(
        p,
        `# comment
GITHUB_REPO="nextbysam/demo"
GITHUB_TOKEN=ghp_abc
ANTHROPIC_AUTH_TOKEN=zai_xyz
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
WEBHOOK_SECRET=deadbeef
DAILY_COST_CAP_USD=7
`,
      );
      const out = await loadExistingEnv(p);
      expect(out.ghRepo).toBe("nextbysam/demo");
      expect(out.ghToken).toBe("ghp_abc");
      expect(out.anthropicAuthToken).toBe("zai_xyz");
      expect(out.anthropicBaseUrl).toBe("https://api.z.ai/api/anthropic");
      expect(out.webhookSecret).toBe("deadbeef");
      expect(out.cap).toBe("7");
    });
  });

  it("falls back to ANTHROPIC_API_KEY when AUTH_TOKEN absent", async () => {
    await withDir(async (d) => {
      const p = path.join(d, ".env");
      await writeFile(p, "ANTHROPIC_API_KEY=sk-direct\n");
      const out = await loadExistingEnv(p);
      expect(out.anthropicAuthToken).toBe("sk-direct");
    });
  });
});

describe("renderEnvFile", () => {
  const base = {
    ghRepo: "nextbysam/demo",
    ghToken: "ghp_x",
    orbApiKey: "orb_k",
    anthropicAuthToken: "sk-x",
    anthropicBaseUrl: "https://api.anthropic.com",
    webhookSecret: "secret",
    cap: "5",
  };

  it("writes ANTHROPIC_API_KEY for native Anthropic base", () => {
    const out = renderEnvFile({ ...base });
    expect(out).toContain("ANTHROPIC_API_KEY=sk-x");
    expect(out).not.toContain("ANTHROPIC_AUTH_TOKEN=");
  });

  it("writes ANTHROPIC_AUTH_TOKEN for proxy base", () => {
    const out = renderEnvFile({ ...base, anthropicBaseUrl: "https://api.z.ai/api/anthropic" });
    expect(out).toContain("ANTHROPIC_AUTH_TOKEN=sk-x");
    expect(out).not.toContain("ANTHROPIC_API_KEY=");
  });

  it("includes all the required keys once", () => {
    const out = renderEnvFile(base);
    for (const key of ["ORB_API_KEY", "GITHUB_TOKEN", "GITHUB_REPO", "WEBHOOK_SECRET", "ANTHROPIC_BASE_URL", "DAILY_COST_CAP_USD"]) {
      const count = [...out.matchAll(new RegExp(`^${key}=`, "gm"))].length;
      expect(count).toBe(1);
    }
  });
});

describe("generateWebhookSecret", () => {
  it("produces 64 lowercase hex chars", () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^[a-f0-9]{64}$/);
  });
  it("two calls produce different values", () => {
    expect(generateWebhookSecret()).not.toBe(generateWebhookSecret());
  });
});
