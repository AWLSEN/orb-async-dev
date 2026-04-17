// Parse GitHub comment bodies for `@orb <task>` mentions.
//
// Rules:
//   1. The mention must be a whole token — `@orbital` does not match.
//   2. The mention must not be inside a fenced code block (```) or inline code (`).
//   3. Lines starting with `>` (GH quote) are ignored so replying to a bot
//      post doesn't re-trigger.
//   4. Task text is everything after `@orb` on the same paragraph, stopping
//      at the first blank line. Trimmed of leading punctuation (, : -).
//   5. Comma-after-@orb ("Hey @orb, fix X") is fine; "Hey @orb." alone isn't
//      a task (empty body).
//
// Configurable handle so users can rename the bot (`@myorb`) via env later.

export interface MentionMatch {
  taskText: string;
  /** Raw substring of the original comment that contained the mention line. */
  rawLine: string;
}

export interface ParseOptions {
  handle?: string; // default "orb"
}

const LEADING_PUNCT = /^[\s,:\-–—.!?]+/;

/** Strip fenced and inline code spans so mentions inside them are ignored. */
function stripCode(body: string): string {
  // Fenced first (greedy across lines). Replace with equal-length blank lines
  // so line numbers / paragraph boundaries don't shift.
  let out = body.replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "));
  // Then inline `...`.
  out = out.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
  return out;
}

/** Drop GitHub quote-lines (start with optional ws + ">"). Keeps a leading
 * newline so paragraph detection still works. */
function dropQuotes(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => (/^\s*>/.test(line) ? "" : line))
    .join("\n");
}

/** Extract the first `@handle <task>` mention, or null if none. */
export function parseMention(body: string, opts: ParseOptions = {}): MentionMatch | null {
  const handle = (opts.handle ?? "orb").replace(/^@/, "").toLowerCase();
  if (!handle) throw new Error("handle must be non-empty");

  const cleaned = dropQuotes(stripCode(body));

  // Split on blank lines (paragraph boundaries). Scan each paragraph.
  const paragraphs = cleaned.split(/\n\s*\n/);
  const handleRe = new RegExp(String.raw`(?:^|[^\w])@` + escape(handle) + String.raw`\b`, "i");

  for (const para of paragraphs) {
    const m = handleRe.exec(para);
    if (!m) continue;
    // Index of the "@" char (m.index points at the char *before* @ if any).
    const at = para.indexOf("@", m.index);
    if (at < 0) continue;
    const afterHandle = para.slice(at + 1 + handle.length);
    const trimmed = afterHandle.replace(LEADING_PUNCT, "").trim();
    if (!trimmed) continue; // "@orb" alone is not a task
    return { taskText: trimmed, rawLine: para.trim() };
  }

  return null;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
