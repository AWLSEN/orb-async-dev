// Filesystem + shell tools the sub-agent is allowed to call.
// Every path is resolved against a jail (the task worktree). Escape attempts
// (symlinks, "../" traversal, absolute paths) are rejected before any I/O.

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { nodeRunner, type RunInput, type Runner } from "../runner.ts";

export interface ToolContext {
  workDir: string;
  runner?: Runner;
}

export class PathEscapeError extends Error {
  constructor(p: string, jail: string) {
    super(`path escape: ${p} is outside ${jail}`);
    this.name = "PathEscapeError";
  }
}

export function resolveInJail(rel: string, jail: string): string {
  if (path.isAbsolute(rel)) throw new PathEscapeError(rel, jail);
  const resolved = path.resolve(jail, rel);
  const jailAbs = path.resolve(jail);
  const rootWithSep = jailAbs.endsWith(path.sep) ? jailAbs : jailAbs + path.sep;
  if (resolved !== jailAbs && !resolved.startsWith(rootWithSep)) {
    throw new PathEscapeError(rel, jail);
  }
  return resolved;
}

// --- read_file -------------------------------------------------------------

export async function readFileTool(ctx: ToolContext, input: { path: string }): Promise<string> {
  const abs = resolveInJail(input.path, ctx.workDir);
  if (!existsSync(abs)) throw new Error(`read_file: no such path: ${input.path}`);
  const s = await stat(abs);
  if (!s.isFile()) throw new Error(`read_file: not a file: ${input.path}`);
  if (s.size > 1_000_000) throw new Error(`read_file: file too large (${s.size} bytes)`);
  return readFile(abs, "utf8");
}

// --- write_file (full overwrite; use edit_file for surgical edits) ---------

export async function writeFileTool(ctx: ToolContext, input: { path: string; content: string }): Promise<{ bytes: number }> {
  const abs = resolveInJail(input.path, ctx.workDir);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, input.content, "utf8");
  return { bytes: Buffer.byteLength(input.content, "utf8") };
}

// --- edit_file (exact-match replacement; errors if not unique) -------------

export async function editFileTool(
  ctx: ToolContext,
  input: { path: string; old_string: string; new_string: string; replace_all?: boolean },
): Promise<{ replaced: number }> {
  if (input.old_string === input.new_string) throw new Error("edit_file: old_string equals new_string");
  if (!input.old_string) throw new Error("edit_file: old_string must be non-empty");
  const abs = resolveInJail(input.path, ctx.workDir);
  const body = await readFile(abs, "utf8");
  const occurrences = countOccurrences(body, input.old_string);
  if (occurrences === 0) throw new Error(`edit_file: old_string not found in ${input.path}`);
  if (occurrences > 1 && !input.replace_all) {
    throw new Error(`edit_file: old_string matches ${occurrences} times; set replace_all or widen the match`);
  }
  const next = input.replace_all
    ? body.split(input.old_string).join(input.new_string)
    : body.replace(input.old_string, input.new_string);
  await writeFile(abs, next, "utf8");
  return { replaced: input.replace_all ? occurrences : 1 };
}

// --- list_files ------------------------------------------------------------

export async function listFilesTool(ctx: ToolContext, input: { path?: string }): Promise<string[]> {
  const rel = input.path ?? ".";
  const abs = resolveInJail(rel, ctx.workDir);
  if (!existsSync(abs)) throw new Error(`list_files: no such path: ${rel}`);
  const entries = await readdir(abs, { withFileTypes: true });
  return entries
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
}

// --- run_bash (stderr+stdout captured; non-zero exits are fine for agents) -

export async function runBashTool(
  ctx: ToolContext,
  input: { command: string; timeout_ms?: number },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const runner = ctx.runner ?? nodeRunner;
  const runInput: RunInput = {
    // `bash -c` (no -l) — login-shell rc files would change cwd and leak env.
    cmd: ["bash", "-c", input.command],
    cwd: ctx.workDir,
    ...(input.timeout_ms ? { timeoutMs: input.timeout_ms } : {}),
  };
  try {
    const res = await runner(runInput);
    return res;
  } catch (e) {
    // RunError wraps non-zero exits; for agent tools we *don't* throw on
    // non-zero (expected for failing tests, grep with no matches, etc).
    const err = e as { result?: { stdout: string; stderr: string; code: number }; message?: string };
    if (err.result) return err.result;
    throw e;
  }
}

// --- helpers ---------------------------------------------------------------

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = 0;
  while (true) {
    const hit = haystack.indexOf(needle, i);
    if (hit === -1) return count;
    count += 1;
    i = hit + needle.length;
  }
}
