# Contributing to overapi

Thanks for helping. overapi is small and opinionated; a few rules keep it that way.

## Rules that are tested

- **`src/core/` and `src/shared/` must never import `electron`.** The same code runs in the app, in the `overapi` CLI, and in every MCP server a client starts. `src/core/noElectron.test.ts` enforces this and will fail your PR.
- **The renderer never reads a secret.** There is a channel to set one (`secrets:set`) and one to ask whether it is set (`secrets:status`) — never one that returns a value. Projects name secrets as `${VAR}`; values live in the macOS keychain, an environment variable, or a `.env` beside the project.
- **Agents get read-only by default.** A tool that changes data is offered only when the environment allows writes, and a destructive one also needs `confirm: true`. Don't add a path around `offered()` in `src/shared/project.ts`.
- **AI proposes, people apply.** Anything claude or codex writes — documentation, a drafted API, a plan — comes back as changes to review. AI runs use the person's own CLI with file-reading tools only (no shell, no web unless one docs domain was given, no MCP).
- **Responses and secrets stay out of prompts** except where the UI says so ("Include a few example values"), and anything that looks like a secret is dropped even then (`looksSecret` in `src/shared/scan.ts`).
- New behaviour needs a test. Pure logic belongs in `src/shared/` or `src/core/` and is testable without Electron.

## Getting started

```bash
nvm use              # Node 22.12+
npm install
npm run dev          # Vite + Electron
npm test             # vitest
npm run typecheck
```

The examples give you something to point it at without touching a real system:

```bash
npm run example:server   # a small REST API with a spec (acme orders)
npm run example:soap     # a SOAP service with a WSDL (acme inventory)
```

## Layout

| Folder | What lives there |
|---|---|
| `src/core/` | Import (OpenAPI, Swagger, HAR, Postman, WSDL), HTTP and SOAP calls, sign-in flow, the MCP server, scenarios and load. No Electron. |
| `src/shared/` | The project model, checks, chains, the security scan, naming, workspaces. Pure. |
| `src/main/` | The Electron main process: IPC, keychain, the recording browser, Chrome recording, the explorer, AI runs. |
| `src/renderer/` | React + Zustand + Tailwind UI. |
| `src/cli/` | `overapi serve / test / load / scan / check …`. |

## Pull requests

- One logical change per PR, with a description of what changes for the person using it.
- `npm run build` and `npm test` pass.
- Never use a real company, customer or internal system name in code, tests, fixtures or examples — use fictional acme names. The pre-commit hook and CI check for this.
- Commit messages say what changed and why, in plain words.

## Reporting security issues

Not in a public issue — see [SECURITY.md](SECURITY.md).
