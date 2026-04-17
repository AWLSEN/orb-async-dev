// Typed client for the Orb Cloud REST API at https://api.orbcloud.dev.
// Docs: docs.orbcloud.dev. Every request carries `Authorization: Bearer <api_key>`
// except POST /api/v1/auth/register which mints one from an email.

export interface OrbClientOpts {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface Computer {
  id: string;
  name: string;
  runtime_mb: number;
  disk_mb: number;
  status?: string;
}

export interface Agent {
  id: string;
  computer_id: string;
  status?: string;
}

export interface UsageRow {
  period_start: string;
  period_end: string;
  computer_id?: string;
  gb_hours?: number;
  cost_usd?: number;
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
  async build(id: string, signal?: AbortSignal): Promise<void> {
    await this.raw("POST", `/v1/computers/${encodeURIComponent(id)}/build`, { signal });
  }

  // --- agents -------------------------------------------------------------

  async startAgent(id: string, orgSecrets: Record<string, string> = {}): Promise<Agent> {
    const body = Object.keys(orgSecrets).length === 0 ? "{}" : JSON.stringify({ org_secrets: orgSecrets });
    const res = await this.raw("POST", `/v1/computers/${encodeURIComponent(id)}/agents`, {
      headers: { "content-type": "application/json" },
      body,
    });
    return (await res.json()) as Agent;
  }

  async promote(id: string): Promise<void> {
    await this.raw("POST", `/v1/computers/${encodeURIComponent(id)}/agents/promote`);
  }

  async demote(id: string): Promise<void> {
    await this.raw("POST", `/v1/computers/${encodeURIComponent(id)}/agents/demote`);
  }

  // --- usage --------------------------------------------------------------

  async usage(): Promise<UsageRow[]> {
    const res = await this.raw("GET", "/v1/usage");
    const json = (await res.json()) as UsageRow[] | { rows: UsageRow[] };
    return Array.isArray(json) ? json : (json.rows ?? []);
  }

  // --- helpers ------------------------------------------------------------

  /** Orb exposes each computer as https://{first-8-chars-of-id}.orbcloud.dev. */
  liveUrl(computerId: string): string {
    return `https://${computerId.slice(0, 8)}.orbcloud.dev`;
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
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: init.body,
      signal: init.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new OrbApiError(res.status, url, text);
    }
    return res;
  }
}
