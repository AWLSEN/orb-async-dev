import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCanary, runCanaryAndNotify, type CanaryDeps } from "../agent/health/canary.ts";
import type { RunInput, RunResult, Runner } from "../agent/runner.ts";

async function withWork<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const d = await mkdtemp(path.join(tmpdir(), "canary-"));
  try {
    return await fn(d);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
}

function recordingRunner(mocks: Partial<Record<string, RunResult>> = {}): { runner: Runner; calls: RunInput[] } {
  const calls: RunInput[] = [];
  const runner: Runner = async (input) => {
    calls.push(input);
    const key = input.cmd.join(" ");
    const hit = mocks[key];
    if (hit) return hit;
    return { stdout: "", stderr: "", code: 0 };
  };
  return { runner, calls };
}

async function seedRepo(workRoot: string, repoName: string, withPkg: boolean): Promise<string> {
  const repoDir = path.join(workRoot, repoName.replace(/[^A-Za-z0-9._-]+/g, "-"));
  await mkdir(path.join(repoDir, ".git"), { recursive: true });
  await writeFile(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
  if (withPkg) {
    await writeFile(path.join(repoDir, "bun.lock"), "");
    await writeFile(path.join(repoDir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
  }
  return repoDir;
}

function deps(workRoot: string, runner: Runner, overrides: Partial<CanaryDeps> = {}): CanaryDeps {
  return {
    workRoot,
    runner,
    repoName: "nextbysam/demo",
    cloneUrl: "https://github.com/nextbysam/demo.git",
    defaultBranch: "main",
    ...overrides,
  };
}

describe("runCanary", () => {
  it("ok when clone + status + detect + tests all pass", async () => {
    await withWork(async (root) => {
      await seedRepo(root, "nextbysam/demo", true);
      const { runner } = recordingRunner();
      const r = await runCanary(deps(root, runner));
      expect(r.ok).toBe(true);
      expect(r.stage).toBe("test");
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  it("fails at status stage when git reports non-zero", async () => {
    await withWork(async (root) => {
      await seedRepo(root, "nextbysam/demo", true);
      const { runner } = recordingRunner({
        "git status --porcelain": { stdout: "", stderr: "dirty", code: 1 },
      });
      const r = await runCanary(deps(root, runner));
      expect(r.ok).toBe(false);
      expect(r.stage).toBe("status");
      expect(r.reason).toMatch(/exit=1/);
      expect(r.details).toContain("dirty");
    });
  });

  it("fails at detect stage when stack is unknown", async () => {
    await withWork(async (root) => {
      await seedRepo(root, "nextbysam/demo", false); // no manifest
      const { runner } = recordingRunner();
      const r = await runCanary(deps(root, runner));
      expect(r.ok).toBe(false);
      expect(r.stage).toBe("detect");
    });
  });

  it("fails at test stage with stderr tail", async () => {
    await withWork(async (root) => {
      await seedRepo(root, "nextbysam/demo", true);
      const { runner } = recordingRunner({
        "bash -c bun run test": { stdout: "", stderr: "1 failure", code: 1 },
      });
      const r = await runCanary(deps(root, runner));
      expect(r.ok).toBe(false);
      expect(r.stage).toBe("test");
      expect(r.details).toContain("1 failure");
    });
  });

  it("fails at clone stage when ensureRepo throws", async () => {
    await withWork(async (root) => {
      const throwing: Runner = async (input) => {
        if (input.cmd[0] === "git" && input.cmd[1] === "clone") throw new Error("network down");
        return { stdout: "", stderr: "", code: 0 };
      };
      const r = await runCanary(deps(root, throwing));
      expect(r.ok).toBe(false);
      expect(r.stage).toBe("clone");
      expect(r.reason).toMatch(/network down/);
    });
  });
});

describe("runCanaryAndNotify", () => {
  it("does not notify on success", async () => {
    await withWork(async (root) => {
      await seedRepo(root, "nextbysam/demo", true);
      const notified: string[] = [];
      const { runner } = recordingRunner();
      await runCanaryAndNotify(deps(root, runner, { notify: (m) => { notified.push(m); } }));
      expect(notified).toEqual([]);
    });
  });

  it("notifies on failure with stage + reason in the message", async () => {
    await withWork(async (root) => {
      await seedRepo(root, "nextbysam/demo", true);
      const notified: string[] = [];
      const { runner } = recordingRunner({
        "bash -c bun run test": { stdout: "", stderr: "1 failure", code: 1 },
      });
      await runCanaryAndNotify(deps(root, runner, { notify: (m) => { notified.push(m); } }));
      expect(notified.length).toBe(1);
      expect(notified[0]).toMatch(/\[canary\] test failed:/);
      expect(notified[0]).toContain("1 failure");
    });
  });
});
