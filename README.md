# @formachines/errata-mcp

An MCP server for [Errata](https://formachines.ai/errata/): places where AI models write outdated code for PyPI and
npm libraries, each with a fix verified in a sandbox. Three tools; stdio; no API key.

## Install

Claude Code:

```
claude mcp add errata -- npx -y @formachines/errata-mcp
```

Any client with a JSON config (Claude Desktop, Cursor, Windsurf, VS Code …):

```json
{
  "mcpServers": {
    "errata": { "command": "npx", "args": ["-y", "@formachines/errata-mcp"] }
  }
}
```

Node 20 or newer. Registry name: `ai.formachines/errata`.

## Tools

| tool | input | answer `status` |
|---|---|---|
| `check_package` | `ecosystem` (`pypi`/`npm`), `package`, `version` (exact, or a range; may be omitted) | `found` · `unconfirmed_version` · `not_affected` · `no_coverage` · `technical_error` |
| `search_error` | `text`: an error line, a traceback, or an entry id | `found` · `candidates` · `no_match` · `technical_error` |
| `report` | `id`, `verdict` (`confirm`/`dispute`), `note` (≤ 500 characters) | `received` · `merged` · `withdrawn` · `unknown_entry` · `invalid` · `rejected` · `technical_error` |

Each entry in an answer carries `verdict` (`apply` / `lead` / `none`), `grade` (`verified` / `possible` /
`not_affected` / `unknown`), `reason`, `wrong`, `right`, `detect`, `error`, `fails_on`, `verified_on`, `url`.

Example, `check_package {"ecosystem":"pypi","package":"click","version":"8.5.0"}` against the live base:

```json
{"status":"found","package":"pypi/click","installed":"8.5.0","entries":[{"id":"pypi/click/8.5.0/0001","verdict":"apply","grade":"verified","reason":"checked on click 8.5.0; installed 8.5.0; proof.auto_apply true","symbol":"click.Parameter","wrong":"parameter = click.Parameter([\"--x\"])","right":"parameter = click.Option([\"--x\"])","detect":["click.Parameter"],"error":"Can't instantiate abstract class Parameter with abstract methods _parse_decls, add_to_parser","fails_on":"8.5.0","verified_on":["8.5.0"],"url":"https://formachines.ai/errata/pypi/click/0001-click-parameter/"}]}
```

and the same package at a version nobody checked, `"version":"8.6.0"`:
`status: "unconfirmed_version"`, verdict `lead`, reason *installed 8.6.0 is newer than the versions checked (8.5.0);
one checked version is not a range*.

### Rule

The `check_package` description carries the site's one rule: apply a correction on your own only when its
`versions.fails_on` is not newer than the installed version and its `proof.auto_apply` is true; otherwise show it as
a lead. Until the base proves ranges, the server gives `apply` only for versions the entry was checked on (`fails_on`
and later rechecks): a newer version is `lead`.

Merged and withdrawn entries are never offered: answers list them under `not_offered` with the entry that carries a
merged one now. `report` refuses them before sending. An unreachable base is `technical_error` with `isError: true`,
never `no_coverage`.

## Environment

| variable | default |
|---|---|
| `ERRATA_BASE_URL` | `https://formachines.ai` |
| `ERRATA_FEEDBACK_URL` | `<base>/v1/feedback` |
| `ERRATA_TIMEOUT_MS` | `8000` per request |
| `ERRATA_CACHE_TTL_S` | `600` (in-process cache: one index and changelog per ten minutes) |
| `ERRATA_LOG_LEVEL` | `warn` (logs go to stderr; the text of `search_error` is never logged) |

Requests carry the User-Agent `formachines-errata-mcp/<version>`, so the site counts MCP traffic apart.

## Overhead

Measured 2026-11-02 against formachines.ai: the first `check_package` costs 3 requests (index 5.9 kB, changelog 31 kB,
the package JSON 5–12 kB), later calls in the next ten minutes only the package JSON (or nothing, when cached).
`search_error` costs one 31 kB request for the error index. Answers are compact: 0.6 kB for `click`, 1.9 kB for
`typescript` (two entries), 0.9 kB for a matched error.

## What the server does not promise

- **Not a full scan.** The base covers a few dozen packages; `no_coverage` means no corrections, not that the code is
  current.
- **No range proof.** One checked version is not a range; newer versions are `lead`.
- **Not an applier.** The server never edits code; `apply` says the base allows applying the fix as is.
- **Reports are not published.** `report` sends to a quarantine that is rechecked in the sandbox before anything
  changes; a note is never shown to other agents.
- **No offline mode.** Without the network every tool answers `technical_error`.

## Check it yourself

```
npx -y @modelcontextprotocol/inspector --cli npx -y @formachines/errata-mcp --method tools/list
```

## Development

```
npm install
npm test
npm run typecheck
npm pack
```

`src/core` is shared with [errata-cli](https://github.com/formachines-ai/errata-cli) and kept identical in both. Tests run against a snapshot of formachines.ai/errata in `test/fixtures/site` (2026-11-02); `npm test` starts the built server over stdio with the SDK client and runs the seven acceptance cases; `scripts/inspect-live.sh` repeats them with MCP Inspector against the live base. `server.json` follows the registry schema `2025-12-11`.

MIT licence. The data is CC BY 4.0 (formachines.ai/errata).
