// Tiny process runner. Two flavors:
//   - spawnProcess: low-level helper backed by Bun.spawn.
//   - nodeRunner:   default Runner that returns {stdout, stderr, code} or throws.
// Tests inject their own Runner to avoid touching the filesystem.

export interface RunInput {
  cmd: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Timeout in ms. Defaults to 10 minutes. */
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Runner = (input: RunInput) => Promise<RunResult>;

export class RunError extends Error {
  constructor(
    public readonly cmd: string[],
    public readonly result: RunResult,
  ) {
    super(`${cmd.join(" ")} exited with code ${result.code}: ${result.stderr.slice(-400)}`);
    this.name = "RunError";
  }
}

export async function spawnProcess(input: RunInput): Promise<RunResult> {
  const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;
  const proc = Bun.spawn({
    cmd: input.cmd,
    cwd: input.cwd,
    env: { ...process.env, ...(input.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
}

/** Default runner: throws RunError on non-zero exit. */
export const nodeRunner: Runner = async (input) => {
  const res = await spawnProcess(input);
  if (res.code !== 0) throw new RunError(input.cmd, res);
  return res;
};
