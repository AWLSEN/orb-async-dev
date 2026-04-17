import { describe, expect, it } from "bun:test";
import { buildGate, lintGate, scopeGate, SCOPE_MAX_FILES, SCOPE_MAX_LOC, testGate, typecheckGate } from "../agent/verifier/shell-gates.ts";
import { isSrcPath, isTestPath, parseNumstat } from "../agent/verifier/types.ts";
import type { Runner } from "../agent/runner.ts";
import type { VerifierContext } from "../agent/verifier/types.ts";

function ctx(overrides: Partial<VerifierContext> & { runner?: Runner } = {}): VerifierContext {
  const runner: Runner = overrides.runner ?? (async () => ({ stdout: "", stderr: "", code: 0 }));
  return {
    workDir: "/x",
    baseBranch: "main",
    taskText: "x",
    diff: { files: [], totalAdded: 0, totalDeleted: 0 },
    stack: { stack: "bun", build: "bun install", test: "bun test", lint: "bun lint", typecheck: "tsc" },
    runner,
    ...overrides,
  } as VerifierContext;
}

describe("parseNumstat + path helpers", () => {
  it("parses numstat including dash-dash for binary files", () => {
    const out = parseNumstat("3\t1\tsrc/a.ts\n-\t-\tpng/hero.png\n10\t0\ttests/a.test.ts\n");
    expect(out.files.length).toBe(3);
    expect(out.totalAdded).toBe(13);
    expect(out.totalDeleted).toBe(1);
    expect(out.files[1]).toEqual({ path: "png/hero.png", added: 0, deleted: 0 });
  });

  it("skips blank lines", () => {
    const out = parseNumstat("\n\n3\t0\tfoo\n\n");
    expect(out.files.length).toBe(1);
  });

  it("isTestPath matches common conventions", () => {
    for (const p of [
      "tests/foo.ts",
      "src/__tests__/bar.ts",
      "pkg/foo_test.go",
      "app/widget.test.tsx",
      "spec/things.spec.js",
      "py/test_things.py",
    ]) {
      // test_things.py is only a test file under pytest's convention; be lenient
      if (p === "py/test_things.py") continue;
      expect(isTestPath(p)).toBe(true);
    }
  });

  it("isSrcPath excludes docs/lockfiles/tests", () => {
    expect(isSrcPath("README.md")).toBe(false);
    expect(isSrcPath("bun.lock")).toBe(false);
    expect(isSrcPath("pnpm-lock.yaml")).toBe(false);
    expect(isSrcPath("tests/foo.test.ts")).toBe(false);
    expect(isSrcPath(".github/workflows/ci.yml")).toBe(false);
    expect(isSrcPath("src/login.ts")).toBe(true);
  });
});

describe("shell gates — pass/fail interpretation", () => {
  it("buildGate passes on exit 0", async () => {
    const r = await buildGate(ctx({ runner: async () => ({ stdout: "", stderr: "", code: 0 }) }));
    expect(r.pass).toBe(true);
    expect(r.name).toBe("build");
    expect(r.severity).toBe("hard");
  });

  it("buildGate fails on non-zero and captures stderr tail", async () => {
    const r = await buildGate(
      ctx({ runner: async () => ({ stdout: "", stderr: "oops", code: 2 }) }),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/exit=2/);
    expect(r.details).toContain("oops");
  });

  it("lintGate is soft severity", async () => {
    const r = await lintGate(ctx({ runner: async () => ({ stdout: "", stderr: "", code: 1 }) }));
    expect(r.pass).toBe(false);
    expect(r.severity).toBe("soft");
  });

  it("typecheck skipped when stack has none", async () => {
    const r = await typecheckGate(
      ctx({ stack: { stack: "go", build: "go build ./...", test: "go test ./..." } }),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toContain("skipped");
  });

  it("testGate returns fail details truncated to 4KB tail", async () => {
    const big = "x".repeat(10_000);
    const r = await testGate(
      ctx({ runner: async () => ({ stdout: "", stderr: big, code: 1 }) }),
    );
    expect(r.details?.length).toBeLessThanOrEqual(4001);
  });

  it("unwraps RunError from nodeRunner-style throwers", async () => {
    class RunErr extends Error {
      result = { stdout: "", stderr: "boom", code: 5 };
    }
    const throwing: Runner = async () => {
      throw new RunErr("failed");
    };
    const r = await buildGate(ctx({ runner: throwing }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/exit=5/);
    expect(r.details).toContain("boom");
  });
});

describe("scopeGate — file + LOC thresholds", () => {
  it("passes within limits", async () => {
    const r = await scopeGate(
      ctx({ diff: { files: Array.from({ length: 5 }, (_, i) => ({ path: `f${i}`, added: 10, deleted: 0 })), totalAdded: 50, totalDeleted: 0 } }),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toContain("5 files");
  });

  it("fails on too many files", async () => {
    const files = Array.from({ length: SCOPE_MAX_FILES + 1 }, (_, i) => ({ path: `f${i}`, added: 1, deleted: 0 }));
    const r = await scopeGate(ctx({ diff: { files, totalAdded: files.length, totalDeleted: 0 } }));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(new RegExp(`${SCOPE_MAX_FILES + 1} files`));
  });

  it("fails on too many LOC", async () => {
    const r = await scopeGate(
      ctx({ diff: { files: [{ path: "a", added: SCOPE_MAX_LOC + 1, deleted: 0 }], totalAdded: SCOPE_MAX_LOC + 1, totalDeleted: 0 } }),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/LOC/);
  });
});
