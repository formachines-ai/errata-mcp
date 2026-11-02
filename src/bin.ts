#!/usr/bin/env node
// errata-mcp: the Errata MCP server over stdio. Logs go to stderr (stdout is the protocol).
// Environment: ERRATA_BASE_URL, ERRATA_FEEDBACK_URL, ERRATA_TIMEOUT_MS, ERRATA_CACHE_TTL_S, ERRATA_LOG_LEVEL (debug|info|warn|error).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrataClient, optionsFromEnv } from "./core/index.js";
import { createServer, USER_AGENT } from "./server.js";

const LEVELS = ["debug", "info", "warn", "error"] as const;
const min = Math.max(0, LEVELS.indexOf((process.env.ERRATA_LOG_LEVEL || "warn") as any));
const log = (level: (typeof LEVELS)[number], msg: string) => {
  if (LEVELS.indexOf(level) >= min) process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} errata-mcp ${msg}\n`);
};

async function main() {
  const client = new ErrataClient({ ...optionsFromEnv(USER_AGENT), log });
  const server = createServer(client, log);
  await server.connect(new StdioServerTransport());
  log("info", `started ${USER_AGENT}, base ${client.baseUrl}`);
  const stop = async () => {
    log("info", `stopping; ${client.stats.requests} requests, ${client.stats.bytes} bytes`);
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  log("error", (e as Error)?.stack || String(e));
  process.exit(1);
});
