// What an entry means for one installed version: a grade (how much the base proves for this version) and a verdict
// (what an agent may do). Before D13 the base proves single versions: fails_on, plus the versions a recheck confirmed
// (changelog "rechecked"). A newer installed version is "possible", never "verified".

import { ErrataClient, Entry, ChangelogEvent, normName } from "./client.js";
export { normName };
import { Ecosystem, Installed, cmp, fromSpec, satisfies, rangeAtMost } from "./version.js";

/** The one rule the site prints in llms.txt, the page footer and the JSON agent_rule (errata/applicability.py AGENT_RULE);
 * the same as CLIENT_RULE since the owner's decision of 2026-11-02. */
export const AGENT_RULE =
  "Apply a correction on your own only when the installed version is one it was checked on " +
  "(versions.checked_on: versions.fails_on and every recheck) and its proof.auto_apply is true " +
  "(proof.equivalent is true and proof.applicability.status is applies). On a newer version than those " +
  "checked, a version between versions.works_on and versions.fails_on, or an unknown version, show it " +
  "to the user as a lead and do not apply it; on versions.works_on or older it does not apply.";

/** How the clients read it until D13: "not newer than installed" is proven only where a check ran on that version. */
export const CLIENT_RULE =
  "apply = checked on the installed version and proof.auto_apply true; lead = everything else that may apply; " +
  "none = the installed version predates the change. A newer version than the ones checked is never 'apply'.";

/** FB-4: the line every check answer ends with, CLI and MCP alike. */
export const NO_MATCH_NOTE = "No match does not mean your project is free of such errors.";

export type Grade = "verified" | "possible" | "not_affected" | "unknown";
/** FB-1: what an entry is good for. patch = the short patch applies word for word (proof.auto_apply); partial = it
 * covers part of the change; lead = it does not apply word for word, the entry has a full example that works. */
export type Readiness = "patch" | "partial" | "lead";
export type Verdict = "apply" | "lead" | "none";

export interface Assessed {
  id: string;
  grade: Grade;
  verdict: Verdict;
  reason: string;
  symbol?: string;
  fails_on: string;
  works_on?: string;
  verified_on: string[];
  auto_apply: boolean;
  readiness: Readiness;
  wrong?: string;
  right?: string;
  detect?: string[];
  error?: string;
  url: string;
}

export interface Excluded { id: string; status: "merged" | "withdrawn"; target?: string | null; reason?: string; url?: string }

export type Coverage = "covered" | "no_coverage";

export interface PackageResult {
  ecosystem: string;
  package: string;
  installed: Installed;
  coverage: Coverage;
  entries: Assessed[];
  excluded: Excluded[];
  package_url?: string;
}

const INACTIVE = new Set(["merged", "withdrawn", "retracted"]);


/** Versions an entry is proven on: fails_on, versions.checked_on when the site gives it, and every changelog recheck. */
export function verifiedOn(e: Entry, events: ChangelogEvent[]): string[] {
  const out = [e.versions.fails_on];
  for (const v of e.versions.checked_on ?? []) if (!out.includes(v)) out.push(v);   // the site's list (2026-11-02)
  for (const ev of events) {
    if (ev.event === "rechecked" && ev.id === e.id && ev.version && !out.includes(ev.version)) out.push(ev.version);
  }
  return out;
}

/** The site's readiness field (since 2026-11-09); for older JSON, the same mapping from proof. */
export function readinessOf(e: Entry): Readiness {
  if (e.readiness === "patch" || e.readiness === "partial" || e.readiness === "lead") return e.readiness;
  const st = e.proof.applicability?.status;
  if (e.proof.auto_apply === true && (st === undefined || st === "applies")) return "patch";
  return st === "incomplete" ? "partial" : "lead";
}

export function assessEntry(e: Entry, inst: Installed, events: ChangelogEvent[] = []): Assessed {
  const fails = e.versions.fails_on;
  const works = e.versions.works_on ?? e.proof.works_on;
  const ver = verifiedOn(e, events);
  const auto = e.proof.auto_apply === true;
  const base = {
    id: e.id, symbol: e.symbol, fails_on: fails, works_on: works, verified_on: ver, auto_apply: auto, readiness: readinessOf(e),
    wrong: e.wrong, right: e.right, detect: e.detect, error: e.error_signature?.message, url: e.url,
  };
  const checked = `checked on ${e.package} ${ver.join(", ")}`;
  const leadWhy = auto ? "" : `; not for automatic application: ${e.proof.auto_apply_reason || "proof.auto_apply is false"}`;

  if (inst.kind === "exact") {
    const v = inst.version;
    if (ver.some((x) => cmp(x, v) === 0)) {
      return auto
        ? { ...base, grade: "verified", verdict: "apply", reason: `${checked}; installed ${v}; proof.auto_apply true` }
        : { ...base, grade: "verified", verdict: "lead", reason: `${checked}; installed ${v}${leadWhy}` };
    }
    const toWorks = works ? cmp(v, works) : null;
    if (toWorks !== null && toWorks <= 0) {
      return { ...base, grade: "not_affected", verdict: "none",
        reason: `installed ${v} is not newer than ${works}, where the old code was checked to work` };
    }
    const toFails = cmp(v, fails);
    if (toFails === null) {
      return { ...base, grade: "unknown", verdict: "lead", reason: `installed version '${v}' could not be compared; ${checked}` };
    }
    if (toFails < 0) {
      return { ...base, grade: "possible", verdict: "lead",
        reason: `installed ${v} lies between ${works ?? "?"} (works) and ${fails} (fails); the change landed somewhere in between, not checked on ${v}` };
    }
    return { ...base, grade: "possible", verdict: "lead",
      reason: `installed ${v} is newer than the versions checked (${ver.join(", ")}); one checked version is not a range` };
  }
  if (inst.kind === "range") {
    if (!inst.range) {
      return { ...base, grade: "unknown", verdict: "lead", reason: `range '${inst.spec}' not understood; ${checked}` };
    }
    if (works && rangeAtMost(inst.range, works)) {
      return { ...base, grade: "not_affected", verdict: "none",
        reason: `range '${inst.spec}' stays at or below ${works}, where the old code works` };
    }
    const inRange = ver.filter((x) => satisfies(x, inst.range!));
    if (inRange.length) {
      return { ...base, grade: "possible", verdict: "lead",
        reason: `range '${inst.spec}' (no lockfile) admits ${inRange.join(", ")}, where it was checked; the installed version is not known` };
    }
    return { ...base, grade: "unknown", verdict: "lead",
      reason: `range '${inst.spec}' (no lockfile) does not include a checked version (${ver.join(", ")}); the installed version is not known` };
  }
  return { ...base, grade: "unknown", verdict: "lead", reason: `installed version not known; ${checked}` };
}

/** Entries of a package that were merged or withdrawn: never offered, listed so the answer says why. */
export function excludedFor(eco: string, name: string, events: ChangelogEvent[]): Excluded[] {
  const n = normName(eco, name);
  const seen = new Map<string, Excluded>();
  for (const ev of events) {
    if ((ev.event !== "merged" && ev.event !== "withdrawn") || ev.ecosystem !== eco || normName(eco, ev.package) !== n) continue;
    if (!seen.has(ev.id)) seen.set(ev.id, { id: ev.id, status: ev.event, target: ev.target ?? null, reason: ev.reason, url: ev.url });
  }
  return [...seen.values()];
}

/** Check one package at one installed version (or range, or nothing). Throws ErrataUnavailable when the base cannot
 * be read: callers must report that as a technical error, not as "no corrections". */
export async function checkPackage(client: ErrataClient, eco: Ecosystem, name: string, inst: Installed): Promise<PackageResult> {
  const [d, events] = await Promise.all([client.package(eco, name), client.changelog()]);
  const excluded = excludedFor(eco, name, events);
  if (!d) return { ecosystem: eco, package: name, installed: inst, coverage: "no_coverage", entries: [], excluded };
  const active = d.errata.filter((e) => !INACTIVE.has(String(e.status ?? "")) && !e.merged_into
    && !excluded.some((x) => x.id === e.id));
  const idx = await client.index();
  const p = idx.packages.find((x) => x.ecosystem === eco && normName(eco, x.package) === normName(eco, name));
  return {
    ecosystem: eco, package: d.package, installed: inst, coverage: "covered",
    entries: active.map((e) => assessEntry(e, inst, events)), excluded, package_url: p?.url,
  };
}

/** Convenience for the MCP tool: the version argument as typed by the agent (exact, range or empty). */
export function installedFromArg(eco: Ecosystem, version: string | undefined): Installed {
  return fromSpec(eco, version, "argument");
}

/** One entry by id among merged/withdrawn events: what the base says about it instead. */
export function inactiveById(id: string, events: ChangelogEvent[]): Excluded | null {
  const ev = events.find((x) => x.id === id && (x.event === "merged" || x.event === "withdrawn"));
  return ev ? { id, status: ev.event as "merged" | "withdrawn", target: ev.target ?? null, reason: ev.reason, url: ev.url } : null;
}

/** FB-4: the first answer of a check in five lines — what was read, what Errata covers, what matches by version
 * (patch / partial / lead apart), what needs a person, what is not covered — plus NO_MATCH_NOTE. */
export interface CheckSummary {
  dependencies: number;
  exact: number;
  covered: number;
  matching: { entries: number; patch: number; partial: number; lead: number };
  to_check: { usage: number; manual: number };
  not_covered: number;
  note: string;
}

export function summarize(results: PackageResult[]): CheckSummary {
  const live = results.flatMap((r) => r.entries.filter((e) => e.verdict !== "none"));
  const by = (k: Readiness) => live.filter((e) => e.readiness === k).length;
  return {
    dependencies: results.length,
    exact: results.filter((r) => r.installed.kind === "exact").length,
    covered: results.filter((r) => r.coverage === "covered").length,
    matching: { entries: live.length, patch: by("patch"), partial: by("partial"), lead: by("lead") },
    to_check: { usage: live.filter((e) => e.verdict === "apply").length, manual: live.filter((e) => e.verdict === "lead").length },
    not_covered: results.filter((r) => r.coverage === "no_coverage").length,
    note: NO_MATCH_NOTE,
  };
}

const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;

export function summaryLines(s: CheckSummary): string[] {
  return [
    `Dependencies found: ${s.dependencies}, ${s.exact} with an exact version`,
    `In Errata: ${s.covered} of them`,
    `Match your versions: ${n(s.matching.entries, "entry", "entries")} — ${s.matching.patch} patch, ` +
      `${s.matching.partial} partial, ${s.matching.lead} lead`,
    `Need a person: ${s.to_check.usage} to apply once your code is seen to use the changed name (detect), ` +
      `${s.to_check.manual} for a manual decision (lead)`,
    `Not covered: ${n(s.not_covered, "dependency", "dependencies")}`,
    s.note,
  ];
}
