// In-memory ring buffer of recent log lines, plus a tiny HTML renderer for
// GET /logs. The orchestrator + health loops push through `log.push(line)`;
// the HTTP handler reads `log.snapshot()` each request.

export interface LogEntry {
  ts: number;
  line: string;
}

export interface LogStore {
  push(line: string): void;
  snapshot(): LogEntry[];
  /** Max entries held; older entries are evicted FIFO. */
  readonly capacity: number;
}

export function createLogStore(capacity = 500): LogStore {
  const buf: LogEntry[] = [];
  return {
    push(line) {
      buf.push({ ts: Date.now(), line });
      while (buf.length > capacity) buf.shift();
    },
    snapshot: () => buf.slice(),
    capacity,
  };
}

export interface RenderOptions {
  title?: string;
  /** Maximum entries to render (tail of the buffer). Defaults to capacity. */
  tail?: number;
}

const STYLE = `
  body { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b0d10; color: #e2e8f0; margin: 0; padding: 16px; }
  header { display: flex; gap: 12px; align-items: baseline; margin-bottom: 16px; }
  h1 { font: 600 14px/1 ui-sans-serif, system-ui; color: #94a3b8; margin: 0; }
  .meta { color: #64748b; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
  .row { display: grid; grid-template-columns: 160px 1fr; padding: 2px 0; border-bottom: 1px solid #1e293b; }
  .ts { color: #64748b; }
  .err { color: #fca5a5; }
  .ok { color: #86efac; }
`.trim();

export function renderLogsHtml(store: LogStore, opts: RenderOptions = {}): string {
  const entries = store.snapshot();
  const tail = opts.tail ?? entries.length;
  const slice = entries.slice(-tail);
  const rows = slice
    .map((e) => {
      const iso = new Date(e.ts).toISOString();
      const cls = classifyLine(e.line);
      return `<div class="row"><span class="ts">${iso}</span><pre class="${cls}">${escapeHtml(e.line)}</pre></div>`;
    })
    .join("");
  const title = opts.title ?? "orb-async-dev — logs";
  const now = new Date().toISOString();
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style><meta http-equiv="refresh" content="5"></head><body><header><h1>${escapeHtml(title)}</h1><span class="meta">${slice.length}/${store.capacity} · refreshed ${now}</span></header>${rows || '<pre class="meta">(no events)</pre>'}</body></html>`;
}

function classifyLine(line: string): string {
  if (/\b(ERROR|FAIL|TRIPPED|rejected|reject)\b/.test(line)) return "err";
  if (/\b(done|pushed|opened|PASS|ok)\b/i.test(line)) return "ok";
  return "";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}
