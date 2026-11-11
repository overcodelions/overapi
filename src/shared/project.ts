// The overapi project file (overapi.json): everything needed to serve one
// API to an agent. It is plain JSON on purpose so it can be read in a diff,
// committed beside the API's code, and handed to someone else.
//
// It never holds a secret. Auth names an environment VARIABLE, and the
// value is read at call time from the process environment or a .env file
// beside the project. That is what makes the file safe to commit and to
// publish.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/// How a tool changes the world. Drives what the MCP server offers:
///   read        — always offered.
///   write       — offered only when the environment allows writes.
///   destructive — as write, and the call must also pass `confirm: true`.
export type Safety = 'read' | 'write' | 'destructive';

export type ParamIn = 'path' | 'query' | 'header' | 'body';

/// A JSON Schema fragment. Kept loose: importers copy what a spec says and
/// trim it, and nothing here validates against it.
export type JsonSchema = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  format?: string;
  default?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
};

export interface ParamDef {
  name: string;
  in: ParamIn;
  required: boolean;
  description?: string;
  schema: JsonSchema;
}

/// How the request body is built from the arguments.
///   none        — no body.
///   json-fields — body params become the keys of one JSON object.
///   json-whole  — a single `body` argument is sent as the JSON body.
///   form        — body params are sent url-encoded.
///   multipart   — body params are sent as multipart/form-data; a param
///                 whose schema is `format: binary` is a file.
///   soap        — body params become the operation's elements in a SOAP envelope (ToolDef.soap).
///   graphql     — body params are the variables of ToolDef.graphql's query.
export type BodyMode = 'none' | 'json-fields' | 'json-whole' | 'form' | 'multipart' | 'soap' | 'graphql';

export interface ToolDef {
  /// Stable identity: `METHOD /path`. Survives renames.
  id: string;
  /// The name the agent sees. [a-zA-Z0-9_-], at most 64 characters.
  name: string;
  description: string;
  enabled: boolean;
  safety: Safety;
  method: HttpMethod;
  /// Path template relative to the environment's base URL, `{name}` for
  /// path params.
  path: string;
  params: ParamDef[];
  bodyMode: BodyMode;
  /// Characters of response body handed back to the agent. Longer bodies
  /// are cut and say so.
  responseLimit?: number;
  /// Where the tool came from, for the person curating it.
  origin?: { operationId?: string; summary?: string; tags?: string[]; samples?: number };
  /// The arguments last sent from the workbench — kept so the request is
  /// ready to send again, and shown to the person as a worked example.
  example?: Record<string, unknown>;
  /// Where it sits in the list. Absent: the import's tag or folder, else
  /// the first word of the path (groupOf).
  group?: string;
  /// Fixed headers this request always sends, on top of the environment's.
  /// `{{name}}` and `${SECRET}` work as they do there. Not arguments: the
  /// agent never sees or sets them.
  headers?: Record<string, string>;
  /// Sign-in for this request only. Absent: the environment's.
  auth?: AuthSpec;
  /// Values kept from this request's response for later requests — "log
  /// in, then call": a token here becomes {{token}} everywhere after.
  captures?: Capture[];
  /// Other requests to run first — "get a fresh id, then call this". Each
  /// runs with the values saved on it; `missing` skips it when its
  /// variable is already kept. Runs for agents too.
  before?: BeforeStep[];
  /// A SOAP operation: the envelope, SOAPAction and namespace to send it with.
  soap?: import('./soap').SoapInfo;
  /// A GraphQL operation: the query sent, its body params as variables.
  graphql?: { query: string; operationName?: string };
  /// The shape of what it answers, from a recording or the last Send — how
  /// overapi works out which request feeds which (chains.ts).
  returns?: import('./scenario').Shape;
}

export interface BeforeStep {
  toolId: string;
  when: 'always' | 'missing';
  /// For `missing`: the {{variable}} that, once kept, makes the step unnecessary.
  var?: string;
}

export interface Capture {
  /// The variable it fills: {{var}}.
  var: string;
  from: 'body' | 'header';
  /// body: a path like `data.token` or `items[0].id`; header: its name.
  path: string;
}

/// The list group a request falls in.
export function groupOf(t: ToolDef): string {
  if (t.group?.trim()) return t.group.trim();
  const tag = t.origin?.tags?.find((x) => x !== 'drafted from docs');
  if (tag) return tag;
  const seg = t.path.split('/').filter((s) => s && !s.startsWith('{') && !/^(api|rest|v\d+)$/i.test(s))[0];
  return seg ?? 'other';
}

/// Every secret the project reads: environments' sign-ins and headers, and
/// requests' own.
export function isLoginTool(tool: ToolDef, env: EnvDef): boolean {
  return env.auth.type === 'login' && env.auth.toolId === tool.id;
}

/// `${SECRET}` names written into a request's saved values — a login
/// request's credentials, say.
export function exampleSecrets(t: ToolDef): string[] {
  return [...JSON.stringify(t.example ?? {}).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
}

export function secretNames(p: Project): string[] {
  const out = new Set<string>();
  for (const t of p.tools) for (const v of exampleSecrets(t)) out.add(v);
  for (const e of p.envs) for (const v of envVars(e)) out.add(v);
  for (const t of p.tools) {
    if (t.auth) for (const v of envVars({ name: '', baseUrl: '', auth: t.auth, allowWrites: false, headers: t.headers })) out.add(v);
    else for (const v of Object.values(t.headers ?? {})) for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) out.add(m[1]);
  }
  return [...out];
}

export type AuthSpec =
  | { type: 'none' }
  | { type: 'bearer'; tokenVar: string }
  | { type: 'apiKey'; in: 'header' | 'query'; name: string; valueVar: string }
  | { type: 'basic'; userVar: string; passVar: string }
  /// SOAP's WS-Security UsernameToken, in the envelope's header.
  | { type: 'wsse'; userVar: string; passVar: string }
  /// Sign in by running one of the API's own requests (POST /auth/login…),
  /// keep the token it answers with, and send it on every other request.
  /// Runs when there is no token, after `refreshMinutes`, and again on a
  /// 401/403 (then the request is retried once). The credentials are the
  /// values saved on the login request — `${SECRET}`s from the keychain.
  /// Signed in by another API — a system's sign-in service. Its sign-in
  /// for the environment of the same name (a login request, a browser
  /// session, a token) is borrowed: the same headers go on these requests.
  /// `api` is that API's name; `path` where its file was when picked.
  | { type: 'via'; api: string; path?: string }
  /// OAuth 2 (src/core/oauth.ts). client_credentials: overapi gets a token
  /// with the client's id and secret, and again when it runs out.
  /// authorization_code: a person signs in once in the browser (PKCE); the
  /// refresh token is saved as the secret `refreshTokenVar`, so the app and
  /// agents both get fresh tokens from it.
  | {
      type: 'oauth2';
      grant: 'client_credentials' | 'authorization_code';
      /// The provider's address, where its token and sign-in URLs were
      /// found (OpenID Connect discovery). The URLs below are what's used.
      issuer?: string;
      tokenUrl: string;
      /// The provider's sign-in page (authorization_code).
      authUrl?: string;
      clientIdVar: string;
      /// Absent for a public client (PKCE alone).
      clientSecretVar?: string;
      refreshTokenVar?: string;
      scope?: string;
      audience?: string;
      /// How the client proves itself to the token endpoint. Absent: in the
      /// body, and with HTTP Basic if the provider refuses that.
      clientAuth?: 'body' | 'basic';
      /// The loopback port the browser returns to. Default 47801.
      redirectPort?: number;
      /// Extra parameters for the sign-in page — Google's
      /// access_type=offline, without which it gives no refresh token.
      authParams?: Record<string, string>;
    }
  /// A token printed by a command on this Mac — `gcloud auth
  /// print-access-token`, `az account get-access-token …`, an SSO CLI.
  /// The command is kept like a secret (`commandVar`), never in the
  /// project: a shared project can't run anything you didn't save yourself.
  /// Run again after `refreshMinutes` (default 15) and on a 401.
  | { type: 'command'; commandVar: string; sendAs: 'bearer' | 'header'; name?: string; refreshMinutes?: number }
  | {
      type: 'login';
      toolId: string;
      from: 'body' | 'header';
      path: string;
      sendAs: 'bearer' | 'header' | 'query' | 'cookie';
      /// Header, query or cookie name, for sendAs other than bearer.
      name?: string;
      refreshMinutes?: number;
    };

export interface EnvDef {
  name: string;
  baseUrl: string;
  auth: AuthSpec;
  /// Write and destructive tools are hidden from agents unless this is on.
  allowWrites: boolean;
  /// Fixed headers sent on every call. Values may reference secrets as
  /// `${VAR}` and plain variables as `{{name}}`.
  headers?: Record<string, string>;
  /// Plain, non-secret values for this environment — a tenant, a region,
  /// an API version — used as `{{name}}` in the base URL, headers and
  /// paths. Secrets never go here; they are variables named by `auth`.
  vars?: Record<string, string>;
  /// Signed in through overapi's browser: the Cookie (and CSRF or token)
  /// headers above came from a session on `site`, and expire with it. The
  /// person's own sign-in — never published for others.
  browserSession?: { site: string; at: string; via?: 'overapi' | 'chrome' };
  /// A client certificate presented on HTTPS requests (mutual TLS), and a
  /// CA to trust beyond the system's. Files on this machine: write
  /// `${VAR}` to keep the path out of a shared project.
  tls?: TlsDef;
}

export interface TlsDef {
  certFile?: string;
  keyFile?: string;
  /// A .p12/.pfx bundle, in place of cert + key.
  pfxFile?: string;
  caFile?: string;
  /// The secret that unlocks the key or bundle.
  passphraseVar?: string;
}

export type SourceKind = 'openapi' | 'swagger' | 'wsdl' | 'har' | 'postman' | 'graphql' | 'docs' | 'curl' | 'manual';

/// `{{name}}` filled from the environment's plain variables. Unknown names
/// are left as written, so a mistake shows in the URL rather than vanishing.
/// `runtime`: values kept from earlier responses (captures). They win over
/// the environment's, being newer.
export function fillVars(text: string, env: Pick<EnvDef, 'vars'>, runtime?: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (whole, name: string) => runtime?.[name] ?? env.vars?.[name] ?? whole);
}

/// What kind of place an environment is, from its name — for colour and
/// for the guard rails, not stored.
export type EnvKind = 'local' | 'test' | 'production' | 'other';
export function envKind(name: string): EnvKind {
  if (/prod|live/i.test(name)) return 'production';
  if (/local|dev/i.test(name)) return 'local';
  if (/stag|test|qa|sandbox|uat|preview/i.test(name)) return 'test';
  return 'other';
}

export interface Project {
  overapi: 1;
  /// Server name: lower-case, [a-z0-9-]. What a client lists it as.
  name: string;
  title: string;
  description: string;
  version: string;
  /// Told to the agent when it connects: what this API is for, and the
  /// things it should know that no single tool description says.
  instructions?: string;
  source?: { kind: SourceKind; ref?: string; importedAt?: string };
  envs: EnvDef[];
  tools: ToolDef[];
  /// Test scenarios: recorded flows to run again, as tests or load.
  scenarios?: import('./scenario').Scenario[];
  /// Security findings the person accepted, with why (scan.ts) — kept in
  /// the file so the reason travels with a publish.
  review?: { accepted?: Record<string, import('./scan').Accepted> };
  /// Questions this API should be able to answer — written by "Make it
  /// agent-ready", offered as starters when you ask it something.
  examples?: string[];
}

export const DEFAULT_RESPONSE_LIMIT = 20_000;

export function toolId(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/// Every variable name the environment's auth and headers read.
export function envVars(env: EnvDef): string[] {
  const out = new Set<string>();
  const a = env.auth;
  if (a.type === 'bearer') out.add(a.tokenVar);
  if (a.type === 'apiKey') out.add(a.valueVar);
  if (a.type === 'basic' || a.type === 'wsse') {
    out.add(a.userVar);
    out.add(a.passVar);
  }
  if (a.type === 'oauth2') {
    out.add(a.clientIdVar);
    if (a.clientSecretVar) out.add(a.clientSecretVar);
    // Filled by signing in, not typed: listed so it shows as set or not.
    if (a.grant === 'authorization_code' && a.refreshTokenVar) out.add(a.refreshTokenVar);
  }
  if (a.type === 'command') out.add(a.commandVar);
  if (env.tls?.passphraseVar) out.add(env.tls.passphraseVar);
  for (const v of Object.values(env.headers ?? {})) {
    for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) out.add(m[1]);
  }
  return [...out].filter(Boolean);
}

/// Whether an environment offers this tool to an agent.
export function offered(tool: ToolDef, env: EnvDef): boolean {
  if (!tool.enabled) return false;
  // The sign-in request is plumbing: overapi runs it, agents never do.
  if (isLoginTool(tool, env)) return false;
  return tool.safety === 'read' || env.allowWrites;
}

export function emptyProject(name: string): Project {
  return {
    overapi: 1,
    name: slug(name) || 'api',
    title: name,
    description: '',
    version: '0.1.0',
    envs: [],
    tools: [],
  };
}

/// The prefix for a project's secret names: "Acme Shipping API" ->
/// ACME_SHIPPING, so its key is ACME_SHIPPING_API_KEY, not ..._API_API_KEY.
export function varPrefix(projectName: string): string {
  return (slug(projectName).replace(/(^|-)(api|rest)$/, '').replace(/-/g, '_').toUpperCase() || 'API').slice(0, 30);
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/// Shape-checks a parsed project file. Returns the reason it is not one,
/// or null. Deliberately shallow: enough to refuse the wrong file with a
/// sentence instead of crashing three screens later.
export function projectProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'not a JSON object';
  const p = value as Partial<Project>;
  if (p.overapi !== 1) return 'missing "overapi": 1 — this is not an overapi project file';
  if (typeof p.name !== 'string' || !p.name) return 'missing "name"';
  if (!Array.isArray(p.envs)) return '"envs" must be a list';
  if (!Array.isArray(p.tools)) return '"tools" must be a list';
  for (const t of p.tools) {
    if (!t || typeof t !== 'object' || typeof t.name !== 'string' || typeof t.path !== 'string' || typeof t.method !== 'string') {
      return 'a tool is missing its name, method or path';
    }
  }
  return null;
}
