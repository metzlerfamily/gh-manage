export const API = "https://api.github.com";
const MAX_RETRIES = 3;

export class GitHubError extends Error {
  constructor(
    public method: string,
    public path: string,
    public status: number,
    message: string,
  ) {
    super(`${method} ${path} → HTTP ${status}: ${message}`);
  }
}

export interface RequestOptions {
  body?: unknown;
  accept?: string;
  allow404?: boolean;
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(r: Response): number | null {
  if (r.status >= 500) return 5000;
  if (r.status !== 403 && r.status !== 429) return null;
  const after = r.headers.get("retry-after");
  if (after) return Number(after) * 1000;
  const reset = r.headers.get("x-ratelimit-reset");
  if (r.headers.get("x-ratelimit-remaining") === "0" && reset) return Math.max(0, Number(reset) * 1000 - Date.now()) + 1000;
  return null;
}

function nextLink(r: Response): string | null {
  const link = r.headers.get("link");
  const m = link?.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

export class GitHub {
  constructor(
    private token: () => string | Promise<string>,
    private base = API,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
    private sleep: Sleep = realSleep,
  ) {}

  async raw(method: string, pathOrUrl: string, opts: RequestOptions = {}): Promise<Response> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : this.base + pathOrUrl;
    const path = url.replace(this.base, "").split("?")[0];
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.token()}`,
        Accept: opts.accept ?? "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      const r = await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (r.ok || (opts.allow404 && r.status === 404)) return r;
      const wait = retryAfterMs(r);
      if (wait === null || attempt >= MAX_RETRIES) {
        let message = r.statusText || "error";
        try {
          const body = (await r.json()) as { message?: string };
          if (body?.message) message = body.message;
        } catch {
          message = r.statusText || "non-JSON error body";
        }
        throw new GitHubError(method, path, r.status, message);
      }
      await this.sleep(wait);
    }
  }

  async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const r = await this.raw(method, path, opts);
    if (r.status === 204 || r.status === 404) return undefined as T;
    return (await r.json()) as T;
  }

  get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.json<T>("GET", path, opts);
  }

  async paginate<T>(path: string, key?: string): Promise<T[]> {
    const out: T[] = [];
    let url: string | null = `${path}${path.includes("?") ? "&" : "?"}per_page=100`;
    while (url) {
      const r = await this.raw("GET", url);
      const body = (await r.json()) as Record<string, T[]> | T[];
      out.push(...(key ? (body as Record<string, T[]>)[key] : (body as T[])));
      url = nextLink(r);
    }
    return out;
  }
}
