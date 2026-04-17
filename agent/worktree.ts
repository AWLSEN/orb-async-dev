// Manage per-task git worktrees under ./work/. Each sub-agent runs in its own
// worktree so parallel tasks can't collide on the filesystem, yet they still
// share the warm ./work/<repo>/.git object store + node_modules.
//
// Layout:
//   ./work/<repo-name>/                 (bare-ish primary clone on default branch)
//   ./work/<repo-name>-tasks/<branch>/  (worktree per task branch)

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnProcess, type RunResult, type Runner, nodeRunner } from "./runner.ts";

export interface WorktreeOpts {
  /** Absolute path where ./work/ lives. Defaults to cwd/work. */
  workRoot?: string;
  /** Injectable runner for tests; defaults to real child_process.spawn. */
  runner?: Runner;
}

export interface EnsureRepoInput {
  repoName: string; // "owner/name"
  cloneUrl: string; // https URL with embedded token for private repos
  defaultBranch: string;
}

export interface CreateTaskWorktreeInput {
  repoName: string;
  branchName: string;
  baseBranch: string;
}

export interface TaskWorktree {
  dir: string;
  branchName: string;
  baseBranch: string;
}

export class WorktreeManager {
  readonly workRoot: string;
  private readonly runner: Runner;

  constructor(opts: WorktreeOpts = {}) {
    this.workRoot = opts.workRoot ?? path.join(process.cwd(), "work");
    this.runner = opts.runner ?? nodeRunner;
  }

  private repoDir(repoName: string): string {
    return path.join(this.workRoot, sanitize(repoName));
  }

  private tasksDir(repoName: string): string {
    return path.join(this.workRoot, sanitize(repoName) + "-tasks");
  }

  private taskPath(repoName: string, branchName: string): string {
    return path.join(this.tasksDir(repoName), sanitize(branchName));
  }

  /** Clone the repo (once) and pull latest on the default branch. Idempotent. */
  async ensureRepo(input: EnsureRepoInput): Promise<string> {
    await mkdir(this.workRoot, { recursive: true });
    const repoDir = this.repoDir(input.repoName);
    if (!existsSync(path.join(repoDir, ".git"))) {
      await this.run(["git", "clone", "--branch", input.defaultBranch, "--", input.cloneUrl, repoDir], { cwd: this.workRoot });
    } else {
      await this.run(["git", "fetch", "origin", input.defaultBranch], { cwd: repoDir });
      await this.run(["git", "checkout", input.defaultBranch], { cwd: repoDir });
      await this.run(["git", "reset", "--hard", `origin/${input.defaultBranch}`], { cwd: repoDir });
    }
    return repoDir;
  }

  /** Create a new branch worktree at <tasks>/<branch>. Base branch must exist on origin. */
  async createTaskWorktree(input: CreateTaskWorktreeInput): Promise<TaskWorktree> {
    const repoDir = this.repoDir(input.repoName);
    if (!existsSync(repoDir)) throw new Error(`worktree: repo not cloned yet at ${repoDir}`);
    await mkdir(this.tasksDir(input.repoName), { recursive: true });
    const targetDir = this.taskPath(input.repoName, input.branchName);
    if (existsSync(targetDir)) {
      throw new Error(`worktree: already exists at ${targetDir} (call removeTaskWorktree first)`);
    }
    await this.run(
      ["git", "worktree", "add", "-b", input.branchName, targetDir, `origin/${input.baseBranch}`],
      { cwd: repoDir },
    );
    return { dir: targetDir, branchName: input.branchName, baseBranch: input.baseBranch };
  }

  /** Tear down a worktree + delete its branch locally. Doesn't push the delete. */
  async removeTaskWorktree(repoName: string, branchName: string): Promise<void> {
    const repoDir = this.repoDir(repoName);
    const target = this.taskPath(repoName, branchName);
    if (!existsSync(target)) return;
    await this.run(["git", "worktree", "remove", "--force", target], { cwd: repoDir });
    await this.run(["git", "branch", "-D", branchName], { cwd: repoDir }).catch(() => undefined);
    if (existsSync(target)) await rm(target, { recursive: true, force: true });
  }

  /** List existing task worktrees (branch names) under this repo. */
  async listTaskWorktrees(repoName: string): Promise<string[]> {
    const repoDir = this.repoDir(repoName);
    if (!existsSync(repoDir)) return [];
    const res = await this.run(["git", "worktree", "list", "--porcelain"], { cwd: repoDir });
    const branches: string[] = [];
    for (const block of res.stdout.split(/\n\n+/)) {
      const lines = block.split(/\n/);
      let wt: string | undefined;
      let branch: string | undefined;
      for (const l of lines) {
        if (l.startsWith("worktree ")) wt = l.slice("worktree ".length);
        if (l.startsWith("branch refs/heads/")) branch = l.slice("branch refs/heads/".length);
      }
      if (wt && branch && wt.startsWith(this.tasksDir(repoName) + path.sep)) branches.push(branch);
    }
    return branches;
  }

  async run(cmd: string[], opts: { cwd: string }): Promise<RunResult> {
    return this.runner({ cmd, cwd: opts.cwd });
  }
}

/** Compute a safe filesystem slug — collapses slashes, spaces, unsafe chars. */
export function sanitize(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/** Default runner wrapping spawnProcess so callers don't need to import it. */
export { spawnProcess };
