import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectStack } from "../agent/verifier/stack-detect.ts";

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const d = await mkdtemp(path.join(tmpdir(), "stack-"));
  try {
    return await fn(d);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
}

describe("detectStack", () => {
  it("unknown on empty dir", async () => {
    await withDir(async (d) => {
      expect(detectStack(d).stack).toBe("unknown");
    });
  });

  it("bun when bun.lock is present", async () => {
    await withDir(async (d) => {
      await writeFile(path.join(d, "bun.lock"), "");
      await writeFile(
        path.join(d, "package.json"),
        JSON.stringify({ scripts: { test: "bun test", build: "bun build", typecheck: "tsc --noEmit" } }),
      );
      const s = detectStack(d);
      expect(s.stack).toBe("bun");
      expect(s.build).toBe("bun install --frozen-lockfile && bun run build");
      expect(s.test).toBe("bun run test");
      expect(s.typecheck).toBe("bun run typecheck");
    });
  });

  it("pnpm beats npm when pnpm-lock present", async () => {
    await withDir(async (d) => {
      await writeFile(path.join(d, "pnpm-lock.yaml"), "");
      await writeFile(path.join(d, "package-lock.json"), "");
      await writeFile(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
      const s = detectStack(d);
      expect(s.stack).toBe("pnpm");
      expect(s.test).toBe("pnpm run test");
    });
  });

  it("python via requirements.txt", async () => {
    await withDir(async (d) => {
      await writeFile(path.join(d, "requirements.txt"), "");
      const s = detectStack(d);
      expect(s.stack).toBe("python");
      expect(s.test).toBe("pytest");
      expect(s.lint).toBe("ruff check .");
    });
  });

  it("go via go.mod", async () => {
    await withDir(async (d) => {
      await writeFile(path.join(d, "go.mod"), "module x\n");
      const s = detectStack(d);
      expect(s.stack).toBe("go");
      expect(s.build).toBe("go build ./...");
      expect(s.test).toBe("go test ./...");
    });
  });

  it("rust via Cargo.toml", async () => {
    await withDir(async (d) => {
      await writeFile(path.join(d, "Cargo.toml"), "");
      const s = detectStack(d);
      expect(s.stack).toBe("rust");
      expect(s.lint).toBe("cargo clippy -- -D warnings");
    });
  });

  it("bun without package.json still yields a usable test command", async () => {
    await withDir(async (d) => {
      await writeFile(path.join(d, "bun.lock"), "");
      const s = detectStack(d);
      expect(s.stack).toBe("bun");
      expect(s.test).toBe("bun test");
    });
  });

  it("missing optional scripts don't hallucinate commands", async () => {
    await withDir(async (d) => {
      await writeFile(path.join(d, "package-lock.json"), "");
      await writeFile(path.join(d, "package.json"), JSON.stringify({ scripts: { test: "jest" } }));
      const s = detectStack(d);
      expect(s.stack).toBe("npm");
      expect(s.lint).toBeUndefined();
      expect(s.typecheck).toBeUndefined();
    });
  });
});
