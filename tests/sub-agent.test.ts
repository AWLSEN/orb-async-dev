import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSubAgent } from "../agent/sub-agent.ts";

type AnthropicResp = {
  id?: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason: string;
  model?: string;
};

function scriptedClient(responses: AnthropicResp[]): { client: { messages: { create: (_: unknown) => Promise<AnthropicResp> } }; calls: unknown[] } {
  const calls: unknown[] = [];
  let i = 0;
  const client = {
    messages: {
      create: async (req: unknown) => {
        // Deep-clone so later mutations to the messages array don't retro-edit
        // what we captured. The real SDK serializes to JSON on send.
        calls.push(JSON.parse(JSON.stringify(req)));
        const r = responses[i];
        if (!r) throw new Error(`no scripted response for turn ${i + 1}`);
        i += 1;
        return r;
      },
    },
  };
  return { client, calls };
}

async function withWork<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "sub-agent-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("runSubAgent", () => {
  it("returns final text when model ends turn without tools", async () => {
    await withWork(async (dir) => {
      const { client } = scriptedClient([
        { content: [{ type: "text", text: "nothing to change; all good" }], stop_reason: "end_turn" },
      ]);
      const res = await runSubAgent({ client: client as any, workDir: dir, model: "m", task: "do it" });
      expect(res.turns).toBe(1);
      expect(res.stop_reason).toBe("end_turn");
      expect(res.finalText).toBe("nothing to change; all good");
      expect(res.toolCalls.length).toBe(0);
    });
  });

  it("dispatches tool_use and feeds results back in the next turn", async () => {
    await withWork(async (dir) => {
      await writeFile(path.join(dir, "x.txt"), "alpha");
      const { client, calls } = scriptedClient([
        {
          content: [
            { type: "text", text: "reading file" },
            { type: "tool_use", id: "u1", name: "read_file", input: { path: "x.txt" } },
          ],
          stop_reason: "tool_use",
        },
        {
          content: [
            { type: "tool_use", id: "u2", name: "edit_file", input: { path: "x.txt", old_string: "alpha", new_string: "BETA" } },
          ],
          stop_reason: "tool_use",
        },
        {
          content: [{ type: "text", text: "done. replaced alpha with BETA." }],
          stop_reason: "end_turn",
        },
      ]);
      const res = await runSubAgent({ client: client as any, workDir: dir, model: "m", task: "uppercase alpha to BETA" });
      expect(res.turns).toBe(3);
      expect(res.toolCalls.map((c) => c.name)).toEqual(["read_file", "edit_file"]);
      expect(res.toolCalls.every((c) => c.ok)).toBe(true);
      expect(res.finalText).toMatch(/replaced alpha with BETA/);
      expect(await readFile(path.join(dir, "x.txt"), "utf8")).toBe("BETA");
      // Second turn should have received the tool_result in its messages.
      const secondReq = calls[1] as { messages: Array<{ role: string; content: unknown }> };
      const lastUser = secondReq.messages[secondReq.messages.length - 1]!;
      expect(lastUser.role).toBe("user");
    });
  });

  it("reports tool errors without crashing the loop (is_error=true propagates)", async () => {
    await withWork(async (dir) => {
      const { client } = scriptedClient([
        {
          content: [
            { type: "tool_use", id: "u1", name: "read_file", input: { path: "missing.txt" } },
          ],
          stop_reason: "tool_use",
        },
        { content: [{ type: "text", text: "ok the file doesn't exist; bailing" }], stop_reason: "end_turn" },
      ]);
      const res = await runSubAgent({ client: client as any, workDir: dir, model: "m", task: "read missing.txt" });
      expect(res.toolCalls.length).toBe(1);
      expect(res.toolCalls[0]?.ok).toBe(false);
      expect(res.toolCalls[0]?.summary).toMatch(/no such path/);
      expect(res.turns).toBe(2);
    });
  });

  it("blocks path escape attempts from tool_use inputs", async () => {
    await withWork(async (dir) => {
      const { client } = scriptedClient([
        {
          content: [
            { type: "tool_use", id: "u1", name: "write_file", input: { path: "/etc/evil", content: "x" } },
          ],
          stop_reason: "tool_use",
        },
        { content: [{ type: "text", text: "cant write absolute paths" }], stop_reason: "end_turn" },
      ]);
      const res = await runSubAgent({ client: client as any, workDir: dir, model: "m", task: "try to escape" });
      expect(res.toolCalls[0]?.ok).toBe(false);
      expect(res.toolCalls[0]?.summary).toMatch(/path escape/);
    });
  });

  it("stops at maxTurns without hanging", async () => {
    await withWork(async (dir) => {
      const turns: AnthropicResp[] = Array.from({ length: 10 }, (_, i) => ({
        content: [{ type: "tool_use", id: `u${i}`, name: "list_files", input: {} }],
        stop_reason: "tool_use",
      }));
      const { client } = scriptedClient(turns);
      const res = await runSubAgent({ client: client as any, workDir: dir, model: "m", task: "loop", maxTurns: 3 });
      expect(res.turns).toBe(3);
      expect(res.stop_reason).toBe("tool_use");
    });
  });

  it("run_bash tool_result includes exit code and stderr", async () => {
    await withWork(async (dir) => {
      const { client } = scriptedClient([
        {
          content: [
            { type: "tool_use", id: "u1", name: "run_bash", input: { command: "echo hi && exit 3" } },
          ],
          stop_reason: "tool_use",
        },
        { content: [{ type: "text", text: "saw exit 3" }], stop_reason: "end_turn" },
      ]);
      const res = await runSubAgent({ client: client as any, workDir: dir, model: "m", task: "probe exit code" });
      expect(res.toolCalls[0]?.ok).toBe(true);
      expect(res.toolCalls[0]?.summary).toMatch(/exit=3/);
    });
  });
});
