import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mutationGate, newTestsGate, NEW_TESTS_SRC_LOC_THRESHOLD } from "../agent/verifier/diff-gates.ts";
import type { Runner } from "../agent/runner.ts";
import type { VerifierContext } from "../agent/verifier/types.ts";

function ctx(overrides: Partial<VerifierContext> & { runner?: Runner } = {}): VerifierContext {
  const runner: Runner = overrides.runner ?? (async () => ({ stdout: "", stderr: "", code: 0 }));
  return {
    workDir: "/x",
    baseBranch: "main",
    taskText: "",
    diff: { files: [], totalAdded: 0, totalDeleted: 0 },
    stack: { stack: "bun", build: "bun install", test: "bun test" },
    runner,
    ...overrides,
  } as VerifierContext;
}

describe("newTestsGate", () => {
  it("passes when src change is under threshold", async () => {
    const r = await newTestsGate(
      ctx({ diff: { files: [{ path: "src/a.ts", added: NEW_TESTS_SRC_LOC_THRESHOLD, deleted: 0 }], totalAdded: 20, totalDeleted: 0 } }),
    );
    expect(r.pass).toBe(true);
  });

  it("fails when src > threshold and no test files touched", async () => {
    const r = await newTestsGate(
      ctx({ diff: { files: [{ path: "src/a.ts", added: 50, deleted: 0 }], totalAdded: 50, totalDeleted: 0 } }),
    );
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/no test lines/);
  });

  it("passes when src > threshold AND tests touched", async () => {
    const r = await newTestsGate(
      ctx({
        diff: {
          files: [
            { path: "src/a.ts", added: 50, deleted: 0 },
            { path: "tests/a.test.ts", added: 30, deleted: 0 },
          ],
          totalAdded: 80,
          totalDeleted: 0,
        },
      }),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/src 50 LOC \+ tests 30 LOC/);
  });

  it("non-src-only diffs (docs, lockfiles) don't require tests", async () => {
    const r = await newTestsGate(
      ctx({
        diff: {
          files: [
            { path: "README.md", added: 100, deleted: 0 },
            { path: "bun.lock", added: 200, deleted: 0 },
          ],
          totalAdded: 300,
          totalDeleted: 0,
        },
      }),
    );
    expect(r.pass).toBe(true);
  });
});

describe("mutationGate", () => {
  it("skipped when no src changes", async () => {
    const r = await mutationGate(
      ctx({ diff: { files: [{ path: "tests/a.test.ts", added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0 } }),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/no src changes/);
  });

  it("skipped when stack has no test command", async () => {
    const r = await mutationGate(
      ctx({
        diff: { files: [{ path: "src/a.ts", added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0 },
        stack: { stack: "unknown" },
      }),
    );
    expect(r.pass).toBe(true);
    expect(r.reason).toMatch(/skipped/);
  });

  it("fails when tests STILL PASS after reverting src", async () => {
    // Simulate: tests exit 0 even without the src change — i.e. the new test
    // doesn't exercise the fix.
    const runner: Runner = async (input) => {
      if (input.cmd[0] === "git") return { stdout: "", stderr: "", code: 0 };
      // test command
      return { stdout: "all pass", stderr: "", code: 0 };
    };
    const dir = await mkdtemp(path.join(tmpdir(), "mut-"));
    try {
      await writeFile(path.join(dir, "src-file.ts"), "current");
      const r = await mutationGate(
        ctx({
          workDir: dir,
          runner,
          diff: { files: [{ path: "src-file.ts", added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0 },
        }),
      );
      expect(r.pass).toBe(false);
      expect(r.reason).toMatch(/tests pass even without/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes when tests fail after reverting src (good signal)", async () => {
    const runner: Runner = async (input) => {
      if (input.cmd[0] === "git") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "test failures", code: 1 };
    };
    const dir = await mkdtemp(path.join(tmpdir(), "mut-"));
    try {
      await writeFile(path.join(dir, "src-file.ts"), "current");
      const r = await mutationGate(
        ctx({
          workDir: dir,
          runner,
          diff: { files: [{ path: "src-file.ts", added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0 },
        }),
      );
      expect(r.pass).toBe(true);
      expect(r.reason).toMatch(/exit=1/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restores src contents after run (even on pass)", async () => {
    const runner: Runner = async (input) => {
      if (input.cmd[0] === "git" && input.cmd[1] === "checkout") {
        const ref = input.cmd[2]!;
        const file = input.cmd[input.cmd.length - 1]!;
        // `git checkout origin/base -- <path>` reverts to base; `git checkout
        // HEAD -- <path>` should resync to HEAD (agent's NEW_VERSION). The
        // mutation gate's finally block issues both: first the in-memory
        // restore writes NEW_VERSION, then the HEAD checkout confirms it.
        if (ref.startsWith("origin/")) {
          await writeFile(path.join(input.cwd, file), "BASE_VERSION");
        } else if (ref === "HEAD") {
          await writeFile(path.join(input.cwd, file), "NEW_VERSION");
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "t", code: 1 };
    };
    const dir = await mkdtemp(path.join(tmpdir(), "mut-"));
    try {
      await writeFile(path.join(dir, "src-file.ts"), "NEW_VERSION");
      const r = await mutationGate(
        ctx({
          workDir: dir,
          runner,
          diff: { files: [{ path: "src-file.ts", added: 5, deleted: 0 }], totalAdded: 5, totalDeleted: 0 },
        }),
      );
      expect(r.pass).toBe(true);
      const restored = await readFile(path.join(dir, "src-file.ts"), "utf8");
      expect(restored).toBe("NEW_VERSION");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
