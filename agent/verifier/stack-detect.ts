// Detect the target repo's stack (JS/TS via bun|npm|pnpm|yarn, Python, Go,
// Rust) so the verifier knows which build/test/lint commands to run. Pure
// detection — no I/O beyond existsSync on well-known manifest files.

import { existsSync } from "node:fs";
import path from "node:path";

export type Stack = "bun" | "pnpm" | "yarn" | "npm" | "python" | "go" | "rust" | "unknown";

export interface DetectedStack {
  stack: Stack;
  manifest?: string;
  build?: string;
  test?: string;
  lint?: string;
  typecheck?: string;
}

export function detectStack(workDir: string): DetectedStack {
  if (existsSync(path.join(workDir, "bun.lock")) || existsSync(path.join(workDir, "bun.lockb"))) {
    return jsStack(workDir, "bun", "bun install --frozen-lockfile");
  }
  if (existsSync(path.join(workDir, "pnpm-lock.yaml"))) {
    return jsStack(workDir, "pnpm", "pnpm install --frozen-lockfile");
  }
  if (existsSync(path.join(workDir, "yarn.lock"))) {
    return jsStack(workDir, "yarn", "yarn install --frozen-lockfile");
  }
  if (existsSync(path.join(workDir, "package-lock.json")) || existsSync(path.join(workDir, "package.json"))) {
    return jsStack(workDir, "npm", "npm ci");
  }
  if (existsSync(path.join(workDir, "pyproject.toml")) || existsSync(path.join(workDir, "requirements.txt"))) {
    return { stack: "python", manifest: "pyproject.toml", build: "pip install -e . || pip install -r requirements.txt", test: "pytest", lint: "ruff check ." };
  }
  if (existsSync(path.join(workDir, "go.mod"))) {
    return { stack: "go", manifest: "go.mod", build: "go build ./...", test: "go test ./...", lint: "go vet ./..." };
  }
  if (existsSync(path.join(workDir, "Cargo.toml"))) {
    return { stack: "rust", manifest: "Cargo.toml", build: "cargo build", test: "cargo test", lint: "cargo clippy -- -D warnings" };
  }
  return { stack: "unknown" };
}

/** JS family stacks share the same command shape; look inside package.json to
 * see whether the repo defines build/test/lint/typecheck scripts. */
function jsStack(workDir: string, stack: Extract<Stack, "bun" | "npm" | "pnpm" | "yarn">, build: string): DetectedStack {
  const pkgPath = path.join(workDir, "package.json");
  const result: DetectedStack = { stack, manifest: "package.json", build };

  let scripts: Record<string, string> = {};
  if (existsSync(pkgPath)) {
    try {
      const { readFileSync } = require("node:fs") as typeof import("node:fs");
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      scripts = parsed.scripts ?? {};
    } catch {
      // partial config: we'll fall back to sensible defaults below.
    }
  }

  const runner = runnerFor(stack);
  if (scripts.build) result.build = `${build} && ${runner} build`;
  if (scripts.test) result.test = `${runner} test`;
  if (scripts.lint) result.lint = `${runner} lint`;
  if (scripts.typecheck) result.typecheck = `${runner} typecheck`;

  // Bun ships a built-in test runner; default to it when no test script exists.
  if (!result.test && stack === "bun") result.test = "bun test";
  return result;
}

function runnerFor(stack: "bun" | "npm" | "pnpm" | "yarn"): string {
  switch (stack) {
    case "bun":
      return "bun run";
    case "pnpm":
      return "pnpm run";
    case "yarn":
      return "yarn";
    case "npm":
      return "npm run";
  }
}
