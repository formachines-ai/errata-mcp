// Error text → corrections, over /errata/errors/index.json. The same scoring as the server's GET /v1/search
// (errata/errata/search.py, D7) so both answer alike; done here because /v1/search answers in HTML for people.
// Only active entries are offered; merged and withdrawn ones are named apart with where they went.

import { ErrataClient, Signature, ChangelogEvent } from "./client.js";
import { Excluded, inactiveById } from "./assess.js";

export const MAX_QUERY = 500;
export const MAX_CHOICES = 5;
export const MIN_SCORE = 3.0;
const TOKEN = /[A-Za-z0-9_@][A-Za-z0-9_.@/-]*/g;
const ENTRY_ID = /\b((?:pypi|npm)\/[A-Za-z0-9@._/-]+?\/[A-Za-z0-9.+!_-]+\/\d{4})\b/g;
const STOP = new Set(("error cannot import name from module no named object has attribute got an unexpected keyword " +
  "argument is not a the of read properties property undefined null reading function constructor type line file in " +
  "most recent call last traceback did you mean this where was to and or see at with for exception raise raised python " +
  "node node_modules site-packages lib usr local home").split(" "));
const W = { SYMBOL: 5, SYMBOL_PART: 2, TYPE: 2, PACKAGE: 2, MESSAGE: 1, VERIFIED: 1 };
const ACTIVE = new Set(["verified"]);

export function tokens(q: string): string[] {
  const out: string[] = [];
  for (const m of (q || "").slice(0, MAX_QUERY).match(TOKEN) ?? []) {
    const t = m.toLowerCase().replace(/^[.\-/]+|[.\-/]+$/g, "");
    if (!t || t.startsWith("/") || (t.includes("/") && !t.startsWith("@")) || STOP.has(t) || t.length < 2) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function parts(symbol: string): Set<string> {
  return new Set(symbol.toLowerCase().split(/[._/-]+/).filter((p) => p.length >= 2 && !STOP.has(p)));
}

export function score(doc: Signature, toks: string[]): number {
  const sym = (doc.symbol || "").toLowerCase();
  const symParts = parts(sym);
  const typ = (doc.type || "").toLowerCase();
  const kinds = new Set([...parts(doc.kind || ""), ...tokens(doc.kind_text || "")]);
  const pkgs = new Set<string>();
  for (const p of doc.packages || []) { pkgs.add(p.toLowerCase()); pkgs.add(p.split("/").slice(1).join("/").toLowerCase()); }
  const msg = new Set<string>();
  for (const m of doc.messages || []) for (const t of tokens(m)) msg.add(t);
  let s = 0;
  for (const t of toks) {
    if (sym && t === sym) s += W.SYMBOL;
    else if (sym && (symParts.has(t) || (t.length > 3 && sym.includes(t)))) s += W.SYMBOL_PART;
    if (t === typ) s += W.TYPE;
    if (pkgs.has(t)) s += W.PACKAGE;
    if (msg.has(t) || kinds.has(t)) s += W.MESSAGE;
  }
  if (s && doc.corrections) s += W.VERIFIED;
  return s;
}

export interface SearchHit {
  signature: string;            // norm, e.g. missing_import:session
  type?: string;
  messages: string[];
  url?: string;
  score: number;
  entries: { id: string; package: string; ecosystem: string; fails_on: string; symbol?: string; url: string }[];
  excluded: Excluded[];
}

export type SearchMatch = "exact" | "candidates" | "none";
export interface SearchResult { match: SearchMatch; hits: SearchHit[]; excluded_ids: Excluded[]; note?: string }

function hit(doc: Signature, s: number, events: ChangelogEvent[]): SearchHit {
  const active = doc.entries.filter((e) => ACTIVE.has(e.status));
  const inactive = doc.entries.filter((e) => !ACTIVE.has(e.status))
    .map((e) => inactiveById(e.id, events) ?? { id: e.id, status: "withdrawn" as const, url: e.url });
  return {
    signature: doc.norm || "", type: doc.type, messages: (doc.messages || []).slice(0, 2), url: doc.url, score: s,
    entries: active.map(({ id, package: p, ecosystem, fails_on, symbol, url }) => ({ id, package: p, ecosystem, fails_on, symbol, url })),
    excluded: inactive,
  };
}

/** exact = one signature clearly wins (the server would 302 to it); candidates = several tie or come close;
 * none = nothing scores. Entry ids in the text win outright; a merged or withdrawn id is reported, not offered. */
export async function searchError(client: ErrataClient, text: string): Promise<SearchResult> {
  const [idx, events] = await Promise.all([client.errorsIndex(), client.changelog()]);
  const docs = idx.signatures;
  const ids = [...(text || "").matchAll(ENTRY_ID)].map((m) => m[1]);
  if (ids.length) {
    const excluded = ids.map((id) => inactiveById(id, events)).filter((x): x is Excluded => !!x);
    const found = docs.filter((d) => d.entries.some((e) => ids.includes(e.id) && ACTIVE.has(e.status)));
    if (found.length) {
      const h = hit(found[0], Infinity, events);
      h.entries = h.entries.filter((e) => ids.includes(e.id));
      return { match: "exact", hits: [h], excluded_ids: excluded };
    }
    if (excluded.length) return { match: "none", hits: [], excluded_ids: excluded, note: "the id names a merged or withdrawn entry" };
  }
  const toks = tokens(text);
  if (!toks.length) return { match: "none", hits: [], excluded_ids: [], note: "no searchable words in the text" };
  const scored = docs.map((d) => [score(d, toks), d] as const)
    .filter(([s]) => s >= MIN_SCORE)
    .sort((a, b) => b[0] - a[0] || String(a[1].norm).localeCompare(String(b[1].norm)));
  if (!scored.length) return { match: "none", hits: [], excluded_ids: [] };
  const best = scored[0][0];
  const top = scored.filter(([s]) => s === best);
  if (top.length === 1 && (scored.length === 1 || best > scored[1][0])) {
    return { match: "exact", hits: [hit(top[0][1], best, events)], excluded_ids: [] };
  }
  return { match: "candidates", hits: scored.slice(0, MAX_CHOICES).map(([s, d]) => hit(d, s, events)), excluded_ids: [] };
}
