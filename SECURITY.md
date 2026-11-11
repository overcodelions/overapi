# Security

## Reporting a vulnerability

Please **don't** open a public issue. Report it privately with a [security advisory](https://github.com/overcodelions/overapi/security/advisories/new) on this repository.

Include enough detail to reproduce. overapi holds API credentials, records browser sessions, and serves tools that act on real systems, so reports about **secret exfiltration**, **an agent reaching a write or destructive tool it should not see**, **requests to unintended hosts**, **a recorded session leaving the machine**, path escape, and command injection are especially welcome.

We aim to acknowledge within three working days.

## Out of scope

- An agent misusing a tool you explicitly allowed (writes on, destructive confirmed) — that is the permission working as designed.
- Vulnerabilities in claude, codex, Chrome or Electron themselves — report those upstream.

## How overapi handles secrets

- **Projects name secrets; they never hold them.** An environment says `${ACME_TOKEN}`; the value comes from the macOS keychain, an environment variable, or a `.env` beside the project (ignored by git).
- **The renderer cannot read a secret.** It can set one and ask whether one is set — nothing returns a value.
- **Responses are scrubbed** of the secrets a request carried before they are shown, kept in history, or returned to an agent.
- **Browser sign-ins are yours alone.** Cookies and tokens taken from a sign-in are kept in the keychain, and an environment that uses one is refused for team publishing.
- **Copying an MCP command never copies a secret.** Snippets carry placeholders; installs into Claude Code read the keychain at run time.

## What agents can do

- Tools that change data are hidden unless the environment allows writes; destructive tools also require `confirm: true`, and carry `destructiveHint` so clients ask you first.
- "Try as an agent" runs claude against an in-app server on `127.0.0.1` with a one-time token, and only read tools.
- The security scan runs before publishing to overgo, and critical or high findings block it until fixed or accepted with a reason.

## AI

AI features run your own `claude` or `codex` CLI with your own login. Runs are limited to file-reading tools (plus one docs domain when you give a URL) — no shell, no MCP. Documentation prompts include tool names, paths, parameter and response *shapes*, and — only if you tick the box — a few example values, with anything that looks like a secret removed. Reading a service's source code reads that folder only.

## Network

- Requests go only to the environment's base URL. Self-signed certificates are accepted for `localhost` only.
- Scanning for local servers sends plain `GET`s to `127.0.0.1` and nothing else.
- The explorer clicks links and buttons on a site you choose, and skips anything that looks like delete, pay, send or sign out.
