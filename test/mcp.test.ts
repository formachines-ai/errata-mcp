// The seven acceptance cases of D10 through a real MCP client: the SDK Client starts dist/bin.js over stdio (as an
// agent host would), lists the tools and calls all three against the snapshot served on 127.0.0.1.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { serveSnapshot, deadUrl, Recorded } from "./helpers.js";
import { VERSION } from "../src/version.js";
import { NO_MATCH_NOTE } from "../src/core/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "dist", "bin.js");

async function connect(env: Record<string, string>) {
  const client = new Client({ name: "errata-mcp-test", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN], env: { PATH: process.env.PATH || "", ...env }, stderr: "pipe" });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r: any = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
}

let site: Awaited<ReturnType<typeof serveSnapshot>>;
let client: Client;
const log: Recorded[] = [];

beforeAll(async () => {
  if (!existsSync(BIN)) execSync("npm run build", { cwd: ROOT, stdio: "ignore" });
  site = await serveSnapshot(log);
  client = await connect({ ERRATA_BASE_URL: site.url });
});
afterAll(async () => {
  await client?.close();
  await site?.close();
});

describe("errata-mcp over stdio", () => {
  it("version in code equals package.json", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
  });

  it("lists the three tools with short descriptions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["check_package", "report", "search_error"]);
    for (const t of tools) expect((t.description || "").length).toBeLessThan(500);
    expect(client.getServerVersion()).toMatchObject({ name: "errata", version: VERSION });
  });

  it("check_package opens with the five-line summary (FB-4) and gives readiness", async () => {
    const { body } = await call(client, "check_package", { ecosystem: "pypi", package: "mcp", version: "2.3.0" });
    expect(body.summary[0]).toBe("Dependencies found: 1, 1 with an exact version");
    expect(body.summary[1]).toBe("In Errata: 1 of them");
    expect(body.summary[2]).toMatch(/^Match your versions: 3 entries — \d+ patch, \d+ partial, \d+ lead$/);
    expect(body.summary[3]).toBe("Need a person: 1 to apply once your code is seen to use the changed name (detect), 2 for a manual decision (lead)");
    expect(body.summary[4]).toBe("Not covered: 0 dependencies");
    expect(body.summary[5]).toBe(NO_MATCH_NOTE);
    expect(body.entries.every((e: any) => ["patch", "partial", "lead"].includes(e.readiness))).toBe(true);
    expect(body.entries.find((e: any) => e.verdict === "apply").readiness).toBe("patch");
    const none = await call(client, "check_package", { ecosystem: "pypi", package: "left-pad-not-there", version: "1.0.0" });
    expect(none.body.summary[4]).toBe("Not covered: 1 dependency");
    expect(none.body.summary[5]).toBe(NO_MATCH_NOTE);
  });

  it("1 known package, checked version → found, apply", async () => {
    const { body } = await call(client, "check_package", { ecosystem: "pypi", package: "click", version: "8.5.0" });
    expect(body.status).toBe("found");
    expect(body.entries[0]).toMatchObject({ id: "pypi/click/8.5.0/0001", verdict: "apply", grade: "verified" });
    const mcp = await call(client, "check_package", { ecosystem: "pypi", package: "mcp", version: "2.3.0" });
    expect(mcp.body.entries.map((e: any) => e.verdict).sort()).toEqual(["apply", "lead", "lead"]);   // auto_apply false → lead
  });

  it("2 package without coverage → no_coverage", async () => {
    const { body, isError } = await call(client, "check_package", { ecosystem: "npm", package: "left-pad", version: "1.3.0" });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ status: "no_coverage", entries: [] });
  });

  it("3 intermediate and future versions without proof → unconfirmed_version, lead", async () => {
    const future = await call(client, "check_package", { ecosystem: "pypi", package: "click", version: "8.6.0" });
    expect(future.body).toMatchObject({ status: "unconfirmed_version" });
    expect(future.body.entries[0]).toMatchObject({ verdict: "lead", grade: "possible" });
    const mid = await call(client, "check_package", { ecosystem: "pypi", package: "click", version: "8.4.0" });
    expect(mid.body.entries[0]).toMatchObject({ verdict: "lead", grade: "possible" });
    const old = await call(client, "check_package", { ecosystem: "pypi", package: "click", version: "8.3.1" });
    expect(old.body).toMatchObject({ status: "not_affected" });
    const num = await call(client, "check_package", { ecosystem: "pypi", package: "websockets", version: 18 });   // unquoted
    expect(num.body).toMatchObject({ status: "unconfirmed_version", installed: "18" });
    const range = await call(client, "check_package", { ecosystem: "npm", package: "typescript", version: "^7.0.0" });
    expect(range.body.status).toBe("unconfirmed_version");
  });

  it("4 error text: exact match and no match", async () => {
    const hit = await call(client, "search_error", { text: "ImportError: cannot import name 'session' from 'mcp.shared' (/usr/local/lib/python3.11/site-packages/mcp/shared/__init__.py)" });
    expect(hit.body.status).toBe("found");
    expect(hit.body.hits[0].entries.map((e: any) => e.id)).toContain("pypi/mcp/2.3.0/0002");
    const miss = await call(client, "search_error", { text: "Segmentation fault (core dumped) in libfoo.so" });
    expect(miss.body).toMatchObject({ status: "no_match", hits: [] });
  });

  it("5 merged and withdrawn entries are not offered", async () => {
    const ts = await call(client, "check_package", { ecosystem: "npm", package: "typescript", version: "7.0.2" });
    expect(ts.body.entries.map((e: any) => e.id)).not.toContain("npm/typescript/7.0.2/0007");
    expect(ts.body.not_offered).toContainEqual({ id: "npm/typescript/7.0.2/0007", status: "merged", into: "npm/typescript/7.0.2/0004" });
    const byId = await call(client, "search_error", { text: "npm/typescript/7.0.2/0007" });
    expect(byId.body.status).toBe("no_match");
    expect(byId.body.not_offered[0]).toMatchObject({ status: "merged", into: "npm/typescript/7.0.2/0004" });
    const rep = await call(client, "report", { id: "pypi/openai/3.35.1/0001", verdict: "dispute" });
    expect(rep.body.status).toBe("withdrawn");
  });

  it("6 base unavailable → technical_error, distinct from no_coverage", async () => {
    const down = await connect({ ERRATA_BASE_URL: await deadUrl(), ERRATA_TIMEOUT_MS: "2000" });
    try {
      for (const [name, args] of [["check_package", { ecosystem: "pypi", package: "click", version: "8.5.0" }],
        ["search_error", { text: "No module named 'opentelemetry._events'" }],
        ["report", { id: "pypi/click/8.5.0/0001", verdict: "confirm" }]] as const) {
        const r = await call(down, name, args as any);
        expect(r.isError).toBe(true);
        expect(r.body.status).toBe("technical_error");
        expect(r.body.message).toContain("ECONNREFUSED");
      }
    } finally {
      await down.close();
    }
  });

  it("7 report to a test receiver: confirm received; every request carried the MCP User-Agent", async () => {
    const r = await call(client, "report", { id: "pypi/click/8.5.0/0001", verdict: "confirm", note: "test from W3-1" });
    expect(r.body).toMatchObject({ status: "received", receipt: "fb-local-0001" });
    const post = log.find((x) => x.method === "POST")!;
    expect(JSON.parse(post.body!)).toEqual({ kind: "confirm", errata_id: "pypi/click/8.5.0/0001", outcome: "worked", note: "test from W3-1" });
    expect(new Set(log.map((x) => x.ua))).toEqual(new Set([`formachines-errata-mcp/${VERSION}`]));
    const merged = await call(client, "report", { id: "npm/typescript/7.0.2/0007", verdict: "confirm" });
    expect(merged.body).toMatchObject({ status: "merged", into: "npm/typescript/7.0.2/0004" });
    expect(log.filter((x) => x.method === "POST").length).toBe(1);                               // refused ones never sent
  });

  it("8 a miss is reported in the background, a hit is not; telemetry off and a dropped connection change nothing", async () => {
    const misses = () => log.filter((x) => x.method === "POST" && x.url.endsWith("/v1/miss"));
    const before = misses().length;
    await call(client, "search_error", { text: "ImportError: cannot import name 'session' from 'mcp.shared'" });   // hit
    const miss = await call(client, "search_error", { text: "Traceback:\n  File \"/home/me/proj/x.py\", line 9\nKeyError: 'api_key_123'" });
    expect(miss.body.status).toBe("no_match");
    for (let i = 0; i < 50 && misses().length === before; i++) await new Promise((r) => setTimeout(r, 20));
    expect(misses().length).toBe(before + 1);
    const sent = misses().at(-1)!;
    expect(JSON.parse(sent.body!)).toEqual({ source: "mcp", type: "KeyError", message: "'api_key_123'" });
    expect(sent.ua).toBe(`formachines-errata-mcp/${VERSION}`);

    const offLog: Recorded[] = [];
    const offSite = await serveSnapshot(offLog);
    const off = await connect({ ERRATA_BASE_URL: offSite.url, ERRATA_NO_TELEMETRY: "1" });
    const dropLog: Recorded[] = [];
    const dropSite = await serveSnapshot(dropLog, { miss: "drop" });
    const drop = await connect({ ERRATA_BASE_URL: dropSite.url });
    try {
      expect((await call(off, "search_error", { text: "KeyError: 'zzz'" })).body.status).toBe("no_match");
      const r = await call(drop, "search_error", { text: "KeyError: 'zzz'" });
      expect(r).toMatchObject({ isError: false, body: { status: "no_match" } });
      await new Promise((r) => setTimeout(r, 200));
      expect(offLog.some((x) => x.url.endsWith("/v1/miss"))).toBe(false);
      expect(dropLog.some((x) => x.url.endsWith("/v1/miss"))).toBe(true);                       // tried, failed quietly
      expect((await call(drop, "check_package", { ecosystem: "pypi", package: "click", version: "8.5.0" })).body.status).toBe("found");
    } finally {
      await off.close(); await drop.close(); await offSite.close(); await dropSite.close();
    }
  });
});
