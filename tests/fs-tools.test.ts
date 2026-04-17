import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PathEscapeError,
  editFileTool,
  listFilesTool,
  readFileTool,
  resolveInJail,
  runBashTool,
  writeFileTool,
} from "../agent/tools/fs-tools.ts";

async function withJail<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "fs-tools-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveInJail", () => {
  it("resolves a relative path inside the jail", () => {
    const abs = resolveInJail("src/foo.ts", "/jail");
    expect(abs).toBe("/jail/src/foo.ts");
  });
  it("rejects absolute paths", () => {
    expect(() => resolveInJail("/etc/passwd", "/jail")).toThrow(PathEscapeError);
  });
  it("rejects ../ traversal", () => {
    expect(() => resolveInJail("../outside", "/jail")).toThrow(PathEscapeError);
    expect(() => resolveInJail("src/../../../root", "/jail")).toThrow(PathEscapeError);
  });
  it("allows the jail root itself", () => {
    expect(resolveInJail(".", "/jail")).toBe("/jail");
  });
  it("rejects sibling paths even with prefix collision", () => {
    expect(() => resolveInJail("../jail2/x", "/jail")).toThrow(PathEscapeError);
  });
});

describe("read/write/edit cycle", () => {
  it("write then read round-trips utf8", async () => {
    await withJail(async (dir) => {
      await writeFileTool({ workDir: dir }, { path: "a.txt", content: "héllo" });
      expect(await readFileTool({ workDir: dir }, { path: "a.txt" })).toBe("héllo");
    });
  });

  it("write creates parent directories", async () => {
    await withJail(async (dir) => {
      await writeFileTool({ workDir: dir }, { path: "deep/nested/x.txt", content: "1" });
      expect(await readFile(path.join(dir, "deep/nested/x.txt"), "utf8")).toBe("1");
    });
  });

  it("read_file rejects missing files", async () => {
    await withJail(async (dir) => {
      await expect(readFileTool({ workDir: dir }, { path: "missing" })).rejects.toThrow(/no such path/);
    });
  });

  it("edit_file replaces the unique match", async () => {
    await withJail(async (dir) => {
      await writeFile(path.join(dir, "a.txt"), "alpha beta gamma");
      const res = await editFileTool({ workDir: dir }, { path: "a.txt", old_string: "beta", new_string: "BETA" });
      expect(res.replaced).toBe(1);
      expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("alpha BETA gamma");
    });
  });

  it("edit_file errors on ambiguous match without replace_all", async () => {
    await withJail(async (dir) => {
      await writeFile(path.join(dir, "a.txt"), "x x x");
      await expect(
        editFileTool({ workDir: dir }, { path: "a.txt", old_string: "x", new_string: "y" }),
      ).rejects.toThrow(/3 times/);
    });
  });

  it("edit_file with replace_all reports count", async () => {
    await withJail(async (dir) => {
      await writeFile(path.join(dir, "a.txt"), "x x x");
      const res = await editFileTool({ workDir: dir }, { path: "a.txt", old_string: "x", new_string: "y", replace_all: true });
      expect(res.replaced).toBe(3);
      expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("y y y");
    });
  });

  it("edit_file rejects empty or identical strings", async () => {
    await withJail(async (dir) => {
      await writeFile(path.join(dir, "a.txt"), "hello");
      await expect(editFileTool({ workDir: dir }, { path: "a.txt", old_string: "", new_string: "y" })).rejects.toThrow();
      await expect(editFileTool({ workDir: dir }, { path: "a.txt", old_string: "y", new_string: "y" })).rejects.toThrow();
    });
  });

  it("path escape is blocked on every operation", async () => {
    await withJail(async (dir) => {
      await expect(readFileTool({ workDir: dir }, { path: "../boom" })).rejects.toThrow(PathEscapeError);
      await expect(writeFileTool({ workDir: dir }, { path: "/etc/evil", content: "x" })).rejects.toThrow(PathEscapeError);
      await expect(editFileTool({ workDir: dir }, { path: "../x", old_string: "a", new_string: "b" })).rejects.toThrow(PathEscapeError);
      await expect(listFilesTool({ workDir: dir }, { path: "../" })).rejects.toThrow(PathEscapeError);
    });
  });
});

describe("list_files", () => {
  it("lists with trailing slash on directories", async () => {
    await withJail(async (dir) => {
      await writeFile(path.join(dir, "a.txt"), "");
      await mkdir(path.join(dir, "sub"));
      await writeFile(path.join(dir, "sub", "b.txt"), "");
      const out = await listFilesTool({ workDir: dir }, {});
      expect(out).toEqual(["a.txt", "sub/"]);
    });
  });
});

describe("run_bash", () => {
  it("returns stdout on success with code 0", async () => {
    await withJail(async (dir) => {
      const res = await runBashTool({ workDir: dir }, { command: "echo hello" });
      expect(res.code).toBe(0);
      expect(res.stdout.trim()).toBe("hello");
    });
  });
  it("returns stderr + non-zero code without throwing", async () => {
    await withJail(async (dir) => {
      const res = await runBashTool({ workDir: dir }, { command: "echo err >&2; exit 2" });
      expect(res.code).toBe(2);
      expect(res.stderr.trim()).toBe("err");
    });
  });
  it("runs in the jail cwd", async () => {
    await withJail(async (dir) => {
      // macOS /var is a symlink to /private/var; mkdtemp may return /var/... but
      // `pwd -P` resolves to the physical path, so compare via fs.realpath on
      // both sides.
      const { realpath } = await import("node:fs/promises");
      const expected = await realpath(dir);
      const res = await runBashTool({ workDir: dir }, { command: "pwd -P" });
      expect(res.stdout.trim()).toBe(expected);
    });
  });
});
