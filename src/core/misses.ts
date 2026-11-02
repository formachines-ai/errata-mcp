// Search misses (D12b): when search_error finds nothing, the client tells formachines.ai which error was missing so the
// base can grow where agents look. Only the exception type and a scrubbed message go out — no code, no paths, numbers,
// addresses, hex, quoted values other than plain names, e-mails or token-like strings, at most 200 characters, no
// project name — and only on a miss. Sent in the background: the answer never waits for it and a network failure is
// swallowed. ERRATA_NO_TELEMETRY=1 (or DO_NOT_TRACK=1) turns it off.
// The same normalization runs again on the server (errata/errata/misses.py); both read test/fixtures/miss-normalize.json.

export const MAX_MESSAGE = 200;
export const MAX_INPUT = 2000;
export const MISS_TIMEOUT_MS = 3000;
export const NO_TELEMETRY_ENV = "ERRATA_NO_TELEMETRY";

const ERROR_LINE = /^\s*(?:Uncaught\s+)?(?:[A-Za-z_]\w*\.)*((?:[A-Z][A-Za-z0-9_]*)?(?:Error|Exception|Warning|Exit|Interrupt))(?:\s*\[[A-Z0-9_]+\])?\s*(?::\s*(.*))?$/;
const TYPE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const QUOTED = /(['"`])(.*?)\1/g;
const KEEP_QUOTED = /^(?:@[A-Za-z0-9_.-]{1,40}\/)?[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;   // a name: 'mcp.shared', '@scope/pkg'
const URL_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SECRET = /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|authorization)\s*[:=]\s*\S+/gi;
const BEARER = /\bbearer\s+\S+/gi;
const PATH = /(?<![\w@.\-])(?:[A-Za-z]:\\|\\\\|~\/|\.{1,2}\/|\/)[^\s'"`,;)\]]*/g;
const IP4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g;
const IP6 = /\b[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{0,4}){2,7}\b/g;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HEX = /\b0x[0-9a-fA-F]+\b|\b[0-9a-fA-F]{8,}\b/g;
const TOKEN = /(?<![\w-])[A-Za-z0-9_+/=-]{20,}/g;
const NUMBER = /\b\d+(?:\.\d+)*\b/g;

const tokenLike = (t: string) => t.length >= 20 && /\d/.test(t) && /[A-Za-z]/.test(t);

/** One line, scrubbed, ≤ 200 characters; idempotent. */
export function normalizeMessage(text: string): string {
  let s = (text || "").slice(0, MAX_INPUT).split("\n", 1)[0];
  s = s.replace(QUOTED, (all, _q, inner: string) =>
    KEEP_QUOTED.test(inner) && !tokenLike(inner) && !/^[0-9a-fA-F]{8,}$/.test(inner) ? all : "<str>");
  s = s.replace(URL_RE, "<url>").replace(EMAIL, "<email>")
    .replace(SECRET, (_all, k: string) => `${k} <secret>`).replace(BEARER, "bearer <secret>")
    .replace(PATH, "<path>").replace(IP4, "<ip>").replace(UUID, "<id>").replace(IP6, "<ip>").replace(HEX, "<hex>")
    .replace(TOKEN, (t) => (tokenLike(t) ? "<token>" : t)).replace(NUMBER, "<n>");
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE).trim();
}

/** The last dotted part (a project's own module path stays home); "" when it is not a plain name. */
export function normalizeType(t: string): string {
  const last = (t || "").trim().split(".").pop() || "";
  return TYPE.test(last) ? last : "";
}

export interface MissPayload { source: "mcp" | "cli"; type: string; message: string }

/** The last `SomeError: message` line of the text; null when there is none (code, an entry id, prose) — then nothing
 * is sent. */
export function missPayload(text: string, source: MissPayload["source"]): MissPayload | null {
  const lines = (text || "").slice(0, MAX_INPUT * 4).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = ERROR_LINE.exec(lines[i]);
    if (m) {
      const type = normalizeType(m[1]);
      return type ? { source, type, message: normalizeMessage(m[2] || "") } : null;
    }
  }
  return null;
}

export function telemetryOff(env: NodeJS.ProcessEnv = process.env): boolean {
  const on = (v?: string) => !!v && !["", "0", "false", "no"].includes(v.toLowerCase());
  return on(env[NO_TELEMETRY_ENV]) || on(env.DO_NOT_TRACK);
}
