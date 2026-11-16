# Sharing and safety

overapi sits between an agent and a real system, so most of what it does is about what the agent *can't* do. This page covers what agents are offered, how projects are shared through git, and what happens when someone else's project wants your secrets.

## What agents can reach

Every tool is **read**, **write** or **destructive**, guessed on import from its method and name, and yours to change in **MCP server › Tools**.

- **Reads** are offered in every environment.
- **Writes** stay hidden until the environment allows writes. New environments start read-only, and allowing writes on one named `production` means typing its name.
- **Destructive** tools (deletes and anything irreversible) also need a required `confirm: true` argument, and carry MCP's `destructiveHint`, so clients that respect it ask you first. Without `confirm`, the call is refused with an explanation.
- **Tools you turn off** aren't offered at all. A tool budget and suggestions help you keep the list short; agents choose better from fewer, well-described tools.

## Where secrets live

- In your macOS **keychain**. Never in `overapi.json`, never in the snippets you copy.
- On the [command line](cli.md), from the environment or a `.env` beside `overapi.json`. Every project gets a `.gitignore` that keeps `.env` out of git.
- Scrubbed from everything shown or returned, to you and to agents. The app's UI can set a secret but never read one back.

## Sharing a project through git

A project is a folder:

```
acme-orders/
  overapi.json   # requests, environments, tools, descriptions, tests
  .gitignore     # keeps .env out
```

`overapi.json` is readable and diffs cleanly; it's what `overapi serve` runs. Commit it next to the API's code. A teammate opens the folder in overapi (or runs it with the CLI) and adds their own secrets. That's the whole shared collection — no account, no cloud workspace.

## Reviewing a project from someone else

A project you didn't write — a clone, or a pull that changed it — could send your secrets somewhere new: a different base URL, a different sign-in, a different header. So overapi holds them back until you've looked:

- A project is **new to you**, or its addresses, sign-in or the secret names it reads **changed outside the app** → its secrets are held back, in the app and for agents served through the app.
- overapi shows a summary: where each environment sends requests, how each signs in, which secret names it reads, and anything **worth a second look** — a sign-in borrowed and sent to another host, a token command, a sign-in page that isn't https, a client certificate, a delete not marked destructive, a request marked read-only that can change data, a file upload from your Mac. **Allow** it, and it runs with your secrets.
- **Your own edits** in the app keep a project approved. A project that uses no secrets isn't asked about.

Run straight from the CLI (`overapi serve path/to/overapi.json`), overapi trusts the file you hand it: choosing to run it is the approval.

## The security scan

**MCP server › Security**, or `overapi scan` in CI, checks for:

- leaked secrets in requests, examples or descriptions
- what agents can reach, per environment
- prompt injection in descriptions — text that tells an agent to do something
- personal data in examples, common after a recording

Each finding has a severity. Critical ones block publishing to your team until they're fixed or accepted with a reason.

## Publishing to a team

**Publish › Your team** hands the API to overgo through overcli: only the environment you choose, only the tools that are on, and only the *names* of its secrets. An admin supplies the values in overgo's console. Your secrets never leave your Mac.

## Other guarantees

- Token commands only come from your keychain, so a shared project can't run a command on your Mac.
- Only files you pick are uploaded; agents send file *content*, never a path on your Mac.
- OAuth sign-in pages open only over https.
- The recorder answers only on localhost.
- While **Explore for me** runs, only reads leave the recording window.
- AI runs use your own claude or codex CLI and login, with file-reading tools only.

Found a way around any of this? Please report it privately — see [SECURITY.md](../SECURITY.md).
