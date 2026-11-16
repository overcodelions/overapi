# Sign-in

Each environment (local, staging, production…) has its own sign-in, set in **Environments**. Whatever the kind, the secret parts — tokens, passwords, client secrets, commands — are saved in your macOS keychain and referred to by name in the project file. `overapi.json` never holds a secret, so it's safe to commit.

When a sign-in runs out, **Sign in again** redoes it the right way for its kind and resends the request.

## The kinds

| Kind | What overapi does | Good for |
|---|---|---|
| **Bearer token** | Sends `Authorization: Bearer <token>` | Personal access tokens, long-lived service tokens |
| **API key** | Sends the key in a header or query parameter you name | Most "API key" APIs |
| **Basic** | Sends a user and password as HTTP Basic | Older and internal APIs |
| **WS-Security** | Puts a UsernameToken in the SOAP envelope's header | SOAP services |
| **OAuth 2** | Gets and refreshes tokens from the provider | Google, Microsoft, Okta, Auth0, most SaaS |
| **Token from a command** | Runs a command you saved and sends what it prints | Cloud CLIs and SSO tools |
| **Login request** | Runs one of the API's own requests and keeps the token from its response | APIs with `POST /auth/login` |
| **Browser session** | Sends the cookies (and CSRF token) from a sign-in in overapi's browser | Web apps you [recorded](record-a-web-app.md) |
| **Another API** | Borrows another API's sign-in for the same environment | A system where one service signs in the rest |

### OAuth 2

Two ways:

- **Client credentials** — a machine signs in with a client id and secret; overapi gets a token, and a new one when it runs out.
- **Authorization code with PKCE** — a person signs in once in the browser. The refresh token is kept in the keychain, so the app *and* agents get fresh tokens from then on without anyone signing in again.

Set it up from the provider's address: overapi reads its OpenID Connect discovery document for the token and sign-in URLs. Presets fill in Google, Microsoft, Okta and Auth0. Sign-in pages only open over https.

### Token from a command

For a token a CLI prints:

```sh
gcloud auth print-access-token
az account get-access-token --query accessToken -o tsv
```

The command is stored like a secret, in your keychain, never in the project. That matters: a project someone else shares with you can't make your Mac run anything you didn't save yourself. It runs again after 15 minutes (configurable) and whenever the API answers 401.

### Login request

When the API signs in through one of its own endpoints, pick that request, where the token is in its response (a body path like `token`, or a header), and how to send it (bearer, a header, a query parameter, a cookie). overapi runs it when there's no token, after the refresh interval, and again on a 401 or 403 — then retries the original request once. The username and password on that request are `${SECRET}`s from the keychain.

Recording a web app finds this for you: tick **Use it as the API's sign-in** before building.

### Browser session

After signing in to a site in overapi's browser, an environment can use that session's cookies. It's the quickest way to call a web app's private API, with two limits: the session is *yours* — it's never published or shared — and it expires when the site says so. For anything an agent will use for long, prefer a login request or OAuth.

### Another API

In a [workspace](../README.md#workspaces), one service often signs in all the others. Set the others to **another API** and pick it: they borrow its sign-in for the environment of the same name.

## Client certificates (mutual TLS)

Per environment: a certificate and key, or a `.p12`/`.pfx` bundle, plus a private CA to trust if your servers use one. They're files on this Mac; write the path as `${VAR}` to keep it out of a shared project. Requests with a client certificate get their own connection.

## Headers and variables

Each environment can also send fixed headers and define plain variables:

- `${NAME}` — a **secret**, from the keychain (in the app) or the environment / a `.env` file (on the [command line](cli.md)).
- `{{name}}` — a plain, non-secret **variable** for this environment, like a tenant, region or API version. Use it in the base URL, headers and paths.

Never put a secret in a `{{variable}}`; variables are saved in the project file.

## Agents and secrets

Agents never see secrets. Tool results are scrubbed of them, an agent's own arguments can't name a secret, and file uploads take the file's content from the agent, never a path on your Mac. Details in [Sharing and safety](sharing-and-safety.md).
