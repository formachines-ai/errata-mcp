// Reading the published base: formachines.ai/errata/index.json, the package JSONs, the changelog (merged, withdrawn,
// rechecked versions) and the error-signature index; sending feedback to POST /v1/feedback. Every request carries the
// client's own User-Agent (metrics count formachines-errata-cli and formachines-errata-mcp apart). Responses are
// cached in memory for `cacheTtlMs`; a failed fetch is a technical error, never "no corrections". A search miss goes to
// POST /v1/miss in the background (misses.ts), unless telemetry is off.

import { MissPayload, MISS_TIMEOUT_MS, telemetryOff } from "./misses.js";

export const DEFAULT_BASE_URL = "https://formachines.ai";
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface ClientOptions {
  userAgent: string;                    // "formachines-errata-cli/0.1.0"
  baseUrl?: string;                     // ERRATA_BASE_URL
  feedbackUrl?: string;                 // ERRATA_FEEDBACK_URL, default <baseUrl>/v1/feedback
  missUrl?: string;                     // default <baseUrl>/v1/miss
  telemetry?: boolean;                  // false with ERRATA_NO_TELEMETRY=1 or DO_NOT_TRACK=1: misses are not sent
  timeoutMs?: number;                   // ERRATA_TIMEOUT_MS
  cacheTtlMs?: number;                  // ERRATA_CACHE_TTL_S × 1000
  fetchImpl?: typeof fetch;
  log?: (level: "debug" | "info" | "warn" | "error", msg: string) => void;
}

/** The base could not be read (network, timeout, HTTP status, bad JSON). Distinct from "no corrections". */
export class ErrataUnavailable extends Error {
  constructor(public url: string, public reason: string) {
    super(`Errata base unavailable: ${url} — ${reason}`);
    this.name = "ErrataUnavailable";
  }
}

/** PEP 503 names for PyPI; npm names as they are. */
export function normName(eco: string, name: string): string {
  return eco === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
}

/** "ECONNREFUSED", "ENOTFOUND" … from undici's nested causes, else the message. */
export function netReason(e: any): string {
  const c = e?.cause;
  return c?.code || c?.errors?.[0]?.code || c?.message || e?.message || String(e);
}

export interface Stats { requests: number; bytes: number; cacheHits: number; ms: number; urls: string[] }

/** Options from the environment, so the CLI and the MCP server read the same variables. */
export function optionsFromEnv(userAgent: string, env: NodeJS.ProcessEnv = process.env): ClientOptions {
  const num = (k: string) => (env[k] && Number.isFinite(Number(env[k])) ? Number(env[k]) : undefined);
  return {
    userAgent,
    baseUrl: env.ERRATA_BASE_URL || undefined,
    feedbackUrl: env.ERRATA_FEEDBACK_URL || undefined,
    telemetry: !telemetryOff(env),
    timeoutMs: num("ERRATA_TIMEOUT_MS"),
    cacheTtlMs: num("ERRATA_CACHE_TTL_S") !== undefined ? num("ERRATA_CACHE_TTL_S")! * 1000 : undefined,
  };
}

export class ErrataClient {
  readonly baseUrl: string;
  readonly feedbackUrl: string;
  readonly missUrl: string;
  readonly stats: Stats = { requests: 0, bytes: 0, cacheHits: 0, ms: 0, urls: [] };
  private cache = new Map<string, { at: number; data: unknown }>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private opts: ClientOptions) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.feedbackUrl = opts.feedbackUrl || `${this.baseUrl}/v1/feedback`;
    this.missUrl = opts.missUrl || `${this.baseUrl}/v1/miss`;
  }

  private log(level: "debug" | "info" | "warn" | "error", msg: string) {
    this.opts.log?.(level, msg);
  }

  url(path: string): string {
    return path.startsWith("http") ? path : `${this.baseUrl}${path}`;
  }

  /** GET a JSON document; 404 → null (absence is an answer), any other failure → ErrataUnavailable. */
  async getJson<T = any>(path: string): Promise<T | null> {
    const url = this.url(path);
    const ttl = this.opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < ttl) {
      this.stats.cacheHits++;
      return hit.data as T | null;
    }
    const running = this.inflight.get(url);
    if (running) return running as Promise<T | null>;
    const p = this.fetchJson<T>(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, p);
    return p;
  }

  private async fetchJson<T>(url: string): Promise<T | null> {
    const f = this.opts.fetchImpl ?? fetch;
    const t0 = Date.now();
    this.stats.requests++;
    this.stats.urls.push(url);
    let res: Response;
    try {
      res = await f(url, {
        headers: { "user-agent": this.opts.userAgent, accept: "application/json" },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        redirect: "follow",
      });
    } catch (e: any) {
      this.stats.ms += Date.now() - t0;
      const reason = e?.name === "TimeoutError" ? `timeout after ${this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`
        : netReason(e);
      this.log("warn", `GET ${url} failed: ${reason}`);
      throw new ErrataUnavailable(url, reason);
    }
    const body = await res.text().catch(() => "");
    this.stats.ms += Date.now() - t0;
    this.stats.bytes += Buffer.byteLength(body);
    this.log("debug", `GET ${url} → ${res.status}, ${body.length} chars, ${Date.now() - t0} ms`);
    if (res.status === 404) {
      this.cache.set(url, { at: Date.now(), data: null });
      return null;
    }
    if (!res.ok) throw new ErrataUnavailable(url, `HTTP ${res.status}`);
    if (body.length > MAX_BODY_BYTES) throw new ErrataUnavailable(url, `response larger than ${MAX_BODY_BYTES} bytes`);
    try {
      const data = JSON.parse(body) as T;
      this.cache.set(url, { at: Date.now(), data });
      return data;
    } catch {
      throw new ErrataUnavailable(url, "response is not JSON");
    }
  }

  async index(): Promise<SiteIndex> {
    const d = await this.getJson<SiteIndex>("/errata/index.json");
    if (!d || !Array.isArray(d.packages)) throw new ErrataUnavailable(this.url("/errata/index.json"), "index missing or malformed");
    return d;
  }

  /** The package's JSON, or null when the base has no corrections for it. */
  async package(eco: string, name: string): Promise<PackageDoc | null> {
    const idx = await this.index();
    const n = normName(eco, name);
    const p = idx.packages.find((x) => x.ecosystem === eco && normName(eco, x.package) === n);
    if (!p) return null;
    const d = await this.getJson<PackageDoc>(p.json);
    if (d && !Array.isArray(d.errata)) throw new ErrataUnavailable(p.json, "package JSON malformed");
    return d;
  }

  async changelog(): Promise<ChangelogEvent[]> {
    const d = await this.getJson<{ events: ChangelogEvent[] }>("/errata/changelog/index.json");
    return d?.events ?? [];
  }

  async errorsIndex(): Promise<ErrorsIndex> {
    const d = await this.getJson<ErrorsIndex>("/errata/errors/index.json");
    if (!d || !Array.isArray(d.signatures)) throw new ErrataUnavailable(this.url("/errata/errors/index.json"), "error index missing or malformed");
    return d;
  }

  /** POST /v1/feedback. Returns the receiver's answer ({status: "received", id}) or throws. */
  async feedback(payload: FeedbackPayload): Promise<{ status: string; id?: string; error?: string; http: number }> {
    const f = this.opts.fetchImpl ?? fetch;
    this.stats.requests++;
    this.stats.urls.push(this.feedbackUrl);
    let res: Response;
    try {
      res = await f(this.feedbackUrl, {
        method: "POST",
        headers: { "user-agent": this.opts.userAgent, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e: any) {
      throw new ErrataUnavailable(this.feedbackUrl, netReason(e));
    }
    const text = await res.text();
    let body: any = {};
    try { body = JSON.parse(text); } catch { body = { status: "error", error: text.slice(0, 200) }; }
    this.log("info", `POST ${this.feedbackUrl} → ${res.status} ${body.status ?? ""} ${body.id ?? ""}`);
    if (res.status >= 500) throw new ErrataUnavailable(this.feedbackUrl, `HTTP ${res.status}`);
    return { ...body, http: res.status };
  }

  /** POST /v1/miss. Never throws and never needs awaiting: the caller fires it and answers at once; false when
   * nothing was sent or the receiver did not take it. Not counted in `stats` (that is the cost of reading the base). */
  async reportMiss(payload: MissPayload | null): Promise<boolean> {
    if (!payload || this.opts.telemetry === false) return false;
    const f = this.opts.fetchImpl ?? fetch;
    try {
      const res = await f(this.missUrl, {
        method: "POST",
        headers: { "user-agent": this.opts.userAgent, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(Math.min(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MISS_TIMEOUT_MS)),
      });
      await res.text().catch(() => "");
      this.log("debug", `POST ${this.missUrl} → ${res.status}`);
      return res.ok;
    } catch (e) {
      this.log("debug", `POST ${this.missUrl} failed: ${netReason(e)}`);
      return false;
    }
  }
}

export interface SiteIndex {
  packages: { ecosystem: string; package: string; json: string; url: string; errata: number; new_version?: string; old_version?: string }[];
  updated?: string;
  counts?: Record<string, number>;
}

export interface Entry {
  id: string;
  ecosystem: string;
  package: string;
  symbol?: string;
  kind?: string;
  status?: string;
  merged_into?: string | null;
  url: string;
  wrong?: string;
  right?: string;
  action?: string;
  detect?: string[];
  error_signature?: { type?: string; message?: string; norm?: string } | null;
  versions: { fails_on: string; works_on?: string; changed_in?: string; checked_on?: string[] };
  proof: { auto_apply?: boolean; auto_apply_reason?: string; fails_on?: string; works_on?: string };
  confirmations?: { worked: number; failed: number };
}

export interface PackageDoc { ecosystem: string; package: string; errata: Entry[]; updated?: string }

export interface ChangelogEvent {
  date: string; event: string; id: string; ecosystem: string; package: string; reason?: string;
  target?: string | null; target_url?: string | null; url?: string; version?: string;
}

export interface Signature {
  corrections: number;
  entries: { id: string; ecosystem: string; package: string; fails_on: string; status: string; symbol?: string; url: string }[];
  kind?: string; kind_text?: string; messages?: string[]; norm?: string; packages?: string[]; symbol?: string;
  type?: string; url?: string; slug?: string;
}

export interface ErrorsIndex { signatures: Signature[]; packages?: Record<string, string>; updated?: string }

export interface FeedbackPayload {
  kind: "confirm" | "dispute";
  errata_id: string;
  outcome: "worked" | "failed";
  note?: string;
  model?: string;
}
