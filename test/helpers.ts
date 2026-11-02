// Test helpers shared by core, errata-mcp and errata-cli: the base as a snapshot of formachines.ai (fixtures/site,
// taken 2026-11-02), served through a fetch stub or a local HTTP server; a fetch that is always down.
import { readFileSync, existsSync } from "node:fs";
import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SITE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "site");

function fileFor(pathname: string): string | null {
  const p = join(SITE, decodeURIComponent(pathname));
  const f = p.endsWith("/") ? join(p, "index.json") : p;
  return existsSync(f) && f.startsWith(SITE) ? f : null;
}

export interface Recorded { url: string; method: string; ua: string; body?: string }

/** fetch over the snapshot; every request is recorded with its User-Agent; POST /v1/feedback is answered like the
 * receiver does (received + id). */
export function snapshotFetch(log: Recorded[] = []): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const ua = new Headers(init.headers).get("user-agent") || "";
    log.push({ url: url.toString(), method: init.method || "GET", ua, body: init.body });
    if (init.method === "POST" && url.pathname === "/v1/feedback") {
      return new Response(JSON.stringify({ status: "received", id: "fb-test-0001", next: "queued for sandbox check" }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (init.method === "POST" && url.pathname === "/v1/miss") {
      return new Response(JSON.stringify({ status: "recorded", id: "miss-test-0001" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const f = fileFor(url.pathname);
    return f ? new Response(readFileSync(f), { status: 200, headers: { "content-type": "application/json" } })
      : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export const downFetch: typeof fetch = (async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
}) as typeof fetch;

/** The snapshot over real HTTP on 127.0.0.1 (the package JSON urls inside it are rewritten to this origin).
 * miss: "drop" closes the connection on POST /v1/miss (a network failure while reporting a search miss). */
export async function serveSnapshot(log: Recorded[] = [], opts: { miss?: "ok" | "drop" } = {}): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  let origin = "";
  const server = createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      log.push({ url: u.toString(), method: req.method || "GET", ua: String(req.headers["user-agent"] || ""), body });
      if (req.method === "POST" && u.pathname === "/v1/feedback") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ status: "received", id: "fb-local-0001", next: "queued for sandbox check" }));
      }
      if (req.method === "POST" && u.pathname === "/v1/miss") {
        if (opts.miss === "drop") return req.socket.destroy();
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ status: "recorded", id: "miss-local-0001" }));
      }
      const f = fileFor(u.pathname);
      if (!f) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(readFileSync(f, "utf8").replaceAll("https://formachines.ai", origin));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: origin, server, close: () => new Promise((r) => server.close(() => r())) };
}

/** A URL on 127.0.0.1 where nothing listens (a port taken and released), so fetch gets ECONNREFUSED. */
export async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}
