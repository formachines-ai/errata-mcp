import { describe, it, expect } from "vitest";
import {
  ErrataClient, ErrataUnavailable, checkPackage, fromSpec, cmp, satisfies, searchError, planReport, sendReport,
  tokens, assessEntry, Entry,
} from "../src/core/index.js";
import { snapshotFetch, downFetch, Recorded } from "./helpers.js";

const UA = "formachines-errata-test/0.0.0";
const client = (log: Recorded[] = []) => new ErrataClient({ userAgent: UA, fetchImpl: snapshotFetch(log) });

describe("versions", () => {
  it("orders releases, pre-releases and post-releases", () => {
    expect(cmp("1.10", "1.9")).toBe(1);
    expect(cmp("2.2.0", "2.2")).toBe(0);
    expect(cmp("1.0rc1", "1.0")).toBe(-1);
    expect(cmp("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(cmp("1.0.post1", "1.0")).toBe(1);
    expect(cmp("abc", "1.0")).toBeNull();
  });
  it("reads exact pins as exact and everything else as a range", () => {
    expect(fromSpec("npm", "7.0.2", "package.json")).toMatchObject({ kind: "exact", version: "7.0.2" });
    expect(fromSpec("pypi", "==8.5.0", "requirements.txt")).toMatchObject({ kind: "exact", version: "8.5.0" });
    expect(fromSpec("npm", "^7.0.0", "package.json").kind).toBe("range");
    expect(fromSpec("pypi", ">=1.17", "requirements.txt").kind).toBe("range");
    expect(fromSpec("pypi", "", "requirements.txt").kind).toBe("none");
    expect(fromSpec("npm", "github:a/b", "package.json").kind).toBe("none");
  });
  it("matches npm and PEP 440 ranges", () => {
    const r = (eco: "npm" | "pypi", s: string) => (fromSpec(eco, s, "t") as any).range;
    expect(satisfies("7.0.2", r("npm", "^7.0.0"))).toBe(true);
    expect(satisfies("8.0.0", r("npm", "^7.0.0"))).toBe(false);
    expect(satisfies("8.0.0-beta", r("npm", "^7.0.0"))).toBe(false);
    expect(satisfies("0.3.29", r("npm", "~0.3.28"))).toBe(true);
    expect(satisfies("0.4.0", r("npm", "~0.3.28"))).toBe(false);
    expect(satisfies("1.5.0", r("npm", "1.x || >=3"))).toBe(true);
    expect(satisfies("1.18.1", r("pypi", ">=1.17,<2"))).toBe(true);
    expect(satisfies("1.18.1", r("pypi", "~=1.17"))).toBe(true);
    expect(satisfies("2.0", r("pypi", "~=1.17"))).toBe(false);
    expect(satisfies("1.18.1", r("pypi", "==1.18.*"))).toBe(true);
  });
});

describe("assess", () => {
  const e: Entry = {
    id: "pypi/x/2.0/0001", ecosystem: "pypi", package: "x", url: "u",
    versions: { fails_on: "2.0", works_on: "1.0" }, proof: { auto_apply: true },
  };
  const ex = (v: string) => assessEntry(e, fromSpec("pypi", "==" + v, "t"));
  it("grades an exact version against the checked ones", () => {
    expect(ex("2.0")).toMatchObject({ grade: "verified", verdict: "apply" });
    expect(ex("2.1")).toMatchObject({ grade: "possible", verdict: "lead" });           // a newer version is not proven
    expect(ex("1.5")).toMatchObject({ grade: "possible", verdict: "lead" });           // between works_on and fails_on
    expect(ex("1.0")).toMatchObject({ grade: "not_affected", verdict: "none" });
    expect(assessEntry({ ...e, proof: { auto_apply: false, auto_apply_reason: "differs" } }, fromSpec("pypi", "==2.0", "t")))
      .toMatchObject({ grade: "verified", verdict: "lead" });
  });
  it("counts a changelog recheck as a checked version", () => {
    const ev = [{ date: "d", event: "rechecked", id: e.id, ecosystem: "pypi", package: "x", version: "2.1" }];
    expect(assessEntry(e, fromSpec("pypi", "==2.1", "t"), ev)).toMatchObject({ grade: "verified", verdict: "apply", verified_on: ["2.0", "2.1"] });
  });
  it("never invents an installed version for a range", () => {
    expect(assessEntry(e, fromSpec("pypi", ">=1.5", "t"))).toMatchObject({ grade: "possible", verdict: "lead" });
    expect(assessEntry(e, fromSpec("pypi", ">=2.1", "t"))).toMatchObject({ grade: "unknown", verdict: "lead" });
    expect(assessEntry(e, fromSpec("pypi", "<1.0", "t"))).toMatchObject({ grade: "not_affected", verdict: "none" });
    expect(assessEntry(e, fromSpec("pypi", "", "t"))).toMatchObject({ grade: "unknown", verdict: "lead" });
  });
});

describe("checkPackage over the snapshot", () => {
  it("click 8.5.0 → verified, apply; every request carries the User-Agent", async () => {
    const log: Recorded[] = [];
    const r = await checkPackage(client(log), "pypi", "click", fromSpec("pypi", "==8.5.0", "t"));
    expect(r.coverage).toBe("covered");
    expect(r.entries[0]).toMatchObject({ id: "pypi/click/8.5.0/0001", grade: "verified", verdict: "apply" });
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((x) => x.ua === UA)).toBe(true);
  });
  it("huggingface_hub 2.4.0 → verified by the recheck; 2.5.0 → possible", async () => {
    const c = client();
    expect((await checkPackage(c, "pypi", "huggingface_hub", fromSpec("pypi", "==2.4.0", "t"))).entries[0])
      .toMatchObject({ grade: "verified", verdict: "apply" });
    expect((await checkPackage(c, "pypi", "huggingface-hub", fromSpec("pypi", "==2.5.0", "t"))).entries[0])
      .toMatchObject({ grade: "possible", verdict: "lead" });
  });
  it("a package without corrections is no_coverage; merged and withdrawn entries are listed, not offered", async () => {
    const c = client();
    expect((await checkPackage(c, "npm", "left-pad", fromSpec("npm", "1.3.0", "t"))).coverage).toBe("no_coverage");
    const openai = await checkPackage(c, "pypi", "openai", fromSpec("pypi", "==3.35.1", "t"));
    expect(openai).toMatchObject({ coverage: "no_coverage", entries: [] });
    expect(openai.excluded).toEqual([expect.objectContaining({ id: "pypi/openai/3.35.1/0001", status: "withdrawn" })]);
    const ts = await checkPackage(c, "npm", "typescript", fromSpec("npm", "7.0.2", "t"));
    expect(ts.entries.map((x) => x.id)).toEqual(["npm/typescript/7.0.2/0001", "npm/typescript/7.0.2/0004"]);
    expect(ts.excluded.length).toBeGreaterThan(5);
    expect(ts.excluded.find((x) => x.id === "npm/typescript/7.0.2/0007")).toMatchObject({ status: "merged", target: "npm/typescript/7.0.2/0004" });
  });
  it("the base unreachable is a technical error, not no_coverage", async () => {
    const c = new ErrataClient({ userAgent: UA, fetchImpl: downFetch });
    await expect(checkPackage(c, "pypi", "click", fromSpec("pypi", "==8.5.0", "t"))).rejects.toBeInstanceOf(ErrataUnavailable);
  });
  it("caches: a second check costs no request", async () => {
    const log: Recorded[] = [];
    const c = client(log);
    await checkPackage(c, "pypi", "click", fromSpec("pypi", "==8.5.0", "t"));
    const n = log.length;
    await checkPackage(c, "pypi", "click", fromSpec("pypi", "==8.5.0", "t"));
    expect(log.length).toBe(n);
    expect(c.stats.cacheHits).toBeGreaterThan(0);
  });
});

describe("searchError", () => {
  it("tokenises like the server", () => {
    expect(tokens("ImportError: cannot import name 'session' from 'mcp.shared' (/usr/local/lib/x.py)"))
      .toEqual(["importerror", "session", "mcp.shared"]);
  });
  it("exact, none, candidates, and a merged id", async () => {
    const c = client();
    const ex = await searchError(c, "ModuleNotFoundError: No module named 'opentelemetry._events'");
    expect(ex.match).toBe("exact");
    expect(ex.hits[0].entries.map((e) => e.id)).toContain("pypi/opentelemetry-api/1.45.1/0002");
    expect((await searchError(c, "segmentation fault in libfoo")).match).toBe("none");
    const merged = await searchError(c, "what about npm/typescript/7.0.2/0007 ?");
    expect(merged.match).toBe("none");
    expect(merged.excluded_ids[0]).toMatchObject({ status: "merged", target: "npm/typescript/7.0.2/0004" });
    const byId = await searchError(c, "pypi/click/8.5.0/0001");
    expect(byId.match).toBe("exact");
    expect(byId.hits[0].entries.map((e) => e.id)).toEqual(["pypi/click/8.5.0/0001"]);
  });
  it("never offers merged or retracted entries under a signature", async () => {
    const c = client();
    const idx = await c.errorsIndex();
    const sigs = idx.signatures.filter((s) => s.entries.some((e) => e.status !== "verified"));
    expect(sigs.length).toBeGreaterThan(0);
    for (const sig of sigs) {
      const bad = sig.entries.filter((e) => e.status !== "verified").map((e) => e.id);
      const r = await searchError(c, (sig.messages || [])[0] || "");
      for (const h of r.hits) expect(h.entries.map((e) => e.id)).not.toEqual(expect.arrayContaining([bad[0]]));
      const h = r.hits.find((x) => x.signature === sig.norm);
      if (h) expect(h.excluded.map((x) => x.id)).toEqual(expect.arrayContaining(bad));
    }
  });
});

describe("report", () => {
  it("plans and sends confirm with worked; refuses merged, withdrawn and unknown ids", async () => {
    const log: Recorded[] = [];
    const c = client(log);
    const plan = await planReport(c, "pypi/click/8.5.0/0001", "confirm", "test from W3-1");
    expect(plan).toMatchObject({ ok: true, payload: { kind: "confirm", outcome: "worked", note: "test from W3-1" } });
    const sent = await sendReport(c, plan);
    expect(sent).toMatchObject({ sent: true, receipt: "fb-test-0001" });
    expect(log.at(-1)).toMatchObject({ method: "POST", ua: UA });
    expect(await planReport(c, "npm/typescript/7.0.2/0007", "dispute")).toMatchObject({ ok: false, status: "merged", target: "npm/typescript/7.0.2/0004" });
    expect(await planReport(c, "pypi/openai/3.35.1/0001", "dispute")).toMatchObject({ ok: false, status: "withdrawn" });
    expect(await planReport(c, "pypi/click/8.5.0/0099", "confirm")).toMatchObject({ ok: false, status: "unknown_entry" });
    expect(await planReport(c, "nope", "confirm")).toMatchObject({ ok: false, status: "invalid" });
    expect(await planReport(c, "pypi/click/8.5.0/0001", "maybe")).toMatchObject({ ok: false, status: "invalid" });
  });
});
