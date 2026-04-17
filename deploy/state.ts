// Minimal file-backed state under .orb-state/. Idempotent deploys read these
// to resume; the directory is gitignored so secrets never get committed.

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class State {
  constructor(public readonly dir: string) {}

  async read(name: string): Promise<string | undefined> {
    const p = path.join(this.dir, name);
    if (!existsSync(p)) return undefined;
    const content = (await readFile(p, "utf8")).trim();
    return content === "" ? undefined : content;
  }

  async write(name: string, value: string, opts: { secret?: boolean } = {}): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const p = path.join(this.dir, name);
    await writeFile(p, value);
    if (opts.secret) await chmod(p, 0o600);
  }
}

/** Parse "2GB" / "512MB" / "1048576KB" / "2048" into megabytes. */
export function mbFromSize(size: string): number {
  const trimmed = size.trim();
  const match = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)?$/i.exec(trimmed);
  if (!match) throw new Error(`cannot parse size: ${size}`);
  const n = Number.parseFloat(match[1]!);
  const unit = (match[2] ?? "MB").toUpperCase();
  const factor: Record<string, number> = { KB: 1 / 1024, MB: 1, GB: 1024, TB: 1024 * 1024 };
  return Math.round(n * factor[unit]!);
}

/** Minimal dotenv parser — KEY=VALUE lines, ignores # comments and blanks. */
export function parseDotEnv(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Merge dotenv into process.env without overwriting already-set vars. */
export async function loadDotEnvInto(filePath: string, env: Record<string, string | undefined>): Promise<void> {
  if (!existsSync(filePath)) return;
  const body = await readFile(filePath, "utf8");
  const parsed = parseDotEnv(body);
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined || env[k] === "") env[k] = v;
  }
}
