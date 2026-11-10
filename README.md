# overapi

Make any API easy for agents.

overapi is an API client that runs entirely on your machine, with no account and no cloud. Every request you save can become a tool. Build up an API, try it against local, staging or production, shape it into something an agent can use well, then publish it to Claude Code, Codex, overcli, any MCP client, or your org's **overgo**.

It's the fourth app in the family, after overcli, overgit and overdb, and uses the same stack: Electron, React, Vite, Tailwind and TypeScript.

## Four ways in

| | |
| --- | --- |
| **From scratch** | A base URL and your first request, as in any API client. |
| **From a cURL** | Use "Copy as cURL" in the browser's network tab, or take the line from the wiki. Ids in the path become arguments, the values you sent become the example, and any token goes to the keychain. |
| **Import** | OpenAPI 3, Swagger 2, a HAR capture (for APIs with no spec at all) or a Postman v2 collection. |
| **From documentation** | Hand over PDFs, Markdown or HTML pages, a docs URL, or pasted text. Your own `claude` (or `codex`) CLI drafts an OpenAPI document from them, which goes through the normal importer. claude gets Read, Grep and Glob only: no shell, no web, no MCP. |

## The app

- **Overview:** the Build → Try → Shape → Publish checklist with the next step, what agents are told (description and instructions), and the readiness check.
- **Requests:** the workbench. The list sits on the left, the request in the middle, and the response, the exact request sent, and history on the right. Each request also has an **As a tool** tab: offered or not, name, safety, description and response limit. The values you last sent are kept as the request's example.
- **Environments:** colour-coded (blue local, amber test, red production). Each has a base URL, a sign-in whose secrets are kept **in the keychain**, `{{variables}}`, headers, and a read-only/writes switch. Allowing writes on production means typing its name.
- **Publish:** three destinations. **This Mac** gives copy-paste setup for Claude Code/overcli, Codex and generic MCP JSON. **Your org** hands the API to overgo through overcli. **A file** exports the project.
- **Settings:** theme, AI CLI and model, projects folder, request timeout, and the status of the keychain and the overcli link.

## Publishing to overgo

1. **Publish → Your org** writes the project into `~/.overcli/inbox/apis/`. It includes only the chosen environment and the tools that are on, plus the *names* of the secrets, never their values. The button only appears once overcli has created that folder.
2. overcli sends it to the org's control plane with your sign-in.
3. An admin finishes it in overgo's console under **Setup → APIs**, choosing read-only or writes and typing the secrets there.
4. overgo runs `overapi serve` as a tool that workers can be given.

overapi owns the format: `src/shared/overgo.ts`.

## Safety

- Tools are classed as read, write or destructive. `POST …/search` counts as a read; `DELETE` and `POST …/delete` are destructive.
- Environments start read-only. Write tools stay hidden until an environment allows writes, and destructive tools also need `confirm: true` and carry `destructiveHint`.
- Secrets are never stored in the project, never kept from a capture or cURL, and replaced with ••• in anything shown.

## CLI

```sh
npm run build:main
node dist/cli/index.js import examples/acme-orders.openapi.yaml -o ~/overapi/acme-orders
node dist/cli/index.js check   ~/overapi/acme-orders/overapi.json
node dist/cli/index.js call    ~/overapi/acme-orders/overapi.json list_orders --env local --args '{"status":"open"}'
node dist/cli/index.js serve   ~/overapi/acme-orders/overapi.json --env local     # what clients run
node dist/cli/index.js install ~/overapi/acme-orders/overapi.json --env local     # prints the client config
```

The packaged app takes the same `serve` arguments, and when it runs that way it also reads secrets saved in the app's keychain.

## Develop

```sh
npm install
npm run example:server   # fictional Acme Orders API on :4010, token dev-token
npm run dev              # the app (Vite on 5473)
npm test
npm run typecheck
```

```
src/shared   project model, cURL, naming, safety, readiness, install snippets, overgo format
src/core     importers, discovery, HTTP runtime, MCP server, AI CLI runners — never imports electron
src/cli      the command line, under plain Node
src/main     Electron main: keychain, settings, history, overcli handoff, IPC
src/renderer the app
```

## SOAP

overapi reads SOAP services as well as REST ones. Import a WSDL (often the
service address with `?wsdl`) and each operation becomes a request, its
arguments typed from the schema; or record the service, and calls to its
one address split by operation. overapi builds the envelope (SOAP 1.1 or
1.2, with a WS-Security UsernameToken if the environment signs in that way),
and agents send and receive JSON: the response body is converted, and a SOAP
Fault comes back as an error with its message.

Try it on the sample service:

```sh
npm run example:soap   # http://localhost:8089/soap/inventory?wsdl
```

Import `http://localhost:8089/soap/inventory?wsdl`, then set the
environment's sign-in to WS-Security: user `acme`, password `s3cret-pass`.
