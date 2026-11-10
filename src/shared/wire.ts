// Wiring values between requests: which kept value (or which field of an
// earlier response) a parameter should take. `accountId` kept from one
// response feeds `account_id` in another; an `id` from listing accounts
// feeds `account_id` too. Matching is by name, loosely — the person sees
// every suggestion before it's used.

import type { Capture, Project, ToolDef } from './project';
import { shapeOf, type Scenario, type ScenarioStep, type Shape } from './scenario';
import { singular } from './naming';

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/// What a request is about: /accounts/{id} → account.
export function nounOf(tool: ToolDef): string {
  const segs = tool.path.split('/').filter((s) => s && !s.startsWith('{') && !/^(api|rest|v\d+(\.\d+)?)$/i.test(s));
  return singular((segs[segs.length - 1] ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/// Whether a value named `name`, from `producer`'s response, fits `param`.
export function fits(name: string, param: string, producer?: ToolDef): boolean {
  const n = norm(name.replace(/^s\d+_/, ''));
  const p = norm(param);
  if (!n || !p) return false;
  if (n === p) return true;
  // A bare id from /accounts feeds account_id / accountId.
  if (n === 'id' && producer && p === `${norm(nounOf(producer))}id`) return true;
  return false;
}

export interface Feed {
  var: string;
  toolId: string;
  toolName: string;
  param: string;
}

/// Requests this one's kept values could feed, not already wired.
export function feedsFrom(project: Project, tool: ToolDef): Feed[] {
  const out: Feed[] = [];
  for (const c of tool.captures ?? []) {
    for (const t of project.tools) {
      if (t.id === tool.id) continue;
      for (const prm of t.params) {
        if (!fits(c.var, prm.name, tool) && !fits(c.path.split(/[.[\]]/).filter(Boolean).pop() ?? '', prm.name, tool)) continue;
        if (t.example?.[prm.name] === `{{${c.var}}}`) continue;
        out.push({ var: c.var, toolId: t.id, toolName: t.name, param: prm.name });
      }
    }
  }
  return out;
}

/// The parameters of `target` a value could go into, best first: the ones
/// whose names fit, then (if none fit) every parameter.
export function paramsFor(target: ToolDef, name: string, producer?: ToolDef): { param: string; fits: boolean }[] {
  const all = target.params.map((p) => ({ param: p.name, fits: fits(name, p.name, producer) }));
  return [...all.filter((x) => x.fits), ...all.filter((x) => !x.fits)];
}

export function wireInto(tool: ToolDef, param: string, name: string): ToolDef {
  return { ...tool, example: { ...(tool.example ?? {}), [param]: `{{${name}}}` } };
}

/// Every leaf in a shape, as a path and its last key: content[0].id → id.
function leaves(shape: Shape | undefined, at = ''): { path: string; key: string }[] {
  if (!shape) return [];
  if (shape.t === 'object') return Object.entries(shape.keys).flatMap(([k, s]) => (s.t === 'object' || s.t === 'array' ? leaves(s, at ? `${at}.${k}` : k) : [{ path: at ? `${at}.${k}` : k, key: k }]));
  if (shape.t === 'array') return leaves(shape.of, `${at}[0]`);
  return [];
}

/// A request added to a test as its next step. Arguments it would leave
/// empty are taken from earlier steps where a name fits — a value an
/// earlier step already hands on, or a field of an earlier response (which
/// that step then starts handing on).
export function addStep(project: Project, sc: Scenario, tool: ToolDef, opts: { args?: Record<string, unknown>; response?: unknown } = {}): { scenario: Scenario; wired: string[] } {
  const steps: ScenarioStep[] = sc.steps.map((s) => ({ ...s, saves: [...s.saves] }));
  const args: Record<string, unknown> = { ...(opts.args ?? tool.example ?? {}) };
  const wired: string[] = [];
  for (const prm of tool.params) {
    const have = args[prm.name];
    if (have !== undefined && have !== '' && !(typeof have === 'string' && /^\{\{/.test(have) && !/^\{\{s\d+_/.test(have))) continue;
    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i];
      const producer = project.tools.find((t) => t.id === st.toolId);
      const save = st.saves.find((c) => fits(c.var, prm.name, producer) || fits(c.path.split(/[.[\]]/).filter(Boolean).pop() ?? '', prm.name, producer));
      if (save) {
        args[prm.name] = `{{${save.var}}}`;
        wired.push(`${prm.name} ← step ${i + 1}`);
        break;
      }
      const leaf = leaves(st.expect.shape).find((l) => fits(l.key, prm.name, producer));
      if (leaf) {
        const v = `${st.id}_${leaf.key.replace(/[^A-Za-z0-9_]/g, '_')}`;
        if (!st.saves.some((c) => c.var === v)) st.saves.push({ var: v, from: 'body', path: leaf.path } as Capture);
        args[prm.name] = `{{${v}}}`;
        wired.push(`${prm.name} ← step ${i + 1}`);
        break;
      }
    }
  }
  const n = Math.max(0, ...steps.map((s) => Number(s.id.replace(/^s/, '')) || 0)) + 1;
  steps.push({
    id: `s${n}`,
    toolId: tool.id,
    args,
    saves: [],
    expect: { status: '2xx', ...(opts.response !== undefined ? { shape: shapeOf(opts.response) } : {}) },
    enabled: true,
  });
  return { scenario: { ...sc, steps }, wired };
}

export function emptyScenario(name: string, env?: string): Scenario {
  return { id: `sc-${Date.now().toString(36)}`, name, createdAt: new Date().toISOString(), from: 'built by hand', env, steps: [] };
}
