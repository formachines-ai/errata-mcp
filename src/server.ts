// The Errata MCP server: three tools over the published base (formachines.ai/errata). All logic is in core; this file
// only shapes compact answers. Every answer has a status that tells found / no coverage / unconfirmed version /
// technical error apart.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AGENT_RULE, ErrataClient, ErrataUnavailable, PackageResult, checkPackage, installedFromArg, planReport, sendReport,
  searchError, MAX_NOTE,
} from "./core/index.js";
import { VERSION } from "./version.js";

export const USER_AGENT = `formachines-errata-mcp/${VERSION}`;

type Log = (level: "debug" | "info" | "warn" | "error", msg: string) => void;

const text = (obj: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj) }],
  ...(isError ? { isError: true } : {}),
});

function technical(e: unknown) {
  const msg = e instanceof ErrataUnavailable ? `${e.reason} (${e.url})` : (e as Error)?.message || String(e);
  return text({ status: "technical_error", message: `the Errata base could not be read: ${msg}; this says nothing about the package` }, true);
}

/** found = an entry is checked on this version; unconfirmed_version = entries exist, none checked on this version;
 * not_affected = the version predates every change; no_coverage = the base has no corrections for the package. */
export function packageStatus(r: PackageResult): string {
  if (r.coverage === "no_coverage") return "no_coverage";
  if (r.entries.some((e) => e.grade === "verified")) return "found";
  if (r.entries.length && r.entries.every((e) => e.verdict === "none")) return "not_affected";
  return "unconfirmed_version";
}

export function compactPackage(r: PackageResult) {
  return {
    status: packageStatus(r),
    package: `${r.ecosystem}/${r.package}`,
    installed: r.installed.kind === "exact" ? r.installed.version : r.installed.kind === "range" ? `range ${r.installed.spec}` : "unknown",
    entries: r.entries.map((e) => ({
      id: e.id, verdict: e.verdict, grade: e.grade, reason: e.reason, symbol: e.symbol, wrong: e.wrong, right: e.right,
      detect: e.detect, error: e.error, fails_on: e.fails_on, verified_on: e.verified_on, url: e.url,
    })),
    ...(r.excluded.length ? { not_offered: r.excluded.map((x) => ({ id: x.id, status: x.status, ...(x.target ? { into: x.target } : {}) })) } : {}),
    ...(r.coverage === "no_coverage" ? { note: "no corrections in the base for this package; that is not proof the code is current" } : {}),
  };
}

export function createServer(client: ErrataClient, log: Log = () => {}): McpServer {
  const server = new McpServer({ name: "errata", title: "Errata (formachines.ai)", version: VERSION, websiteUrl: "https://formachines.ai/errata/" });

  server.registerTool("check_package", {
    title: "Check a package version",
    description: "Corrections for a PyPI or npm package where AI models write outdated code, each verified in a sandbox, " +
      "with verdict apply / lead / none for the installed version and the reason. " + AGENT_RULE,
    inputSchema: {
      ecosystem: z.enum(["pypi", "npm"]),
      package: z.string().min(1).max(214),
      // a number too: hosts and models send 8.5 or 18 unquoted
      version: z.union([z.string().max(100), z.number()]).optional().describe("installed version (exact), or a range if that is all you know"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ ecosystem, package: name, version }) => {
    log("info", `check_package ${ecosystem}/${name} ${version ?? "-"}`);
    try {
      const r = await checkPackage(client, ecosystem, name, installedFromArg(ecosystem, version === undefined ? undefined : String(version)));
      return text(compactPackage(r));
    } catch (e) {
      log("warn", `check_package failed: ${(e as Error).message}`);
      return technical(e);
    }
  });

  server.registerTool("search_error", {
    title: "Search by error text",
    description: "Find corrections by an error message or traceback line (ImportError, AttributeError, TypeError …) " +
      "or by an entry id. Returns the matching error signatures and their entries.",
    inputSchema: { text: z.string().min(1).max(2000) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ text: q }) => {
    log("info", `search_error chars=${q.length}`);                  // never the text itself
    try {
      const r = await searchError(client, q);
      const status = r.match === "exact" ? "found" : r.match === "candidates" ? "candidates" : "no_match";
      return text({
        status,
        hits: r.hits.map((h) => ({
          signature: h.signature, type: h.type, message: h.messages[0], url: h.url,
          entries: h.entries.map((e) => ({ id: e.id, package: `${e.ecosystem}/${e.package}`, fails_on: e.fails_on, symbol: e.symbol,
            verdict: "lead", reason: `checked on ${e.package} ${e.fails_on}; the installed version decides apply (check_package)`, url: e.url })),
          ...(h.excluded.length ? { not_offered: h.excluded.map((x) => ({ id: x.id, status: x.status, ...(x.target ? { into: x.target } : {}) })) } : {}),
        })),
        ...(r.excluded_ids.length ? { not_offered: r.excluded_ids.map((x) => ({ id: x.id, status: x.status, ...(x.target ? { into: x.target } : {}), reason: x.reason })) } : {}),
        ...(r.note ? { note: r.note } : {}),
      });
    } catch (e) {
      log("warn", `search_error failed: ${(e as Error).message}`);
      return technical(e);
    }
  });

  server.registerTool("report", {
    title: "Report whether a correction worked",
    description: "Send confirm (the fix worked) or dispute (it did not) for an entry id. Reports are quarantined and " +
      "rechecked in the sandbox before anything changes.",
    inputSchema: {
      id: z.string().min(1).max(120),
      verdict: z.enum(["confirm", "dispute"]),
      note: z.string().max(MAX_NOTE).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ id, verdict, note }) => {
    log("info", `report ${verdict} ${id}`);
    try {
      const plan = await planReport(client, id, verdict, note ?? "");
      const r = await sendReport(client, plan);
      return text({ status: r.status, ...(r.receipt ? { receipt: r.receipt } : {}), ...(plan.target ? { into: plan.target } : {}), message: r.message },
        !r.sent && (r.status === "invalid" || r.status === "rejected"));
    } catch (e) {
      log("warn", `report failed: ${(e as Error).message}`);
      return technical(e);
    }
  });

  return server;
}
