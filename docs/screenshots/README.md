# Screenshots

The top-level `README.md` shows these images. They're generated, not hand-captured, so they can be refreshed whenever the UI changes.

| File | Shows |
|---|---|
| `workbench.png` | Hero: Acme Orders in the workbench, `list_orders?status=open` sent to a local server, the response as a table |
| `agent-ready.png` | *Make it agent-ready* on a raw web-app recording (Acme Support): tidy-ups, a fixed value and chains, before they're applied |
| `try-as-agent.png` | MCP server › Try as an agent › Call a tool: `list_orders` over MCP and the JSON the agent reads back |
| `workspace.png` | The Acme Storefront workspace: one API signs the others in, and where each runs per environment |
| `publish.png` | The Publish sheet: this Mac, the team through overgo, a file |
| `review-secrets.png` | A teammate's project (Acme Billing) held back until it's reviewed, with its secret names and warnings |

All are dark theme, 1600×1000 at 2×, framed as macOS windows.

## Regenerating

```bash
npm run build
npm i --no-save playwright-core
pip3 install pillow   # once, for framing
node scripts/readme-screenshots/capture.mjs
```

Pass scene names to capture only some of them, e.g. `node scripts/readme-screenshots/capture.mjs workbench publish`.

[`scripts/readme-screenshots/`](../../scripts/readme-screenshots/) does the whole job:

- **`seed.mjs`** builds a throwaway HOME in your temp dir: Acme Orders, Accounts and Inventory imported with the real CLI from the specs in `examples/` (and two written inline), grouped as the Acme Storefront workspace; a raw recording, Acme Support; and Acme Billing, a "cloned" project left unapproved. Every host is `*.acme.example` or localhost, and every secret is a made-up value in a `.env`.
- **`capture.mjs`** starts `examples/acme-orders-server.mjs` on localhost (port 4010, or a free one) — the only server any request reaches — and runs the built app against the sandbox HOME and its own `--user-data-dir`, so none of your own APIs, history or secrets can appear in an image. It clicks through each scene, rewrites the sandbox path to `~`, then deletes the profile.
- **`main.cjs`** is the entry the app is launched with: the built main process with the keychain switched off, so a run never touches your keychain or stops on a macOS permission prompt.
- **`frame.py`** adds macOS window chrome (traffic lights, rounded corners, soft shadow) on a transparent background, so the images work in GitHub's light and dark themes.

No AI is run: *Make it agent-ready* stops at the rule-based steps, and *Try as an agent* calls a tool directly.

## Adding a shot

Add a scene to `capture.mjs`, add any data it needs to `seed.mjs`, then add a row above and an image to the README. Keep names `kebab-case.png`, and keep everything fictional: acme names and `.example` hosts only, no real people, companies, paths or tokens.
