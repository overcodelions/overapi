# Getting started

From nothing to an API your agent can use, in about five minutes. This walk-through uses the sample API that ships with overapi, so nothing real is touched.

## 1. Install

Download the Mac app from [the latest release](https://github.com/overcodelions/overapi/releases/latest): the `arm64` build for Apple Silicon, `x64` for Intel. It's signed and notarized, so it opens like any other app, and it updates itself (Settings chooses automatic or ask-first).

overapi needs no account. Projects live in `~/overapi` by default, and secrets in your macOS keychain.

**Optional, but worth it:** the AI steps — *Make it agent-ready*'s descriptions, *Try as an agent*, reading docs or source code — use your own [Claude Code](https://claude.com/claude-code) or Codex CLI and its login. Without one, everything else still works.

## 2. Bring an API in

To follow along with the sample, run it from a checkout of this repo:

```sh
npm install
npm run example:server   # Acme Orders on http://localhost:4010, token dev-token
```

In overapi, press **New API**. It lists servers listening on this Mac — pick `:4010` and import its spec in one click. With your own API, use whichever way in fits:

| You have | Use |
|---|---|
| An OpenAPI / Swagger file or URL | Import, or paste it anywhere with ⌘V |
| A Postman collection, a HAR, a WSDL, a GraphQL endpoint | Import |
| A request copied as cURL from the browser | Paste it — ids become arguments, tokens go to the keychain |
| Documentation (PDF, a docs site) | *From documentation*: claude finds or drafts the spec |
| The service's source code on this Mac | *Read its code*: claude reads the routes and drafts every endpoint |
| Only a website that uses it | [Record the web app](record-a-web-app.md) |

## 3. Use it

The workbench is an API client: pick a request, set the params that matter, and **Send**. For the sample:

1. Open **Environments**, choose `local`, and set its token to `dev-token`. It's saved to the keychain, never to the project file.
2. Open `list_orders`, set `status` to `open`, and send. The response comes back as a table; the JSON is a click away.

Ids you've seen are remembered by name: in a request that needs an order id, click the field and pick from the orders you've already listed.

## 4. Make it agent-ready

Open **MCP server** and press **Make it agent-ready**. One reviewed pass:

1. **Tidy** what an import or recording picked up.
2. **Fix** values that never change, so agents don't have to guess them.
3. **Chain** the requests: which one gives the ids another needs.
4. **Describe**: your claude or codex writes descriptions, argument help, clearer names, what to hide, a brief for the agent and example questions.

Every change is shown before → after, and nothing applies until you say so. No AI CLI? *Steps 1–3 only* runs the rules on their own.

Then press **Try as an agent** and ask something in plain words — "which orders are still open?" — and watch claude answer through this API's own read-only MCP server.

## 5. Add it to your agent

Press **Publish**, then **Add to Claude Code** for the environment you want. That's it: the next Claude Code session has the tools. For other clients, copy the snippet for Codex or the common `mcpServers` shape (Claude Desktop, Cursor, Windsurf, a repo's `.mcp.json`). Snippets carry placeholders, never your secrets.

New environments start read-only: agents see reads, and write tools stay hidden until you allow writes on that environment. See [Sharing and safety](sharing-and-safety.md).

## Next

- Got an API that's only a website? [Record a web app](record-a-web-app.md).
- Need OAuth, a login request, or a token from `gcloud`? [Sign-in](sign-in.md).
- Want it in CI or a terminal? [Command line](cli.md).
