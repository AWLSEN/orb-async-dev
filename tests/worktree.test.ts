import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorktreeManager, sanitize } from "../agent/worktree.ts";
import type { RunInput, RunResult, Runner } from "../agent/runner.ts";

function recordingRunner(responses: Partial<Record<string, RunResult>> = {}): {
  runner: Runner;
  calls: RunInput[];
} {
  const calls: RunInput[] = [];
  const runner: Runner = async (input) => {
    calls.push(input);
    const key = input.cmd.join(" ");
    const hit = responses[key];
    if (hit) return hit;
    return { stdout: "", stderr: "", code: 0 };
  };
  return { runner, calls };
}

describe("sanitize", () => {
  it("converts slashes/spaces to dashes", () => {
    expect(sanitize("owner/repo-name")).toBe("owner-repo-name");
    expect(sanitize("feat/login bug 2")).toBe("feat-login-bug-2");
  });
  it("preserves safe chars", () => {
    expect(sanitize("a.b_c-d")).toBe("a.b_c-d");
  });
  it("collapses leading/trailing dashes", () => {
    expect(sanitize("/foo//bar/")).toBe("foo-bar");
  });
  it("falls back to x on empty / all-unsafe input", () => {
    expect(sanitize("")).toBe("x");
    expect(sanitize("!!!")).toBe("x");
  });
});

describe("WorktreeManager — command shape", () => {
  let tmp: string;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("ensureRepo runs git clone on first use", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "wt-"));
    const { runner, calls } = recordingRunner();
    const wt = new WorktreeManager({ workRoot: tmp, runner });
    await wt.ensureRepo({ repoName: "nextbysam/demo", cloneUrl: "https://x/y.git", defaultBranch: "main" });
    expect(calls[0]?.cmd[0]).toBe("git");
    expect(calls[0]?.cmd[1]).toBe("clone");
    expect(calls[0]?.cmd).toContain("https://x/y.git");
    expect(calls[0]?.cmd).toContain("--branch");
    expect(calls[0]?.cmd).toContain("main");
  });

  it("createTaskWorktree requires ensureRepo first", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "wt-"));
    const { runner } = recordingRunner();
    const wt = new WorktreeManager({ workRoot: tmp, runner });
    await expect(
      wt.createTaskWorktree({ repoName: "nextbysam/demo", branchName: "fix/x", baseBranch: "main" }),
    ).rejects.toThrow(/not cloned yet/);
  });

  it("createTaskWorktree runs `git worktree add -b <branch> <path> origin/<base>`", async () => {
    tmp = await mkdtemp(path.join(tmpdir(), "wt-"));
    const { runner, calls } = recordingRunner();
    const wt = new WorktreeManager({ workRoot: tmp, runner });

    // Seed a fake repo dir so ensureRepo thinks it's cloned.
    const repoDir = path.join(tmp, "nextbysam-demo");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.join(repoDir, ".git"), { recursive: true });
    await writeFile(path.join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");

    const out = await wt.createTaskWorktree({ repoName: "nextbysam/demo", branchName: "fix/x", baseBranch: "main" });
    expect(out.dir).toBe(path.join(tmp, "nextbysam-demo-tasks", "fix-x"));
    expect(out.branchName).toBe("fix/x");
    const cmd = calls[0]?.cmd ?? [];
    expect(cmd.slice(0, 5)).toEqual(["git", "worktree", "add", "-b", "fix/x"]);
    expect(cmd[5]).toBe(out.dir);
    expect(cmd[6]).toBe("origin/main");
  });
});

describe("WorktreeManager — listTaskWorktrees parses porcelain", () => {
  it("returns only branches rooted under <repo>-tasks/", async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), "wt-"));
    try {
      const tasksDir = path.join(tmp, "nextbysam-demo-tasks");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(path.join(tmp, "nextbysam-demo", ".git"), { recursive: true });
      await writeFile(path.join(tmp, "nextbysam-demo", ".git", "HEAD"), "ref: refs/heads/main\n");

      const stdout = [
        `worktree ${path.join(tmp, "nextbysam-demo")}`,
        "HEAD abc",
        "branch refs/heads/main",
        "",
        `worktree ${path.join(tasksDir, "fix-x")}`,
        "HEAD def",
        "branch refs/heads/fix/x",
        "",
        `worktree ${path.join(tasksDir, "feat-y")}`,
        "HEAD ghi",
        "branch refs/heads/feat/y",
        "",
      ].join("\n");

      const { runner } = recordingRunner({ "git worktree list --porcelain": { stdout, stderr: "", code: 0 } });
      const wt = new WorktreeManager({ workRoot: tmp, runner });
      const branches = await wt.listTaskWorktrees("nextbysam/demo");
      expect(branches.sort()).toEqual(["feat/y", "fix/x"]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
