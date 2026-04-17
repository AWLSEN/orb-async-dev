import { describe, expect, it } from "bun:test";
import { DEFAULT_RESOURCES, fromEnv, renderOrbToml, requiredSecrets, tomlEscape } from "../deploy/orb-toml.ts";

describe("tomlEscape", () => {
  it("escapes backslashes and double-quotes", () => {
    expect(tomlEscape('a"b\\c')).toBe('a\\"b\\\\c');
  });
  it("escapes newlines and tabs", () => {
    expect(tomlEscape("a\nb\tc")).toBe("a\\nb\\tc");
  });
});

describe("renderOrbToml", () => {
  const base = {
    computerName: "orb-async-dev",
    sourceGit: "https://github.com/AWLSEN/orb-async-dev",
    sourceBranch: "main",
    runtimeMb: 2048,
    diskMb: 10240,
    port: 8000,
    llm: { baseUrl: "https://api.anthropic.com", model: "claude-opus-4-7", secretName: "ANTHROPIC_API_KEY" as const },
    env: { NODE_ENV: "production", GITHUB_REPO: "AWLSEN/orb-async-dev-demo" },
    secrets: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "WEBHOOK_SECRET"],
  };

  it("renders all mandatory sections", () => {
    const toml = renderOrbToml(base);
    for (const section of ["[agent]", "[source]", "[build]", "[llm]", "[ports]", "[resources]", "[agent.env]"]) {
      expect(toml.includes(section)).toBe(true);
    }
  });

  it("writes secret placeholders as ${NAME} on secret lines but literal values on env lines", () => {
    const toml = renderOrbToml(base);
    expect(toml).toMatch(/ANTHROPIC_API_KEY = "\$\{ANTHROPIC_API_KEY\}"/);
    expect(toml).toMatch(/GITHUB_TOKEN = "\$\{GITHUB_TOKEN\}"/);
    expect(toml).toMatch(/WEBHOOK_SECRET = "\$\{WEBHOOK_SECRET\}"/);
    expect(toml).toMatch(/NODE_ENV = "production"/);
    expect(toml).toMatch(/GITHUB_REPO = "AWLSEN\/orb-async-dev-demo"/);
  });

  it("sorts env keys and secret keys for stable diffs", () => {
    const toml = renderOrbToml({ ...base, env: { B: "2", A: "1" }, secrets: ["Z", "A"] });
    const aIdx = toml.indexOf('A = "1"');
    const bIdx = toml.indexOf('B = "2"');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    const secA = toml.indexOf('A = "${A}"');
    const secZ = toml.indexOf('Z = "${Z}"');
    expect(secA).toBeGreaterThan(-1);
    expect(secZ).toBeGreaterThan(secA);
  });

  it("exposes the declared port as an integer list", () => {
    expect(renderOrbToml({ ...base, port: 9090 })).toMatch(/expose = \[9090\]/);
  });

  it("renders runtime_mb + disk_mb as integers (matches docs.orbcloud.dev)", () => {
    const toml = renderOrbToml({ ...base, runtimeMb: 4096, diskMb: 20480 });
    expect(toml).toMatch(/runtime_mb\s*=\s*4096/);
    expect(toml).toMatch(/disk_mb\s*=\s*20480/);
  });
});

describe("fromEnv", () => {
  it("fails without GITHUB_REPO", () => {
    expect(() => fromEnv({})).toThrow(/GITHUB_REPO/);
  });

  it("picks ANTHROPIC_AUTH_TOKEN when proxy-flow is set", () => {
    const input = fromEnv({ GITHUB_REPO: "o/r", ANTHROPIC_AUTH_TOKEN: "x", ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" });
    expect(input.llm.secretName).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(input.secrets).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(input.llm.baseUrl).toBe("https://api.z.ai/api/anthropic");
  });

  it("defaults to native Anthropic when no proxy", () => {
    const input = fromEnv({ GITHUB_REPO: "o/r" });
    expect(input.llm.secretName).toBe("ANTHROPIC_API_KEY");
    expect(input.llm.baseUrl).toBe("https://api.anthropic.com");
    expect(input.runtimeMb).toBe(DEFAULT_RESOURCES.runtimeMb);
    expect(input.diskMb).toBe(DEFAULT_RESOURCES.diskMb);
    expect(input.port).toBe(DEFAULT_RESOURCES.port);
  });

  it("respects ORB_* overrides", () => {
    const input = fromEnv({
      GITHUB_REPO: "o/r",
      ORB_COMPUTER_NAME: "custom",
      ORB_RUNTIME_MB: "4096",
      ORB_DISK_MB: "20480",
      ORB_PORT: "9090",
      ORB_SOURCE_BRANCH: "dev",
    });
    expect(input.computerName).toBe("custom");
    expect(input.runtimeMb).toBe(4096);
    expect(input.diskMb).toBe(20480);
    expect(input.port).toBe(9090);
    expect(input.sourceBranch).toBe("dev");
  });

  it("round-trips through renderOrbToml to produce a valid TOML body", () => {
    const input = fromEnv({ GITHUB_REPO: "AWLSEN/orb-async-dev-demo" });
    const toml = renderOrbToml(input);
    expect(toml).toContain('name  = "orb-async-dev"');
    expect(toml).toContain('GITHUB_REPO = "AWLSEN/orb-async-dev-demo"');
    expect(toml).toContain('ANTHROPIC_API_KEY = "${ANTHROPIC_API_KEY}"');
    expect(toml).toContain('GITHUB_TOKEN = "${GITHUB_TOKEN}"');
    expect(toml).toContain('WEBHOOK_SECRET = "${WEBHOOK_SECRET}"');
  });
});

describe("requiredSecrets", () => {
  it("includes the chosen LLM secret plus GITHUB_TOKEN + WEBHOOK_SECRET", () => {
    expect(requiredSecrets("ANTHROPIC_API_KEY")).toEqual(["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "WEBHOOK_SECRET"]);
    expect(requiredSecrets("ANTHROPIC_AUTH_TOKEN")).toEqual(["ANTHROPIC_AUTH_TOKEN", "GITHUB_TOKEN", "WEBHOOK_SECRET"]);
  });
});
