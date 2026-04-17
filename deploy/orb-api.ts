// Typed client for the Orb Cloud REST API at https://api.orbcloud.dev.
// Docs: docs.orbcloud.dev. Every request carries `Authorization: Bearer <api_key>`
// except POST /api/v1/auth/register which mints one from an email.

export interface OrbClientOpts {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface Computer {
  /** Long id (UUID-shape). */
  computer_id?: string;
  /** Short id used to form the live URL at `https://{short_id}.orbcloud.dev`. */
  short_id?: string;
  /** Some older endpoints return `id` instead of `computer_id`. */
  id?: string;
  name: string;
  runtime_mb: number;
  disk_mb: number;
  status?: string;
}

/** Response to POST /v1/computers/{id}/agents. Identity is (computer_id, port). */
export interface Agent {
  computer_id: string;
  port: number;
  pid?: number;
  state?: "Running" | "Frozen" | "Checkpointed";
  sandboxed?: boolean;
}

export interface UsageQuery {
  /** ISO 8601 timestamp, required by the API. */
  start: string;
  /** ISO 8601 timestamp, required by the API. */
  end: string;
}

export interface UsageResponse {
  runtime_gb_hours?: number;
  disk_gb_hours?: number;
  /** Old shape: row list. New shape: aggregate. Client returns whichever the server sends. */
  rows?: Array<{
    computer_id?: string;
    period_start?: string;
    period_end?: string;
    gb_hours?: number;
    cost_usd?: number;
  }>;
}

export class OrbApiError extends Error {
  constructor(
    public status: number,
    public url: string,
    public body: string,
  ) {
    super(`orb api ${status} ${url}: ${body.slice(0, 400)}`);
    this.name = "OrbApiError";
  }
}

export class OrbClient {
  readonly baseUrl: string;
  apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OrbClientOpts = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.orbcloud.dev").replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // --- auth ---------------------------------------------------------------

  /** Self-serve: mints a new api_key from an email address. */
  async register(email: string): Promise<{ api_key: string }> {
    const res = await this.raw("POST", "/api/v1/auth/register", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
      auth: false,
    });
    const json = (await res.json()) as { api_key?: string };
    if (!json.api_key) throw new OrbApiError(res.status, "/api/v1/auth/register", JSON.stringify(json));
    this.apiKey = json.api_key;
    return { api_key: json.api_key };
  }

  // --- computers ----------------------------------------------------------

  async createComputer(input: { name: string; runtime_mb: number; disk_mb: number }): Promise<Computer> {
    const res = await this.raw("POST", "/v1/computers", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return (await res.json()) as Computer;
  }

  async listComputers(): Promise<Computer[]> {
    const res = await this.raw("GET", "/v1/computers");
    const data = (await res.json()) as Computer[] | { computers?: Computer[] };
    return Array.isArray(data) ? data : (data.computers ?? []);
  }

  async getComputer(id: string): Promise<Computer> {
    const res = await this.raw("GET", `/v1/computers/${encodeURIComponent(id)}`);
    return (await res.json()) as Computer;
  }

  async deleteComputer(id: string): Promise<void> {
    await this.raw("DELETE", `/v1/computers/${encodeURIComponent(id)}`);
  }

  async uploadConfig(id: string, orbToml: string): Promise<void> {
    await this.raw("POST", `/v1/computers/${encodeURIComponent(id)}/config`, {
      headers: { "content-type": "application/toml" },
      body: orbToml,
    });
  }

  /** Clone + install. Long-running; callers should bump the fetch timeout. */
  async build(id: string, opts: { orgSecrets?: Record<string, string>; signal?: AbortSignal } = {}): Promise<void> {
    const init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {};
    if (opts.orgSecrets && Object.keys(opts.orgSecrets).length > 0) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify({ org_secrets: opts.orgSecrets });
    }
    if (opts.signal) init.signal = opts.signal;
    await this.raw("POST", `/v1/computers/${encodeURIComponent(id)}/build`, init);
  }

  // --- agents -------------------------------------------------------------

  async startAgent(
    id: string,
    opts: { task?: string; count?: number; orgSecrets?: Record<string, string>; orbConfig?: Record<string, unknown> } = {},
  ): Promise<Agent> {
    const body: Record<string, unknown> = {};
    if (opts.task) body.task = opts.task;
    if (opts.count !== undefined) body.count = opts.count;
    if (opts.orgSecrets && Object.keys(opts.orgSecrets).length > 0) body.org_secrets = opts.orgSecrets;
    if (opts.orbConfig) body.orb_config = opts.orbConfig;
    const res = await this.raw("POST", `/v1/computers/${encodeURIComponent(id)}/agents`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Agent;
  }

  async listAgents(id: string): Promise<Agent[]> {
    const res = await this.raw("GET", `/v1/computers/${encodeURIComponent(id)}/agents`);
    const data = (await res.json()) as Agent[] | { agents?: Agent[] };
    return Array.isArray(data) ? data : (data.agents ?? []);
  }

  /** Wake a specific agent by its (computer, port). */
  async promote(computerId: string, port: number): Promise<void> {
    await this.raw("POST", `/v1/computers/${encodeURIComponent(computerId)}/agents/promote`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
    });
  }

  /** Sleep a specific agent by its (computer, port). */
  async demote(computerId: string, port: number): Promise<void> {
    await this.raw("POST", `/v1/computers/${encodeURIComponent(computerId)}/agents/demote`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
    });
  }

  // --- usage --------------------------------------------------------------

  async usage(q: UsageQuery): Promise<UsageResponse> {
    if (!q.start || !q.end) throw new Error("usage: start and end (ISO 8601) are required");
    const qs = `?start=${encodeURIComponent(q.start)}&end=${encodeURIComponent(q.end)}`;
    const res = await this.raw("GET", `/v1/usage${qs}`);
    return (await res.json()) as UsageResponse;
  }

  // --- helpers ------------------------------------------------------------

  /**
   * Live URL for a computer. Prefer the server-provided short_id from the
   * create/get response; fall back to first-8-chars-of-id for back-compat.
   */
  liveUrl(computer: Computer | string): string {
    if (typeof computer === "string") return `https://${computer.slice(0, 8)}.orbcloud.dev`;
    const shortId = computer.short_id ?? (computer.computer_id ?? computer.id ?? "").slice(0, 8);
    if (!shortId) throw new Error("liveUrl: computer has no short_id / computer_id / id");
    return `https://${shortId}.orbcloud.dev`;
  }

  private async raw(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal; auth?: boolean } = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.auth !== false) {
      if (!this.apiKey) throw new Error(`orb api: no api_key set for ${method} ${path}`);
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }
    const req: RequestInit = { method, headers };
    if (init.body !== undefined) req.body = init.body;
    if (init.signal !== undefined) req.signal = init.signal;
    const res = await this.fetchImpl(url, req);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new OrbApiError(res.status, url, text);
    }
    return res;
  }
}
