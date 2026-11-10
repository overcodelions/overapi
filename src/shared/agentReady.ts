// "Make it agent-ready": everything that makes an API good for agents, as
// one list of changes the person reviews — tidy the recording, fix the
// values that never change, connect the chains (all by rules), then the
// AI's documentation: descriptions, argument help, clearer names, noise to
// hide, a brief. Each change says before → after; nothing is applied until
// accepted.

import type { EnvDef, Project } from './project';
import { applyLinks, applyShared, applyTidy, findLinks, readablePath, sharedValues, tidyUps } from './chains';
import type { DocResult } from '../core/document';

export type ChangeGroup = 'Tidy up' | 'Same every time' | 'Chains' | 'Descriptions' | 'Arguments' | 'Names' | 'Hide from agents' | 'Agent brief' | 'Example questions';

export interface Change {
  id: string;
  group: ChangeGroup;
  title: string;
  before?: string;
  after?: string;
  apply: (p: Project) => Project;
}

/// The rule-based part, worked out on the project as it is.
export function rulePlan(project: Project, env: EnvDef | undefined): Change[] {
  const out: Change[] = [];
  for (const t of tidyUps(project)) out.push({ id: t.id, group: 'Tidy up', title: t.title, after: t.remove === 'tool' ? 'Removed' : `Argument ${t.remove.param} removed`, apply: (p) => applyTidy(p, t) });
  if (env)
    for (const s of sharedValues(project, env))
      out.push({ id: `shared:${s.name}`, group: 'Same every time', title: `${s.name} is always ${s.value}`, before: `asked of agents in ${s.tools.length} tools`, after: `fixed at ${s.value} for ${env.name}`, apply: (p) => applyShared(p, env.name, s) });
  for (const l of findLinks(project).filter((x) => !x.done))
    out.push({ id: `chain:${l.to}:${l.param}`, group: 'Chains', title: `${l.toName} gets ${l.param} from ${l.fromName}`, after: `${l.fromName} → ${readablePath(l.path)} → ${l.toName}.${l.param}`, apply: (p) => applyLinks(p, [l]) });
  return out;
}

/// The AI's part, from its checked answer.
export function aiPlan(project: Project, doc: DocResult): Change[] {
  const out: Change[] = [];
  for (const [id, d] of Object.entries(doc.tools)) {
    const t = project.tools.find((x) => x.id === id);
    if (!t) continue;
    if (d.description && d.description !== t.description)
      out.push({ id: `desc:${id}`, group: 'Descriptions', title: t.name, before: t.description, after: d.description, apply: (p) => ({ ...p, tools: p.tools.map((x) => (x.id === id ? { ...x, description: d.description! } : x)) }) });
    for (const [param, text] of Object.entries(d.params ?? {})) {
      const prm = t.params.find((x) => x.name === param);
      if (!prm || prm.description === text) continue;
      out.push({
        id: `param:${id}:${param}`,
        group: 'Arguments',
        title: `${t.name} · ${param}`,
        before: prm.description,
        after: text,
        apply: (p) => ({ ...p, tools: p.tools.map((x) => (x.id === id ? { ...x, params: x.params.map((y) => (y.name === param ? { ...y, description: text } : y)) } : x)) }),
      });
    }
    if (d.name) out.push({ id: `name:${id}`, group: 'Names', title: `${t.name} → ${d.name}`, before: t.name, after: d.name, apply: (p) => (p.tools.some((x) => x.name === d.name && x.id !== id) ? p : { ...p, tools: p.tools.map((x) => (x.id === id ? { ...x, name: d.name! } : x)) }) });
    if (d.hide && t.enabled) out.push({ id: `hide:${id}`, group: 'Hide from agents', title: t.name, after: d.hide, apply: (p) => ({ ...p, tools: p.tools.map((x) => (x.id === id ? { ...x, enabled: false } : x)) }) });
  }
  if (doc.questions?.length)
    out.push({ id: 'questions', group: 'Example questions', title: 'What people can ask it — the starters in Try as an agent', before: project.examples?.join(' · '), after: doc.questions.map((q) => `• ${q}`).join('\n'), apply: (p) => ({ ...p, examples: doc.questions }) });
  if (doc.brief && doc.brief !== project.instructions) out.push({ id: 'brief', group: 'Agent brief', title: 'What an agent reads when it connects', before: project.instructions, after: doc.brief, apply: (p) => ({ ...p, instructions: doc.brief }) });
  return out;
}

export function applyChanges(project: Project, changes: Change[]): Project {
  return changes.reduce((p, c) => c.apply(p), project);
}
