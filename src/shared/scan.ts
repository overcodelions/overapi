// The security scan: what could go wrong when agents get this API, found
// by rules — so the score is the same every time, and every point lost
// says why. Run before publishing (a warning for this Mac, a gate for
// the team's server) and from the command line (`overapi scan`).
//
// It reads the project file only — never secret values (it looks for ones
// that leaked INTO the file) — plus the shapes of real responses kept on
// test steps, for what agents will be handed.

import { envKind, offered, type EnvDef, type Project, type ToolDef } from './project';
import type { Shape } from './scenario';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface Finding {
  /// Stable across runs: what accepting it is keyed by.
  id: string;
  severity: Severity;
  category: 'secrets' | 'reach' | 'injection' | 'data' | 'transport' | 'sign-in';
  title: string;
  detail: string;
  fix: string;
  /// Points it costs the score (before acceptance).
  points: number;
  toolId?: string;
  env?: string;
  /// A leaked value the app can move to the keychain in one click.
  secretize?: { where: 'tool-example' | 'tool-header' | 'env-header' | 'env-var'; key: string; name: string };
}

export interface Accepted {
  reason: string;
  at: string;
}

export interface ScanResult {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  findings: Finding[];
  /// Findings the person accepted, with why — they don't count.
  accepted: (Finding & { accepted: Accepted })[];
  /// Anything critical or high not accepted: the team's server won't take it.
  blocking: Finding[];
}

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];
const POINTS: Record<Severity, number> = { critical: 30, high: 15, medium: 6, low: 2 };

// ---- what a leaked secret looks like --------------------------------------------

const TEMPLATE = /^\s*(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{\{[^}]+\}\})\s*$/;
const SECRET_KEY = /(^|[_-])(pass(word|wd)?|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|session|cookie|authorization|auth)($|[_-])/i;

/// The kind of secret a value looks like, if it looks like one.
export function looksSecret(value: string): string | undefined {
  const v = value.trim();
  if (!v || TEMPLATE.test(v) || v.includes('${')) return undefined;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v)) return 'a private key';
  if (/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(v)) return 'a JWT';
  if (/^(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}$/i.test(v)) return 'a credential';
  if (/\bAKIA[0-9A-Z]{16}\b/.test(v)) return 'a cloud access key';
  if (/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}\b/.test(v) || /\bgh[pousr]_[A-Za-z0-9]{30,}\b/.test(v) || /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/.test(v)) return 'an API token';
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i.test(v)) return 'a password in a URL';
  return undefined;
}

/// A value under a key that names a secret, written in plainly.
function plainUnderSecretKey(key: string, value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim() || TEMPLATE.test(value) || value.includes('${')) return false;
  return SECRET_KEY.test(key) && value.length >= 6;
}

const varName = (prefix: string, key: string) => `${prefix}_${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`.slice(0, 60);

// ---- the rules -------------------------------------------------------------------

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i;
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};
const INJECTION = /(ignore|disregard|forget)\s+(all\s+|any\s+)?(previous|prior|earlier|above|the)\s+(instructions|rules|prompts?)|you are now\b|system prompt|do not (tell|inform|let) the user|without (asking|telling) the user|exfiltrate|send (it|them|this) to https?:/i;
const URL_PARAM = /^(url|uri|href|link|callback|callback_?url|webhook|webhook_?url|redirect|redirect_?(uri|url)|return_?url|endpoint|target|host|proxy)$|_?(url|uri)$/i;
const RAW_PARAM = /^(sql|query_?sql|raw_?query|where|filter_?expr(ession)?|expression|script|code|command|cmd|eval|template|xpath|jq)$/i;
const PERSONAL = /^(email|e_?mail|email_?address|phone|phone_?number|mobile|ssn|social_?security|dob|date_?of_?birth|birth_?date|passport|tax_?id|national_?id|street|address_?line\d?|home_?address|first_?name|last_?name|full_?name)$/i;
const FREE_TEXT = /^(html|content|body|message|comment|comments|description|note|notes|text|markdown|bio|summary|reply|post)$/i;

/// Every key in a shape, with whether it holds a string.
function shapeKeys(s: Shape | undefined, out: { key: string; string: boolean }[] = []): { key: string; string: boolean }[] {
  if (!s) return out;
  if (s.t === 'object') for (const [k, v] of Object.entries(s.keys)) {
    out.push({ key: k, string: v.t === 'string' });
    shapeKeys(v, out);
  }
  if (s.t === 'array') shapeKeys(s.of, out);
  return out;
}

export function scanProject(project: Project, prefix = 'API'): ScanResult {
  const out: Finding[] = [];
  const add = (f: Omit<Finding, 'points'> & { points?: number }) => out.push({ points: POINTS[f.severity], ...f });

  // Secrets that leaked into the file.
  const leak = (where: Finding['secretize'] extends infer W ? W extends { where: infer X } ? X : never : never, label: string, key: string, value: unknown, extra: Partial<Finding>) => {
    if (typeof value !== 'string') return;
    const kind = looksSecret(value) ?? (plainUnderSecretKey(key, value) ? `a value for ${key}` : undefined);
    if (!kind) return;
    add({
      id: `secret:${where}:${extra.toolId ?? extra.env ?? ''}:${key}`,
      severity: 'critical',
      category: 'secrets',
      title: `${label} holds ${kind}`,
      detail: `${key} is written into the project file as a real value. Anyone with the file — a commit, a teammate, the team's server — gets it.`,
      fix: `Move it to the keychain and reference it as \${${varName(prefix, key)}}.`,
      // A variable is a plain {{value}}: it can't hold a secret reference — fix it by hand.
      secretize: where === 'env-var' ? undefined : { where, key, name: varName(prefix, key) },
      ...extra,
    });
  };
  for (const t of project.tools) {
    for (const [k, v] of Object.entries(t.example ?? {})) leak('tool-example', `${t.name}'s saved values`, k, v, { toolId: t.id });
    for (const [k, v] of Object.entries(t.headers ?? {})) leak('tool-header', `${t.name}'s ${k} header`, k, v, { toolId: t.id });
    for (const text of [t.description, t.path]) {
      const kind = looksSecret(text);
      if (kind) add({ id: `secret:text:${t.id}`, severity: 'critical', category: 'secrets', title: `${t.name}'s ${text === t.path ? 'path' : 'description'} holds ${kind}`, detail: 'Agents and anyone with the file can read it.', fix: 'Take it out; use a secret variable if the request needs it.', toolId: t.id });
    }
  }
  for (const e of project.envs) {
    for (const [k, v] of Object.entries(e.headers ?? {})) leak('env-header', `${e.name}'s ${k} header`, k, v, { env: e.name });
    for (const [k, v] of Object.entries(e.vars ?? {})) leak('env-var', `${e.name}'s variable ${k}`, k, v, { env: e.name });
    const kind = looksSecret(e.baseUrl);
    if (kind) add({ id: `secret:url:${e.name}`, severity: 'critical', category: 'secrets', title: `${e.name}'s base URL holds ${kind}`, detail: 'The address is in the file, and in every request shown.', fix: 'Take the credential out of the URL and use the environment’s sign-in.', env: e.name });
  }

  // Instructions to the model, where only descriptions belong.
  for (const [where, text, toolId] of [['the agent brief', project.instructions ?? '', undefined], ...project.tools.filter((t) => t.enabled).map((t) => [`${t.name}'s description`, t.description, t.id] as const)] as [string, string, string | undefined][]) {
    if (INJECTION.test(text)) {
      add({
        id: `injection:text:${toolId ?? 'instructions'}`,
        severity: 'high',
        category: 'injection',
        title: `${where[0].toUpperCase()}${where.slice(1)} reads like an instruction to the model`,
        detail: `“${(INJECTION.exec(text)?.[0] ?? '').slice(0, 80)}” — agents follow text like this. A description should say what the tool does, nothing else.`,
        fix: 'Rewrite it to describe the tool plainly.',
        toolId,
      });
    }
  }

  // Per environment: what agents could reach.
  for (const e of project.envs) {
    const tools = project.tools.filter((t) => offered(t, e));
    const prod = envKind(e.name) === 'production';
    const host = hostOf(e.baseUrl);
    const signedOut = e.auth.type === 'none' && !e.browserSession && !Object.keys(e.headers ?? {}).some((h) => /^(authorization|cookie|x-api-key)$/i.test(h));
    if (e.browserSession) {
      add({ id: `signin:browser:${e.name}`, severity: 'high', category: 'sign-in', title: `${e.name} signs in as you`, detail: 'It uses your own browser session. Fine on this Mac; published, everyone using it would act as you.', fix: 'Use an API token or a sign-in request for any environment you publish.', env: e.name });
    }
    if (e.baseUrl.startsWith('http://') && host && !LOCAL.test(host)) {
      const sends = !signedOut;
      add({ id: `transport:http:${e.name}`, severity: sends ? 'high' : 'medium', category: 'transport', title: `${e.name} uses plain http`, detail: `Requests to ${host} aren't encrypted${sends ? ' — including the sign-in sent with them' : ''}.`, fix: 'Use https.', env: e.name });
    }
    if (prod && e.allowWrites) {
      const writes = tools.filter((t) => t.safety !== 'read').length;
      if (writes) add({ id: `reach:prod-writes:${e.name}`, severity: 'high', category: 'reach', title: `Agents can change data on ${e.name}`, detail: `${writes} tool${writes === 1 ? '' : 's'} that change data are offered on production.`, fix: 'Turn on “Read-only for agents” for production, or accept it with a reason.', env: e.name });
    }
    const destructive = tools.filter((t) => t.safety === 'destructive');
    if (destructive.length) {
      add({ id: `reach:destructive:${e.name}`, severity: 'medium', category: 'reach', title: `${destructive.length} destructive tool${destructive.length === 1 ? '' : 's'} offered on ${e.name}`, detail: `${destructive.slice(0, 4).map((t) => t.name).join(', ')}${destructive.length > 4 ? '…' : ''}. Agents must pass confirm: true, but can.`, fix: 'Turn off the ones agents don’t need.', env: e.name, points: Math.min(15, POINTS.medium + 2 * (destructive.length - 1)) });
    }
    if (signedOut && tools.some((t) => t.safety !== 'read') && !LOCAL.test(host)) {
      add({ id: `signin:none-writes:${e.name}`, severity: 'medium', category: 'sign-in', title: `${e.name} changes data with no sign-in`, detail: 'Write tools are offered, and requests carry no credential — either the API is open, or the sign-in is missing.', fix: 'Set up the environment’s sign-in.', env: e.name });
    }
  }

  // Arguments that let an agent reach further than the API's own data.
  for (const t of project.tools.filter((x) => x.enabled)) {
    for (const p of t.params) {
      if (URL_PARAM.test(p.name)) add({ id: `reach:url-param:${t.id}:${p.name}`, severity: 'medium', category: 'reach', title: `${t.name} takes an address (${p.name})`, detail: 'An agent — or text it read — can point the API at any address, including internal ones.', fix: 'Limit it to known values (an enum), or turn the tool off.', toolId: t.id });
      else if (RAW_PARAM.test(p.name)) add({ id: `reach:raw-param:${t.id}:${p.name}`, severity: 'medium', category: 'reach', title: `${t.name} takes a raw ${p.name}`, detail: 'Raw queries, scripts or expressions let an agent do far more than the tool’s name suggests.', fix: 'Replace it with specific arguments, or turn the tool off.', toolId: t.id });
    }
    if (t.bodyMode === 'json-whole' && t.safety !== 'read') add({ id: `reach:raw-body:${t.id}`, severity: 'low', category: 'reach', title: `${t.name} passes any JSON body through`, detail: 'The agent writes the whole body, unchecked.', fix: 'Switch it to JSON fields, one argument each.', toolId: t.id });
  }

  // What agents are handed: personal data, and text other people wrote.
  const shapes = new Map<string, Shape>();
  for (const sc of project.scenarios ?? []) for (const st of sc.steps) if (st.expect.shape && !shapes.has(st.toolId)) shapes.set(st.toolId, st.expect.shape);
  let personalCost = 0;
  for (const t of project.tools.filter((x) => x.enabled)) {
    const keys = shapeKeys(shapes.get(t.id));
    const personal = [...new Set(keys.filter((k) => PERSONAL.test(k.key)).map((k) => k.key))];
    if (personal.length) {
      const pts = Math.min(POINTS.medium, Math.max(0, 15 - personalCost));
      personalCost += pts;
      add({ id: `data:personal:${t.id}`, severity: 'medium', category: 'data', title: `${t.name} returns personal data`, detail: `Its responses include ${personal.slice(0, 5).join(', ')}. Agents read it, and may repeat it.`, fix: 'Keep only the fields agents need (response fields), or accept it with a reason.', toolId: t.id, points: pts });
    }
    const free = [...new Set(keys.filter((k) => k.string && FREE_TEXT.test(k.key)).map((k) => k.key))];
    if (free.length) add({ id: `injection:content:${t.id}`, severity: 'low', category: 'injection', title: `${t.name} hands agents text others wrote`, detail: `${free.slice(0, 4).join(', ')} can hold anything — including text written to steer an agent.`, fix: 'Leave those fields out if agents don’t need them; otherwise accept it.', toolId: t.id });
  }

  return finish(out, project.review?.accepted ?? {});
}

function finish(all: Finding[], accepted: Record<string, Accepted>): ScanResult {
  const sorted = all.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  const open = sorted.filter((f) => !accepted[f.id]);
  const score = Math.max(0, 100 - open.reduce((n, f) => n + f.points, 0));
  return {
    score,
    grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F',
    findings: open,
    accepted: sorted.filter((f) => accepted[f.id]).map((f) => ({ ...f, accepted: accepted[f.id] })),
    blocking: open.filter((f) => f.severity === 'critical' || f.severity === 'high'),
  };
}

/// Only what matters for one environment (publishing one), plus project-wide findings.
export function forEnv(r: ScanResult, env: EnvDef): ScanResult {
  const keep = (f: Finding) => !f.env || f.env === env.name;
  const findings = r.findings.filter(keep);
  return { ...r, findings, accepted: r.accepted.filter(keep), blocking: findings.filter((f) => f.severity === 'critical' || f.severity === 'high') };
}
