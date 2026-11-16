# Command line

The app is also a command line: the same code an MCP client runs. Use it to import and check from a terminal, serve a project to any client, and run tests and scans in CI.

From a checkout, after `npm run build`, run `node dist/cli/index.js` in place of `overapi`. `overapi --help` lists everything; `overapi --version` prints the version.

## Secrets

The CLI doesn't use the keychain. It reads secrets from the environment, or from a `.env` file beside `overapi.json`:

```sh
# acme-orders/.env — kept out of git by the project's .gitignore
ACME_ORDERS_TOKEN=dev-token
```

A project's environment says which names it reads (`tokenVar: "ACME_ORDERS_TOKEN"`); `overapi check` tells you which aren't set.

## Commands

### import

```sh
overapi import <file-or-url> [-o <dir>]
```

Makes a project from OpenAPI 3, Swagger 2, a WSDL, a HAR capture, a Postman v2 collection, or a GraphQL introspection result. Writes `<dir>/overapi.json` (default `./<name>/overapi.json`) and refuses to overwrite one that's there.

```sh
overapi import examples/acme-orders.openapi.yaml -o ~/overapi/acme-orders
```

### tools

```sh
overapi tools <overapi.json>
```

The tools, and what each environment offers an agent: reads everywhere, writes only where allowed.

### check

```sh
overapi check <overapi.json>
```

An agent-readiness score out of 100, and what will trip an agent up — secrets that aren't set, write tools no environment offers, and the rest of what *Make it agent-ready* would fix.

### call

```sh
overapi call <overapi.json> <tool> [--env <name>] [--args '<json>'] [--yes]
```

One real call, made the way an agent would make it. Writes need `--yes`.

```sh
overapi call acme-orders/overapi.json list_orders --env local --args '{"status":"open"}'
```

### serve

```sh
overapi serve <overapi.json | overapi-system.json> [--env <name>]
```

Runs the project as an MCP server over stdio — this is what clients run. Given a workspace file, it serves every API in the workspace as one server. Edits to the files reach a running server.

### install

```sh
overapi install <overapi.json> [--env <name>] [--client claude|codex|json]
```

Prints the config that adds this server to a client: a `claude mcp add` line, a block for `~/.codex/config.toml`, or the common `mcpServers` JSON (Claude Desktop, Cursor, Windsurf, a repo's `.mcp.json`). Secret values are placeholders.

### test

```sh
overapi test <overapi.json> [--env <name>] [--scenario <name>] [--writes] [--junit <file>]
```

Runs the project's test scenarios — made in the app from recordings or responses — and checks status and response shape. Exits 1 on a failure. Steps that change data run only with `--writes`, and only where the environment allows writes. `--junit` writes a report your CI can show.

### scan

```sh
overapi scan <overapi.json> [--env <name>] [--fail-on critical|high|medium|low]
```

The [security scan](sharing-and-safety.md#the-security-scan). Exits 1 on any finding at or above `--fail-on` (default `high`).

### load

```sh
overapi load <overapi.json> --scenario <name> [--env <name>] [--users 10] [--duration 30] [--ramp 5] [--i-have-permission]
```

Load-tests a scenario's reads; it never sends writes. A public host needs `--i-have-permission` and is held to 5 users for 30 seconds. Point it at the wrong environment and it's the easiest way to hurt a real API — in the app it's off until you turn it on in Settings › General.

## In CI

overapi isn't on npm yet, so CI builds it from a checkout:

```yaml
- uses: actions/checkout@v4
  with: { repository: overcodelions/overapi, path: overapi }
- run: cd overapi && npm ci && npm run build:main
- run: node overapi/dist/cli/index.js test api/overapi.json --env staging --junit results.xml
  env:
    ACME_ORDERS_TOKEN: ${{ secrets.ACME_ORDERS_TOKEN }}
- run: node overapi/dist/cli/index.js scan api/overapi.json --fail-on high
```
