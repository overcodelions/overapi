<p align="center">
  <img src="build/icon.png" width="112" alt="overapi">
</p>

<h1 align="center">overapi</h1>

<p align="center">
  <b>The API you can't rewrite, as tools your agents can safely use.</b><br>
  An API client on your machine that turns REST, SOAP and recorded web apps into curated MCP servers.
</p>

<p align="center">
  <a href="https://github.com/overcodelions/overapi/actions/workflows/ci.yml"><img src="https://github.com/overcodelions/overapi/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/MCP-server-7c8bff" alt="MCP server">
  <img src="https://img.shields.io/badge/macOS-Electron-555" alt="macOS · Electron">
</p>

<p align="center">
  Sibling of <a href="https://github.com/overcodelions/overcli">overcli</a> ·
  <a href="https://github.com/overcodelions/overgit">overgit</a> ·
  <a href="https://github.com/overcodelions/overdb">overdb</a>
</p>

---

Every company has APIs agents should be able to use — and almost none of them come with a clean spec. Some have Swagger behind a login, some are SOAP, some exist only as the calls a web app makes. Pointing an agent at them raw gets you a hundred cryptic tools, ids it can't find, and a `DELETE` it shouldn't see.

overapi is the step in between. Bring an API in however you can, use it like Insomnia or Postman, then make it **agent-ready** — names that say what they do, descriptions an agent can choose by, ids that flow from one call to the next, writes hidden until you allow them — and publish it as an MCP server. No account, no cloud: it runs on your Mac, and your secrets stay in the keychain.

## How it goes

| | |
|---|---|
| **1 · Bring it in** | A spec, a cURL, a HAR, a Postman collection, a WSDL, the docs, the service's own source code — or record the web app that uses it. |
| **2 · Use it** | A fast workbench: environments, sign-in, the params that matter, responses you can read, tests and load. |
| **3 · Make it agent-ready** | One pass that tidies, connects and documents it — rules first, then your own claude or codex — with every change shown before it's applied. |
| **4 · Publish** | Into Claude Code in one click, to any MCP client as a snippet, or to your team through overgo. |

## Ways in

- **A server on this Mac.** New API lists what's listening locally — `:4010 node · orders-api — spec · 24` — and imports a served spec in one click. When the spec is behind a login, paste a token and it fetches it anyway; when there is no spec at all, **Read its code** has claude read the service's routes, request and response classes and sign-in (read-only) and draft every endpoint.
- **Import.** OpenAPI 3, Swagger 2, a HAR capture, a Postman v2 collection, or a WSDL.
- **From a cURL.** "Copy as cURL" from the browser: ids in the path become arguments, the values become the example, any token goes to the keychain.
- **From documentation.** PDFs, Markdown or HTML, a docs URL, or pasted text. claude finds the real spec files if the site links to them, and drafts one if it doesn't.
- **Record a web app.** Sign in and use the app in overapi's browser — or your own Chrome, password manager and all — and its API calls become requests. Or let **Explore for me** click around on its own, skipping anything that looks like delete, pay or sign out.
- **SOAP.** Each operation becomes a request with typed arguments; overapi builds the envelope (1.1 or 1.2, WS-Security if needed) and agents see JSON in and out.

## The workbench

- **Params as a query, not a form.** What's being sent sits on top, one line each; everything else the request takes waits below as chips. Each kind of value gets its own control: a three-way *any · true · false* switch, chips for lists, a stepper for numbers, fields for objects. The address bar spells out the query as you go, and pasting a URL fills the params from it.
- **Values it has already seen.** Click an id and pick from the ones earlier responses held, by name — "Acme Supply Co", not `076f0e8a…`. Nothing seen yet? Run the request that lists them, from the same dropdown.
- **Chains.** overapi works out which request gives the ids another needs (`list_accounts → content[0].id → get_account.accountId`), keeps them for the next call, and runs a login first when the API needs one.
- **Environments.** Local, staging and production, colour-coded, each with its base URL, sign-in, variables and headers. New environments start read-only; allowing writes on production means typing its name.
- **Sign-in, however it works.** A token, an API key, user and password, WS-Security, a login request (refreshed when refused), the session from a browser sign-in — or **another API's**. When a sign-in runs out, *Sign in again* redoes it the right way and resends.
- **Tests and load.** Turn a recording into a test that checks status and response shape, run it in CI (`overapi test --junit`), and load-test its reads with a live chart and every failure explained.

## Agent-ready

- **Make it agent-ready.** Tidies what a recording picked up, fixes values that never change, connects the chains, then your claude or codex writes descriptions, argument help, clearer names, what to hide, a brief for the agent and example questions. You see every change, before → after, and the readiness and security scores move as you pick.
- **Tools.** A budget bar, suggestions for what to turn off and why, and a per-tool editor.
- **Security scan.** Leaked secrets, what agents can reach, prompt injection in descriptions, personal data in examples. Critical findings block team publishing until fixed or accepted with a reason.
- **Try as an agent.** Ask a question in plain words; claude answers through this API's own MCP server, read-only, and you watch every tool call. Save the run as a test.

## Workspaces

Services that belong together — the APIs of one product — grouped, with **one sign-in** (the security service signs the others in), **one place to set where each runs** in every environment, and **one MCP server** for the lot, with ids flowing from one service to the next.

## Publish

- **This Mac.** *Add to Claude Code* installs it (per environment); snippets for Codex and any MCP client carry placeholders, never secrets.
- **Your team.** Hand it to overgo through overcli: only the chosen environment, the tools that are on, and the *names* of its secrets. An admin finishes it in overgo's console.
- **A file.** `overapi.json` — readable, diffable, and what `overapi serve` runs.

## Safety

- Tools are read, write or destructive. Write tools stay hidden until an environment allows writes; destructive ones also need `confirm: true` and carry `destructiveHint`, so clients ask you first.
- Secrets live in the keychain, never in a project file, and are scrubbed from everything shown or returned. The renderer can set a secret but never read one.
- Your browser sign-ins are yours: they never publish.
- AI runs use your own CLI and login, with file-reading tools only.

More in [SECURITY.md](SECURITY.md).

## CLI

The app is also a command line — the same code an MCP client runs.

```sh
overapi import  examples/acme-orders.openapi.yaml -o ~/overapi/acme-orders
overapi check   ~/overapi/acme-orders/overapi.json        # what will trip an agent up
overapi call    ~/overapi/acme-orders/overapi.json list_orders --env local --args '{"status":"open"}'
overapi serve   ~/overapi/acme-orders/overapi.json --env local   # what clients run
overapi test    ~/overapi/acme-orders/overapi.json --junit results.xml
overapi load    ~/overapi/acme-orders/overapi.json --scenario checkout --users 20 --duration 30
overapi scan    ~/overapi/acme-orders/overapi.json --fail-on high
```

`overapi serve` also takes a workspace file and serves all its APIs as one server. From a checkout, use `node dist/cli/index.js` in place of `overapi`.

## Run it

Requires Node.js 22.12 or newer and macOS.

```sh
npm install
npm run dev              # Vite + Electron
npm run example:server   # a sample REST API: Acme Orders on :4010, token dev-token
npm run example:soap     # a sample SOAP service: Acme Inventory on :8089
npm test
```

| Folder | |
|---|---|
| `src/core` | Importers, HTTP and SOAP calls, sign-in, the MCP server, tests and load — never imports Electron |
| `src/shared` | The project model, chains, checks, the security scan, workspaces |
| `src/main` | Electron main: keychain, recording browser, Chrome recording, explorer, AI runs |
| `src/renderer` | The app — React, Zustand, Tailwind |
| `src/cli` | The command line, under plain Node |

## Status

Pre-1.0, building in the open with Owen Farr. See the [CHANGELOG](CHANGELOG.md) for what's in it.

## License

[Apache-2.0](LICENSE). The overapi name and logo are covered by [TRADEMARKS.md](TRADEMARKS.md).
