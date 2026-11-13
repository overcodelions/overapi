// The renderer's whole view of main: one typed map of invoke channels and
// one event stream.

import type { Project, ToolDef, AuthSpec } from './project';
import type { ServeCommand } from './install';
import type { BrowserVia, RecordedCall, RecordMode } from './recording';
import type { Scenario, ScenarioRun, StepResult } from './scenario';
import type { SystemRef } from './system';
export type { SystemRef } from './system';

export interface ExploreStatusDto {
  running: boolean;
  pages: number;
  maxPages: number;
  current?: string;
  found: number;
  reason?: string;
  /// Requests the read-only guard stopped before they went.
  blocked?: number;
}

/// core/scenario.ts's LoadSnapshot, as the renderer sees it.
export interface LoadSnapshotDto {
  elapsedSec: number;
  done: boolean;
  users: number;
  total: number;
  errors: number;
  timeline: { t: number; requests: number; errors: number; p50: number; p95: number; users: number }[];
  overall: { p50: number; p95: number; max: number };
  steps: { stepId: string; name: string; count: number; errors: number; p50: number; p95: number; p99: number; max: number; failures?: { label: string; count: number; sample?: string }[] }[];
  stopped?: string;
  sampleErrors: string[];
}

export interface ProjectRef {
  path: string;
  title: string;
  name: string;
  tools: number;
  missing?: boolean;
  /// Where its environments point (origins) — to mark it while recording.
  origins?: string[];
}

export interface TryRequest {
  path: string;
  project: Project;
  env: string;
  toolId: string;
  args: Record<string, unknown>;
}

export interface TryResponse {
  ok: boolean;
  error?: string;
  status?: number;
  statusText?: string;
  durationMs?: number;
  body?: string;
  truncated?: boolean;
  /// The whole body when `body` (what an agent gets) was cut.
  full?: string;
  contentType?: string;
  /// Response headers, secrets scrubbed.
  headers?: Record<string, string>;
  bytes?: number;
  /// Variables this response filled (captures), names to values.
  captured?: Record<string, string>;
  /// It signed in first (or again, after a 401).
  signedIn?: boolean;
  /// A refusal overapi can't fix itself, and what the person should do.
  hint?: string;
  request?: { method: string; url: string; headers: Record<string, string>; body?: string; parts?: { name: string; value?: string; file?: string }[] };
}

export interface SeenSuggestions {
  values: { v: string | number; label?: string; row?: import('./seen').SeenRow; from: string }[];
  sources: { path: string; toolId: string; toolName: string; api: string }[];
}

export interface HistoryEntry {
  id: string;
  at: string;
  toolId: string;
  toolName: string;
  env: string;
  args: Record<string, unknown>;
  ok: boolean;
  status?: number;
  ms?: number;
  method: string;
  url?: string;
  error?: string;
}

export type Loaded = { ok: true; project: Project; note?: string } | { ok: false; error: string };
export type Opened = { ok: true; path: string; note?: string } | { ok: false; error?: string };

/// Where a secret's value comes from, in the order they are tried.
export type SecretSource = 'keychain' | 'env' | 'dotenv' | null;

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  /// Which CLI drafts from documentation. auto = claude if installed, else codex.
  ai: 'auto' | 'claude' | 'codex';
  aiModel: string;
  projectsDir: string;
  timeoutSec: number;
  /// Download updates in the background and install them at quit; off,
  /// only say one exists and download when asked.
  autoUpdate: boolean;
  /// stable: tagged releases. beta: prereleases too.
  updateChannel: 'stable' | 'beta';
  /// Load tests in the Tests tab. Off by default: aimed at the wrong
  /// environment, a load test is the easiest way to hurt a real API.
  loadTesting: boolean;
  /// Shown once: the first-run tour.
  toured: boolean;
}

export interface AppInfo {
  version: string;
  packaged: boolean;
  userData: string;
  serve: ServeCommand;
  keychain: boolean;
  overcliInbox: string;
  overcliTakesApis: boolean;
  ai: { claude: boolean; codex: boolean };
  /// The Chromium-family browser installed, if any — to record in it.
  chrome?: string;
}

export interface DiscoverRequest {
  files: string[];
  url?: string;
  pasted?: string;
  notes?: string;
  baseUrl?: string;
  title?: string;
  /// A service's own source folder: the endpoints are read from its code.
  sourceDir?: string;
  /// What that source is (Java, Node…), as the scan found.
  source?: string;
}

export interface CurlAdd {
  path: string;
  tool: ToolDef;
  baseUrl: string;
  auth: AuthSpec;
  secret?: string;
  env: string;
}

/// A value kept from a response (a capture), for {{name}} in later requests.
export interface RuntimeVar {
  name: string;
  value: string;
  from?: string;
  at: string;
}

export interface LocalServer {
  port: number;
  pid: number;
  process: string;
  folder?: string;
  dir?: string;
  source?: string;
  needsAuth?: boolean;
  kind: 'json' | 'html' | 'http';
  status: number;
  title?: string;
  spec?: { url: string; title: string; baseUrl?: string; tools: number };
}

export interface Installs {
  /// Per environment: each installed environment is its own server.
  claude: Record<string, { at: string; name: string }>;
  overgo: Published | null;
}

export interface Published {
  at: string;
  env: string;
  id: string;
}

export interface IPCInvokeMap {
  'app:info': () => AppInfo;
  'settings:get': () => Settings;
  'settings:set': (patch: Partial<Settings>) => Settings;
  'settings:pickDir': () => string | null;
  /// Whether a project is approved as it is, and what it would do with your secrets.
  'trust:status': (path: string, project: Project) => { trusted: boolean; summary: import('./trust').TrustSummary };
  /// Approve a project as it is now.
  'trust:allow': (path: string, project: Project) => void;
  /// A file on this Mac: a multipart upload, a client certificate.
  'dialog:pickFile': (title?: string) => string | null;
  /// OAuth authorization code: signs in in the browser (PKCE), keeps the
  /// access token and saves the refresh token in the keychain.
  'oauth:signIn': (path: string, project: Project, env: string) => { ok: true } | { ok: false; error: string };
  /// A provider's token and sign-in URLs, from its address (OpenID Connect discovery).
  /// Runs an environment's token command once, to see it works.
  'auth:tryCommand': (path: string, project: Project, env: string) => { ok: true; preview: string } | { ok: false; error: string };
  'oauth:discover': (issuer: string) => { ok: true; tokenUrl: string; authUrl?: string; scopes?: string[] } | { ok: false; error: string };

  'projects:list': () => ProjectRef[];
  'systems:list': () => SystemRef[];
  'systems:load': (path: string) => { ok: true; system: SystemRef; members: { path: string; project?: Project; error?: string }[] } | { ok: false; error: string };
  'systems:create': (req: { title: string; members: string[]; signedInBy?: string }) => { ok: true; path: string } | { ok: false; error: string };
  'systems:save': (path: string, system: SystemRef) => { ok: boolean; error?: string };
  'systems:remove': (path: string) => void;
  /// `copySignIn`: take the sign-in (auth, headers, browser session) of
  /// another of its environments.
  'systems:editMember': (projectPath: string, edit: { env: string; baseUrl?: string; auth?: AuthSpec; copySignIn?: string }) => { ok: boolean; error?: string };
  'systems:install': (path: string, env: string) => { ok: true; name: string } | { ok: false; error: string };
  'systems:installs': (path: string) => Record<string, { at: string; name: string }>;
  /// Turns a member API's tools on or off, from the workspace.
  'systems:setEnabled': (projectPath: string, toolIds: string[], enabled: boolean) => { ok: boolean; error?: string };
  /// Tells agents where an argument comes from — written into that
  /// parameter's description in its API.
  'systems:hint': (projectPath: string, toolId: string, param: string, text: string) => { ok: boolean; error?: string };
  /// What another API's sign-in would put on this environment's requests.
  'auth:testVia': (path: string, project: Project, env: string) => { ok: true; from: string; sends: string[] } | { ok: false; error: string };
  'projects:create': (req: { title: string; baseUrl?: string }) => Opened;
  'projects:import': (req: { url?: string; text?: string; file?: string }) => Opened;
  'projects:pickImport': () => string | null;
  'projects:open': () => Opened;
  'projects:load': (path: string) => Loaded;
  'projects:save': (path: string, project: Project) => { ok: boolean; error?: string };
  'projects:forget': (path: string) => void;
  'projects:delete': (path: string, opts: { trash: boolean }) => { ok: true; removed: string[] } | { ok: false; error: string };
  /// New title and internal name; installs in Claude Code move to the new name.
  'projects:rename': (path: string, title: string) => { ok: true; name: string; moved: string[]; overgo: boolean } | { ok: false; error: string };
  'projects:reveal': (path: string) => void;
  'projects:export': (path: string) => { ok: boolean; error?: string; to?: string };

  'secrets:status': (path: string, names: string[]) => Record<string, SecretSource>;
  'secrets:set': (path: string, name: string, value: string) => { ok: boolean; error?: string };

  'tool:try': (req: TryRequest) => TryResponse;
  /// Values seen in earlier responses that fit this parameter — from the
  /// requests that give it (chains, across the workspace), else any field
  /// of the same name — and those requests, to run when nothing is seen yet.
  'seen:suggest': (path: string, project: Project, toolId: string, param: string, env: string) => SeenSuggestions;
  /// Runs a request (with its saved values) just to see what it answers.
  'seen:fill': (path: string, toolId: string, env: string) => { ok: true; status: number } | { ok: false; error: string };
  'history:list': (path: string) => HistoryEntry[];
  'history:clear': (path: string) => void;

  'discover:pickFiles': () => string[];
  'discover:run': (req: DiscoverRequest) => Opened;
  'discover:cancel': () => void;
  /// Has the person's claude or codex document the API (core/document.ts); steps arrive as 'doc:step'.
  'ai:document': (project: Project, env: string, samples: boolean) => { ok: true; doc: import('../core/document').DocResult; tool: string } | { ok: false; error: string };
  'ai:cancel': () => void;
  /// Ask this API's tools a question through the person's claude (main/ask.ts); steps arrive as 'ask:event'.
  /// `runId`: chosen by the panel, so it knows its run's events from the first one.
  'agent:ask': (path: string, env: string, question: string, runId: string, history?: { question: string; answer: string }[]) => { ok: true } | { ok: false; error: string };
  /// Stops one question's run (or all, with no id).
  'agent:stop': (runId?: string) => void;

  'overgo:publish': (path: string, project: Project, env: string) => { ok: true; id: string } | { ok: false; error: string };
  'overgo:published': (path: string) => Published | null;

  'runtime:list': (path: string) => RuntimeVar[];
  'auth:status': (path: string, env: string) => { signedIn: boolean; at?: string; tail?: string };
  'auth:signIn': (path: string, project: Project, env: string) => { ok: true; tail: string } | { ok: false; error: string };
  'runtime:set': (path: string, name: string, value: string | null) => RuntimeVar[];

  'mcp:connect': (req: McpConnectRequest) => McpConnectResult;
  'mcp:refresh': () => McpConnectResult;
  'mcp:call': (name: string, args: Record<string, unknown>) => { ok: true; result: McpCallDto } | { ok: false; error: string };
  'mcp:disconnect': () => void;

  /// Adds (or replaces) this API's server in Claude Code's user config by
  /// running `claude mcp add`. overcli reads the same config.
  'install:claude': (path: string, env: string) => { ok: true; name: string } | { ok: false; error: string };
  'installs:get': (path: string) => Installs;

  'recorder:start': (target: string, port: number, projectPath?: string) => { ok: true; port: number; target: string } | { ok: false; error: string };
  'recorder:stop': () => void;
  /// Records a web app in overapi's own browser window. `apiBase`: the API
  /// it talks to, when known (an environment's base URL).
  'recorder:browse': (site: string, projectPath?: string, apiBase?: string, via?: BrowserVia) => { ok: true; site: string } | { ok: false; error: string };
  'recorder:showBrowser': () => void;
  /// Explore the site on its own in the recording window (overapi's own window only).
  /// `safeSearch`: let read-only searches (POST /search, GraphQL queries) through the guard.
  'explore:start': (opts?: { safeSearch?: boolean }) => { ok: true; status: ExploreStatusDto } | { ok: false; error: string };
  'explore:stop': () => void;
  /// Reads the site's browser session into the environment's sign-in: the
  /// secrets go to the keychain; the headers come back for the project.
  'browser:session': (path: string, project: Project, env: string, site: string, via?: BrowserVia) => BrowserSessionResult;
  /// Opens the site to sign in (again), then reads the session once the window closes.
  'browser:signIn': (path: string, project: Project, env: string, site: string, via?: BrowserVia) => BrowserSessionResult;
  /// Finishes a sign-in: closes its window, so the session is read.
  'browser:signInDone': () => void;
  /// Signs an environment in again the way it signs in: its browser session
  /// (opens the browser), its login request, or the API it borrows from.
  /// `renewed` is the API whose sign-in changed.
  'auth:renew': (path: string, env: string) => { ok: true; renewed: string; title: string; note: string } | { ok: false; error: string; manual?: boolean };
  /// What is serving HTTP on this Mac right now (core/localServers.ts).
  'local:scan': () => LocalServer[];
  /// A local service's spec, fetched with a token or cookie it needs.
  'local:importSpec': (req: { port: number; auth: string; title?: string }) => Opened;
  'recorder:state': () => { running: boolean; port?: number; target?: string; calls: RecordedCall[]; projectPath?: string; mode: RecordMode; site?: string; via?: BrowserVia };
  'traffic:addNew': (path: string) => { ok: true; added: number; removed: number } | { ok: false; error: string };
  'recorder:clear': () => void;
  /// Sends a recorded call again; the answer is recorded too. `base`: for calls
  /// through the local address, the API they went to.
  'recorder:replay': (id: string, base?: string) => { ok: true; call: RecordedCall } | { ok: false; error: string };
  'recorder:build': (req: { title?: string; signIn: boolean; target: string }) => Opened;
  'install:claudeRemove': (path: string, env: string) => { ok: true; name: string } | { ok: false; error: string };
  'clipboard:write': (text: string) => void;

  /// A test scenario from what's been recorded for this API.
  'scenario:fromRecording': (path: string, name: string) => { ok: true; scenario: Scenario } | { ok: false; error: string };
  /// Runs it; each step arrives as a 'scenario:step' event too.
  'scenario:run': (path: string, project: Project, scenarioId: string, env: string, allowWrites: boolean, until?: string) => { ok: true; run: ScenarioRun } | { ok: false; error: string };
  /// The last run of each scenario, by id.
  'scenario:runs': (path: string) => Record<string, ScenarioRun>;
  /// A load test; progress arrives as 'load:tick' events. Resolves when done.
  'load:start': (path: string, project: Project, scenarioId: string, env: string, opts: { users: number; durationSec: number; rampSec: number }) => { ok: true; result: LoadSnapshotDto } | { ok: false; error: string };
  'load:stop': () => void;
  'shell:open': (url: string) => void;
  /// Restart into a downloaded update now rather than at the next quit.
  'update:install': () => void;
  /// Looks for an update now, on the chosen channel.
  'update:check': () => { ok: true; available: boolean; version?: string } | { ok: false; error: string };
  /// Downloads the update found (when automatic updates are off).
  'update:download': () => void;
}

export type MainEvent =
  | { type: 'update:available'; version: string; downloading: boolean }
  | { type: 'update:progress'; percent: number }
  | { type: 'update:downloaded'; version: string }
  | { type: 'discover:step'; text: string }
  | { type: 'doc:step'; text: string }
  | { type: 'ask:event'; runId: string; event: import('../main/ask').AskEvent }
  | { type: 'discover:phase'; text: string }
  | { type: 'mcp:toolsChanged' }
  | { type: 'recorder:call'; call: RecordedCall }
  | { type: 'explore:status'; status: ExploreStatusDto }
  | { type: 'scenario:step'; scenarioId: string; result: StepResult }
  | { type: 'load:tick'; scenarioId: string; snapshot: LoadSnapshotDto }
  | { type: 'recorder:status'; running: boolean; port?: number; target?: string; projectPath?: string; mode?: RecordMode; site?: string; via?: BrowserVia };

export type BrowserSessionResult = { ok: true; headers: Record<string, string>; found: string[]; site: string; at: string; via: BrowserVia } | { ok: false; error: string };

// ---- the MCP client ("As an agent") ------------------------------------------

export type McpConnectRequest =
  | { kind: 'self'; path: string; env: string }
  | { kind: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { kind: 'http'; url: string; headers?: Record<string, string> };

/// A tool as the MCP wire carries it — the agent's view, not the project's.
export interface McpToolDto {
  name: string;
  title?: string;
  description?: string;
  inputSchema: { type: string; properties?: Record<string, Record<string, unknown>>; required?: string[] };
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

export interface McpInfoDto {
  name: string;
  version: string;
  instructions?: string;
  tools: McpToolDto[];
  approxTokens: number;
}

export type McpConnectResult = { ok: true; info: McpInfoDto } | { ok: false; error: string };

export interface McpCallDto {
  isError: boolean;
  ms: number;
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structured?: unknown;
}
