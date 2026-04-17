// End-to-end task runner: orchestrator webhook -> PR in the user's repo.
//
// Flow per task:
//   1. Pick default branch via GithubClient.
//   2. Ensure the repo clone exists at ./work/<repo>/ on the default branch.
//   3. Generate a branch name and create a worktree off origin/<default>.
//   4. Run the sub-agent in that worktree (tool-use loop).
//   5. If the agent produced a diff, commit + push the branch.
//   6. Open a PR and reply in the originating issue/comment thread.
//   7. Always tear down the worktree at the end.
//
// The verifier (batch 4) is a strict gate between step 5 and step 6; for
// batch 3 we proceed directly so end-to-end flow works on the demo repo.

import Anthropic from "@anthropic-ai/sdk";
import type { GithubClient } from "../adapters/github-client.ts";
import type { TaskRequest } from "../adapters/event-router.ts";
import { runSubAgent, type SubAgentResult } from "./sub-agent.ts";
import { verify, renderReport, type VerifyReport } from "./verifier/index.ts";
import { WorktreeManager } from "./worktree.ts";
import { nodeRunner, type Runner } from "./runner.ts";

export interface TaskRunnerOpts {
  github: GithubClient;
  anthropic: Pick<Anthropic, "messages">;
  workRoot: string;
  model: string;
  /** PAT or GitHub App installation token — embedded in clone URL for push access. */
  githubToken: string;
  runner?: Runner;
  onLog?: (line: string) => void;
}

export interface TaskRunnerResult {
  branch: string;
  pullNumber?: number;
  pullUrl?: string;
  committed: boolean;
  pushed: boolean;
  agent: SubAgentResult;
  verify?: VerifyReport;
}

export class TaskRunner {
  constructor(private readonly opts: TaskRunnerOpts) {}

  private log(line: string): void {
    this.opts.onLog?.(line) ?? process.stderr.write(`[task-runner] ${line}\n`);
  }

  async run(task: TaskRequest): Promise<TaskRunnerResult> {
    const wt = new WorktreeManager({
      workRoot: this.opts.workRoot,
      runner: this.opts.runner ?? nodeRunner,
    });
    const defaultBranch = await this.opts.github.getDefaultBranch();
    const cloneUrl = `https://x-access-token:${this.opts.githubToken}@github.com/${task.repo}.git`;
    await wt.ensureRepo({ repoName: task.repo, cloneUrl, defaultBranch });

    const branch = generateBranchName(task);
    const taskWt = await wt.createTaskWorktree({ repoName: task.repo, branchName: branch, baseBranch: defaultBranch });

    // Configure git author inside the worktree (commit attribution).
    await wt.run(["git", "config", "user.name", "orb-async-dev"], { cwd: taskWt.dir });
    await wt.run(["git", "config", "user.email", "bot@orb-async-dev"], { cwd: taskWt.dir });

    let committed = false;
    let pushed = false;
    let pullNumber: number | undefined;
    let pullUrl: string | undefined;
    let agent: SubAgentResult | undefined;

    try {
      this.log(`running agent on ${taskWt.dir}`);
      agent = await runSubAgent({
        client: this.opts.anthropic,
        workDir: taskWt.dir,
        model: this.opts.model,
        task: task.taskText,
        onLog: (l) => this.log(l),
      });

      const status = await wt.run(["git", "status", "--porcelain"], { cwd: taskWt.dir });
      if (status.stdout.trim()) {
        await wt.run(["git", "add", "-A"], { cwd: taskWt.dir });
        const commitMsg = buildCommitMessage(task, agent);
        await wt.run(["git", "commit", "-m", commitMsg], { cwd: taskWt.dir });
        committed = true;
        this.log(`committed on ${branch}`);

        this.log(`running verifier`);
        const verifyReport = await verify({
          workDir: taskWt.dir,
          baseBranch: defaultBranch,
          taskText: task.taskText,
          runner: this.opts.runner ?? nodeRunner,
          anthropic: this.opts.anthropic,
          anthropicModel: this.opts.model,
        });
        (this as unknown as { _verifyReport?: VerifyReport })._verifyReport = verifyReport;

        if (!verifyReport.pass) {
          const failures = verifyReport.hardFailures.map((g) => `- **${g.name}**: ${g.reason}`).join("\n");
          this.log(`verify HARD fail (${verifyReport.hardFailures.length}) — skipping push/PR`);
          await this.replyToSource(
            task,
            `I prepared a fix on branch \`${branch}\` but the pre-flight verifier blocked the PR:\n\n${failures}\n\n_No PR opened; branch was not pushed._`,
          );
          return {
            branch,
            committed,
            pushed: false,
            agent,
            verify: verifyReport,
          };
        }

        await wt.run(["git", "push", "-u", "origin", branch], { cwd: taskWt.dir });
        pushed = true;
        this.log(`pushed ${branch}`);

        const pr = await this.opts.github.openPullRequest({
          head: branch,
          base: defaultBranch,
          title: buildPullTitle(task),
          body: buildPullBody(task, agent, verifyReport),
        });
        pullNumber = pr.number;
        pullUrl = pr.html_url;
        this.log(`opened PR #${pr.number}: ${pr.html_url}`);

        const softNote =
          verifyReport.softFailures.length > 0
            ? `\n\n_${verifyReport.softFailures.length} soft warning(s) in the PR body._`
            : "";
        const reply = `Opened ${pr.html_url}.${softNote}\n\n${agent.finalText}`;
        await this.replyToSource(task, reply);
      } else {
        this.log(`agent produced no diff; posting summary only`);
        await this.replyToSource(task, `Nothing to change.\n\n${agent.finalText}`);
      }
    } finally {
      await wt.removeTaskWorktree(task.repo, branch).catch((e) => this.log(`cleanup error: ${(e as Error).message}`));
    }

    const result: TaskRunnerResult = {
      branch,
      committed,
      pushed,
      agent: agent ?? { turns: 0, finalText: "", stop_reason: "aborted", toolCalls: [] },
    };
    const vr = (this as unknown as { _verifyReport?: VerifyReport })._verifyReport;
    if (vr) result.verify = vr;
    if (pullNumber !== undefined) result.pullNumber = pullNumber;
    if (pullUrl !== undefined) result.pullUrl = pullUrl;
    return result;
  }

  private async replyToSource(task: TaskRequest, body: string): Promise<void> {
    try {
      if (task.source.kind === "pr_review_comment") {
        await this.opts.github.replyToReviewComment(task.source.pullNumber, task.source.commentId, body);
      } else {
        const num = task.source.kind === "issue" ? task.source.issueNumber : task.source.issueNumber;
        await this.opts.github.postIssueComment(num, body);
      }
    } catch (e) {
      this.log(`reply failed: ${(e as Error).message}`);
    }
  }
}

// --- helpers ---------------------------------------------------------------

export function generateBranchName(task: TaskRequest, now = Date.now()): string {
  const slug = slugify(task.taskText).slice(0, 40) || "task";
  const suffix = now.toString(36).slice(-6);
  return `orb/${slug}-${suffix}`;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildCommitMessage(task: TaskRequest, agent: SubAgentResult): string {
  const first = firstLine(task.taskText);
  const summary = truncate(agent.finalText, 300);
  const co =
    `\n\nCo-Authored-By: ${task.author} <${task.author}@users.noreply.github.com>\nCo-Authored-By: orb-async-dev <bot@orb-async-dev>`;
  return `${first}\n\n${summary}${co}`.trim();
}

export function buildPullTitle(task: TaskRequest): string {
  const first = firstLine(task.taskText);
  return first.length > 70 ? first.slice(0, 69) + "…" : first;
}

export function buildPullBody(task: TaskRequest, agent: SubAgentResult, verifyReport?: VerifyReport): string {
  const ref = describeSource(task);
  const tools = agent.toolCalls.length
    ? agent.toolCalls.map((c) => `- ${c.ok ? "✓" : "✗"} \`${c.name}\`: ${c.summary}`).join("\n")
    : "- (no tool calls)";
  const lines = [
    `> Requested via ${ref} by @${task.author}`,
    "",
    `> ${truncate(task.rawMention, 500)}`,
    "",
    "## Summary",
    agent.finalText || "_(no summary provided)_",
    "",
    "## Verifier",
    verifyReport ? renderReport(verifyReport) : "_(verifier did not run)_",
    "",
    "## Tool calls",
    tools,
    "",
    `_Stopped after ${agent.turns} turns (${agent.stop_reason}). This PR was opened by orb-async-dev._`,
  ];
  return lines.join("\n");
}

function describeSource(task: TaskRequest): string {
  switch (task.source.kind) {
    case "issue":
      return `${task.repo}#${task.source.issueNumber}`;
    case "issue_comment":
      return `${task.repo}#${task.source.issueNumber} (comment)`;
    case "pr_review_comment":
      return `${task.repo}#${task.source.pullNumber} (review comment)`;
  }
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return (idx === -1 ? s : s.slice(0, idx)).trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
