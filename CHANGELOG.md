# Changelog

All notable changes to overapi are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-10

### Added
- **Ways in:** OpenAPI 3, Swagger 2, HAR, Postman v2 and WSDL import; from a
  cURL; from documentation (PDFs, pages, a docs URL) with your claude or codex;
  from a local server — its served spec in one click, a spec behind a login
  fetched with a token, or the service's own source code read to draft every
  endpoint.
- **Recording:** sign in and use a web app in overapi's browser or your own
  Chrome, and its calls become requests; **Explore for me** clicks around on
  its own, skipping anything destructive; a coverage view of what was seen.
- **SOAP:** WSDL import, SOAP 1.1/1.2 envelopes, WS-Security UsernameToken,
  JSON in and out for agents, Faults as errors. A sample service to try.
- **Workbench:** params as a query — what's sent on top, the rest as chips,
  a control per kind of value, a live URL and paste-to-fill; values seen in
  earlier responses offered by name; copy as cURL, fetch, Python or HTTPie;
  replay;
  history; a readable response view with full JSON when truncated.
- **Chains:** which request gives the ids another needs, kept between calls;
  run-first steps; login requests that refresh themselves.
- **Environments and sign-in:** bearer, API key, basic, WS-Security, OAuth 2
  (client credentials, or authorization code with PKCE and refresh tokens
  kept in the keychain, for agents too; set up from the provider's address,
  with presets for Google, Microsoft, Okta and Auth0), a token printed by a
  command (gcloud, az, an SSO CLI), a login request, a browser session,
  or another API's sign-in; *Sign in again* redoes whichever it is and
  resends. Client certificates (mutual TLS) per environment.
- **Bodies:** JSON, form, multipart with file uploads (agents send content,
  never paths), GraphQL with variables, and SOAP.
- **GraphQL:** import from an endpoint or an introspection file; every query
  a read tool and every mutation a write, with its query written out.
- **Sharing through git:** a project is a folder with `overapi.json` and a
  `.gitignore` that keeps `.env` out.
- **Workspaces:** APIs that belong together, with one sign-in, a grid of
  where each runs in every environment, and one MCP server for all of them.
- **Tests:** scenarios from recordings checking status and shape, run in the
  app or `overapi test` (JUnit for CI). Load tests of reads with a live chart
  and failures explained, behind a setting that's off by default.
- **Agent-ready:** one reviewed pass — tidy, fixed values, chains, then AI
  descriptions, argument help, names, what to hide, an agent brief and
  example questions. A tool budget with suggestions, and a security scan that
  blocks team publishing on critical findings.
- **Try as an agent:** ask in plain words and watch claude answer through
  this API's own read-only MCP server.
- **Publish:** Add to Claude Code, snippets for any MCP client, a file, or
  your team's overgo through overcli.
- **CLI:** `import`, `tools`, `check`, `call`, `serve`, `install`, `test`,
  `load` and `scan`.

### Security
- Projects from other people — a clone, or a pull that changes where an API
  sends its secrets — can't use your secrets until you review a summary of
  where they'd go and allow them, in the app and for agents. Your own edits
  keep a project approved; projects with nothing secret aren't asked about.
- Token commands are read only from the keychain; only files you pick are
  uploaded; agents' own arguments can't name secrets; OAuth sign-in pages
  open only over https; the recorder answers only localhost; requests with a
  client certificate get their own connection.
