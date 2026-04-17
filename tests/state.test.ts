import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { State, mbFromSize, parseDotEnv, loadDotEnvInto } from "../deploy/state.ts";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const d = await mkdtemp(path.join(tmpdir(), "orb-state-test-"));
  try {
    return await fn(d);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
}

describe("State", () => {
  it("write then read round-trip with trim", async () => {
    await withTmp(async (dir) => {
      const s = new State(path.join(dir, "nested"));
      await s.write("x", "hello\n");
      expect(await s.read("x")).toBe("hello");
    });
  });

  it("read missing returns undefined", async () => {
    await withTmp(async (dir) => {
      const s = new State(dir);
      expect(await s.read("missing")).toBeUndefined();
    });
  });

  it("read empty-file returns undefined", async () => {
    await withTmp(async (dir) => {
      const s = new State(dir);
      await s.write("x", "   \n\n");
      expect(await s.read("x")).toBeUndefined();
    });
  });

  it("secret files are chmod 600", async () => {
    await withTmp(async (dir) => {
      const s = new State(dir);
      await s.write("api-key", "orb_secret", { secret: true });
      const { stat } = await import("node:fs/promises");
      const info = await stat(path.join(dir, "api-key"));
      expect(info.mode & 0o777).toBe(0o600);
    });
  });
});

describe("mbFromSize", () => {
  const cases: [string, number][] = [
    ["2048", 2048],
    ["2048MB", 2048],
    ["2 GB", 2048],
    ["2GB", 2048],
    ["4gb", 4096],
    ["1tb", 1024 * 1024],
    ["512KB", 1], // 0.5 rounded up
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}MB`, () => expect(mbFromSize(input)).toBe(expected));
  }
  it("throws on garbage", () => {
    expect(() => mbFromSize("lots")).toThrow(/cannot parse/);
  });
});

describe("parseDotEnv", () => {
  it("parses KEY=VALUE with comments and blanks", () => {
    const input = `
# leading comment
FOO=bar
  BAZ = qux

# mid comment
QUOTED="has spaces"
SINGLE='also spaces'
EMPTY=
`;
    const out = parseDotEnv(input);
    expect(out).toEqual({
      FOO: "bar",
      BAZ: "qux",
      QUOTED: "has spaces",
      SINGLE: "also spaces",
      EMPTY: "",
    });
  });

  it("ignores malformed lines", () => {
    expect(parseDotEnv("NOEQUAL\n=LEADING\nOK=1")).toEqual({ OK: "1" });
  });
});

describe("loadDotEnvInto", () => {
  it("loads values but does not overwrite existing env", async () => {
    await withTmp(async (dir) => {
      const p = path.join(dir, ".env");
      await (await import("node:fs/promises")).writeFile(p, "A=1\nB=2\n");
      const env: Record<string, string | undefined> = { A: "already", B: undefined, C: undefined };
      await loadDotEnvInto(p, env);
      expect(env.A).toBe("already");
      expect(env.B).toBe("2");
      expect(env.C).toBeUndefined();
    });
  });

  it("noop when file missing", async () => {
    const env: Record<string, string | undefined> = { A: undefined };
    await loadDotEnvInto("/does/not/exist/.env", env);
    expect(env.A).toBeUndefined();
  });
});
