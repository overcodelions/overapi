// Curating the tool list: with more tools on than an agent handles well
// (TOOL_BUDGET), which to turn off first — each with the reason, so the
// person decides. Rules, not guesses: internal plumbing, near-duplicates,
// tools nothing leads to and nothing uses, and tools the environment hides
// anyway.

import { TOOL_BUDGET } from './check';
import { findLinks } from './chains';
import { offered, type EnvDef, type Project, type ToolDef } from './project';

export interface Suggestion {
  toolId: string;
  name: string;
  reason: string;
  /// Higher: turn off sooner.
  score: number;
}

const INTERNAL = /(^|\/)(metadata|config|configuration|settings|features?|flags?|tracking|telemetry|analytics|messenger|zendesk|intercom|ckeditor|health|ping|status|version|i18n|translations?|sockjs-node|assets)(\/|$)/i;

/// A description that says how a tool was found, not what it's for.
export const isWeak = (t: ToolDef) => !t.description?.trim() || /seen \d+ times? in the capture|inferred from \d+ captured/i.test(t.description) || t.description.trim().length < 12;

/// Roughly what one tool costs in the list an agent gets every turn.
export const toolTokens = (t: ToolDef) => Math.round(JSON.stringify({ n: t.name, d: t.description, p: t.params.map((x) => [x.name, x.schema, x.description]) }).length / 4);

export function suggestOff(project: Project, env: EnvDef | undefined, budget = TOOL_BUDGET): Suggestion[] {
  const on = project.tools.filter((t) => t.enabled);
  const over = on.length - budget;
  if (over <= 0) return [];
  const links = findLinks(project);
  const used = new Set((project.scenarios ?? []).flatMap((s) => s.steps.map((x) => x.toolId)));
  const out: Suggestion[] = [];
  for (const t of on) {
    let score = 0;
    const why: string[] = [];
    if (env && !offered(t, env)) {
      score += 6;
      why.push(`hidden on ${env.name} anyway (changes data, read-only)`);
    }
    if (INTERNAL.test(t.path)) {
      score += 5;
      why.push('internal plumbing, not something people ask for');
    }
    // Of a pair, the copy goes: the numbered name, or the longer path.
    const twin = on.find((u) => u !== t && u.method === t.method && ((/_\d+$/.test(t.name) && u.name === t.name.replace(/_\d+$/, '')) || (u.path !== t.path && t.path.endsWith(u.path) && !/_\d+$/.test(u.name) && u.name !== `${t.name}_2`)));
    if (twin) {
      score += 4;
      why.push(`a near-duplicate of ${twin.name}`);
    }
    const chained = links.some((l) => l.from === t.id || l.to === t.id);
    if (!chained && !used.has(t.id)) {
      score += 1;
      why.push('nothing leads to it and no test uses it');
    }
    if (t.method !== 'GET' && !used.has(t.id)) {
      score += 1;
      why.push('changes data');
    }
    if (score > 0) out.push({ toolId: t.id, name: t.name, reason: why[0], score });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, over);
}
