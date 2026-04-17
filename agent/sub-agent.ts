// Sub-agent: runs a single task inside a jailed worktree using Claude's
// tool-use API. Works against either the native Anthropic SDK or any
// Anthropic-compatible proxy (Z.AI, OpenRouter in anthropic mode, etc.).

import type Anthropic from "@anthropic-ai/sdk";
import type { Runner } from "./runner.ts";
import {
  editFileTool,
  listFilesTool,
  readFileTool,
  runBashTool,
  writeFileTool,
} from "./tools/fs-tools.ts";

export interface SubAgentOpts {
  client: Pick<Anthropic, "messages">;
  workDir: string;
  model: string;
  task: string;
  systemPrompt?: string;
  maxTurns?: number;
  maxTokens?: number;
  runner?: Runner;
  /** Callback for progress lines (a logger; default no-op). */
  onLog?: (line: string) => void;
}

export interface SubAgentResult {
  turns: number;
  finalText: string;
  stop_reason: string;
  /** Tool calls made, in order. Useful for PR body construction + audit trail. */
  toolCalls: Array<{ name: string; ok: boolean; summary: string }>;
}

export const TOOL_SCHEMAS = [
  {
    name: "read_file",
    description: "Read a UTF-8 file (<=1MB) inside the task workspace. Paths are relative.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Overwrite (or create) a file with the given content. Creates parent dirs.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Surgical edit: replace exact old_string with new_string. Fails if old_string matches multiple times unless replace_all=true. Prefer this over write_file for small diffs.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_files",
    description: "List the entries in a directory. Directories have trailing /.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  },
  {
    name: "run_bash",
    description:
      "Run a bash command in the workspace root. Returns stdout, stderr, code. Non-zero exits do NOT throw — inspect the code. 10-minute default timeout.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "number" },
      },
      required: ["command"],
    },
  },
] as const;

const DEFAULT_SYSTEM_PROMPT = `You are orb-async-dev, an autonomous coding agent.

You are working inside a dedicated git worktree. Your job is to complete the user's
task and leave the worktree in a state where:
  1. Every test in the repo still passes (or was intentionally modified with a new
     test that exercises the fix you made).
  2. Build + lint + typecheck are green if those tools exist in the repo.
  3. A human reviewer can understand the change from the diff alone.

Rules:
  - Keep changes minimal and scoped to the task.
  - Never touch secrets, credentials, or CI workflows unless the task explicitly says so.
  - When you are done, output a concise summary (no markdown headers; a short paragraph
    is fine) covering what you changed, what you tested, and anything you were unsure
    about. End your turn without further tool calls.
  - If you cannot complete the task safely, say so plainly — do not fabricate success.`;

export async function runSubAgent(opts: SubAgentOpts): Promise<SubAgentResult> {
  const maxTurns = opts.maxTurns ?? 30;
  const maxTokens = opts.maxTokens ?? 4096;
  const log = opts.onLog ?? (() => undefined);
  const system = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: opts.task }];
  const toolCalls: SubAgentResult["toolCalls"] = [];
  let finalText = "";
  let stop_reason: string = "max_turns";

  for (let turn = 0; turn < maxTurns; turn++) {
    log(`turn ${turn + 1}`);
    const resp = await opts.client.messages.create({
      model: opts.model,
      max_tokens: maxTokens,
      system,
      tools: TOOL_SCHEMAS as unknown as Anthropic.Tool[],
      messages,
    });

    messages.push({ role: "assistant", content: resp.content });
    stop_reason = resp.stop_reason ?? "unknown";

    finalText = extractText(resp.content);

    if (resp.stop_reason === "end_turn" || resp.stop_reason === "stop_sequence") {
      return { turns: turn + 1, finalText, stop_reason, toolCalls };
    }

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      // No tools and not a terminating stop_reason — treat as done.
      return { turns: turn + 1, finalText, stop_reason, toolCalls };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      const { ok, summary, content } = await dispatchTool(use, opts);
      toolCalls.push({ name: use.name, ok, summary });
      log(`  tool ${use.name} ${ok ? "ok" : "error"}: ${summary.slice(0, 120)}`);
      toolResults.push({
        type: "tool_result",
        tool_use_id: use.id,
        content,
        is_error: !ok,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  return { turns: maxTurns, finalText, stop_reason, toolCalls };
}

async function dispatchTool(
  use: Anthropic.ToolUseBlock,
  opts: SubAgentOpts,
): Promise<{ ok: boolean; summary: string; content: string }> {
  const ctx = { workDir: opts.workDir, ...(opts.runner ? { runner: opts.runner } : {}) };
  const input = (use.input ?? {}) as Record<string, unknown>;
  try {
    switch (use.name) {
      case "read_file": {
        const content = await readFileTool(ctx, { path: String(input.path) });
        return { ok: true, summary: `read ${input.path} (${content.length} chars)`, content };
      }
      case "write_file": {
        const out = await writeFileTool(ctx, { path: String(input.path), content: String(input.content ?? "") });
        return { ok: true, summary: `wrote ${input.path} (${out.bytes}B)`, content: JSON.stringify(out) };
      }
      case "edit_file": {
        const out = await editFileTool(ctx, {
          path: String(input.path),
          old_string: String(input.old_string ?? ""),
          new_string: String(input.new_string ?? ""),
          ...(typeof input.replace_all === "boolean" ? { replace_all: input.replace_all } : {}),
        });
        return { ok: true, summary: `edited ${input.path} (${out.replaced} replacements)`, content: JSON.stringify(out) };
      }
      case "list_files": {
        const entries = await listFilesTool(ctx, typeof input.path === "string" ? { path: input.path } : {});
        return { ok: true, summary: `listed (${entries.length} entries)`, content: entries.join("\n") };
      }
      case "run_bash": {
        const out = await runBashTool(ctx, {
          command: String(input.command ?? ""),
          ...(typeof input.timeout_ms === "number" ? { timeout_ms: input.timeout_ms } : {}),
        });
        return {
          ok: true,
          summary: `bash exit=${out.code} (stdout=${out.stdout.length}B stderr=${out.stderr.length}B)`,
          content: `exit_code=${out.code}\n--- stdout ---\n${out.stdout}\n--- stderr ---\n${out.stderr}`,
        };
      }
      default:
        return { ok: false, summary: `unknown tool ${use.name}`, content: `unknown tool: ${use.name}` };
    }
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, summary: msg, content: msg };
  }
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}
