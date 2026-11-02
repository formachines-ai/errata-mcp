// Version parsing and matching for PyPI (PEP 440, the common subset) and npm (semver ranges, the common subset).
// Errata compares one installed version with the versions an entry was checked on; it never widens a checked version
// into a range (before D13 the base proves single versions only).

export type Ecosystem = "pypi" | "npm";

export interface Version {
  raw: string;
  release: number[];
  pre: string | null;   // 1.0rc1, 1.0.0-beta.1 → sorts before 1.0
  post: number | null;  // 1.0.post2 → sorts after 1.0
}

const RELEASE = /^v?(\d+(?:\.\d+)*)(.*)$/i;

export function parseVersion(raw: string): Version | null {
  const s = (raw || "").trim();
  const m = RELEASE.exec(s);
  if (!m) return null;
  const release = m[1].split(".").map((x) => Number(x));
  let rest = m[2].replace(/^[-_.]/, "");
  let pre: string | null = null;
  let post: number | null = null;
  const pm = /^(?:post|rev|r)[-_.]?(\d*)/i.exec(rest);
  if (pm) {
    post = Number(pm[1] || 0);
    rest = rest.slice(pm[0].length);
  }
  rest = rest.replace(/\+.*$/, "");            // local version / build metadata never orders
  if (rest) pre = rest.toLowerCase();
  return { raw: s, release, pre, post };
}

function cmpPre(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;                     // a release sorts after any pre-release of itself
  if (b === null) return -1;
  const pa = a.split(/[.-]/), pb = b.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: Version, b: Version): number {
  const n = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < n; i++) {
    const x = a.release[i] ?? 0, y = b.release[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  const p = cmpPre(a.pre, b.pre);
  if (p) return p;
  return (a.post ?? -1) - (b.post ?? -1) === 0 ? 0 : (a.post ?? -1) < (b.post ?? -1) ? -1 : 1;
}

export function cmp(a: string, b: string): number | null {
  const x = parseVersion(a), y = parseVersion(b);
  return x && y ? compareVersions(x, y) : null;
}

export type Op = "==" | "!=" | ">=" | ">" | "<=" | "<";
export interface Comparator { op: Op; v: string; }
/** A range: alternatives (npm `||`) of comparator sets that must all hold. */
export type Range = Comparator[][];

/** What a manifest or lockfile line says about the installed version. */
export type Installed =
  | { kind: "exact"; version: string; source: string }
  | { kind: "range"; spec: string; range: Range | null; source: string }
  | { kind: "none"; spec: string; source: string };

function bump(release: number[], at: number): string {
  const r = release.slice(0, at + 1);
  while (r.length < at + 1) r.push(0);
  r[at] += 1;
  for (let i = at + 1; i < r.length; i++) r[i] = 0;
  return r.join(".") + "-0";                    // "-0": the lowest pre-release, so 2.0.0-beta is outside ^1
}

function npmComparators(part: string): Comparator[] | null {
  const out: Comparator[] = [];
  const p = part.trim();
  if (p === "" || p === "*" || p === "x" || p === "latest") return [];
  const hy = /^(\S+)\s+-\s+(\S+)$/.exec(p);
  if (hy) return [{ op: ">=", v: hy[1] }, { op: "<=", v: hy[2] }];
  for (let tok of p.split(/\s+/)) {
    const m = /^(\^|~|>=|<=|>|<|=)?\s*v?([0-9xX*]+(?:\.[0-9xX*]+){0,2})(-[0-9A-Za-z.-]+)?$/.exec(tok);
    if (!m) return null;
    const op = m[1] || "=";
    const parts = m[2].split(".");
    const wild = parts.findIndex((x) => /^[xX*]$/.test(x));
    const fixed = (wild < 0 ? parts : parts.slice(0, wild)).map(Number);
    const ver = fixed.join(".") + (m[3] || "");
    if (wild >= 0 || (op === "=" && parts.length < 3)) {           // 1.x, 1.2.*, 1 → a block of versions
      if (!fixed.length) continue;
      if (op === "=" || op === "^" || op === "~") {
        out.push({ op: ">=", v: fixed.join(".") }, { op: "<", v: bump(fixed, fixed.length - 1) });
        continue;
      }
    }
    if (op === "^") {
      const r = ver.split("-")[0].split(".").map(Number);
      while (r.length < 3) r.push(0);
      const at = r[0] > 0 ? 0 : r[1] > 0 ? 1 : 2;
      out.push({ op: ">=", v: ver }, { op: "<", v: bump(r, at) });
    } else if (op === "~") {
      const r = ver.split("-")[0].split(".").map(Number);
      out.push({ op: ">=", v: ver }, { op: "<", v: bump(r, r.length > 1 ? 1 : 0) });
    } else {
      out.push({ op: op === "=" ? "==" : (op as Op), v: ver });
    }
  }
  return out;
}

function pypiComparators(spec: string): Comparator[] | null {
  const out: Comparator[] = [];
  for (const raw of spec.split(",")) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^(~=|===|==|!=|>=|<=|>|<)\s*([A-Za-z0-9.*+!_-]+)$/.exec(t);
    if (!m) return null;
    const [, op, v] = m;
    if (op === "~=") {
      const r = v.split(".");
      const head = parseVersion(v)?.release ?? [];
      out.push({ op: ">=", v }, { op: "<", v: bump(head.slice(0, Math.max(1, r.length - 1)), Math.max(0, r.length - 2)) });
    } else if ((op === "==" || op === "!=") && v.endsWith(".*")) {
      const head = v.slice(0, -2).split(".").map(Number);
      if (op === "==") out.push({ op: ">=", v: head.join(".") }, { op: "<", v: bump(head, head.length - 1) });
      // != 1.2.* excludes a block; ignoring it only widens the range, which keeps "possible" honest
    } else {
      out.push({ op: (op === "===" ? "==" : op) as Op, v });
    }
  }
  return out;
}

/** Turn a version string from a manifest into what we know about the installed version. An exact pin (`1.2.3` in
 * package.json, `==1.2.3` in requirements.txt) is exact; anything else is a range, never a guessed version. */
export function fromSpec(eco: Ecosystem, spec: string | undefined | null, source: string): Installed {
  const s = (spec ?? "").trim();
  if (!s) return { kind: "none", spec: "", source };
  if (eco === "npm") {
    if (/^(file:|link:|workspace:|git|https?:|github:|npm:)/.test(s) || s.includes("/")) return { kind: "none", spec: s, source };
    if (/^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(s) || /^=\s*v?\d+\.\d+\.\d+/.test(s)) {
      return { kind: "exact", version: s.replace(/^=\s*/, "").replace(/^v/, ""), source };
    }
    const alts = s.split("||").map(npmComparators);
    return alts.some((a) => a === null) ? { kind: "range", spec: s, range: null, source }
      : { kind: "range", spec: s, range: alts as Comparator[][], source };
  }
  const exact = /^(?:===?)\s*([A-Za-z0-9.+!_-]+)$/.exec(s);
  if (exact && !exact[1].includes("*")) return { kind: "exact", version: exact[1], source };
  if (/^\d[A-Za-z0-9.+!_-]*$/.test(s)) return { kind: "exact", version: s, source };   // a bare version from a tool
  const c = pypiComparators(s);
  return { kind: "range", spec: s, range: c ? [c] : null, source };
}

function holds(v: string, c: Comparator): boolean {
  const r = cmp(v, c.v);
  if (r === null) return false;
  switch (c.op) {
    case "==": return r === 0;
    case "!=": return r !== 0;
    case ">=": return r >= 0;
    case ">": return r > 0;
    case "<=": return r <= 0;
    case "<": return r < 0;
  }
}

export function satisfies(v: string, range: Range): boolean {
  return range.some((alt) => alt.every((c) => holds(v, c)));
}

/** True when every version the range admits is at most `v` (an upper bound at or below it in each alternative). */
export function rangeAtMost(range: Range, v: string): boolean {
  return range.every((alt) => alt.some((c) => {
    const r = cmp(c.v, v);
    if (r === null) return false;
    return (c.op === "<" && r <= 0) || (c.op === "<=" && r <= 0) || (c.op === "==" && r <= 0);
  }));
}
