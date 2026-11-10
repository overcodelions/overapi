// Documenting an API with AI: the person's own claude or codex reads each
// tool — what it asks for, what it returns, which other tools feed it —
// and writes what an agent needs: what each tool is for, what each
// argument means, clearer names where they're cryptic, which tools are
// noise, and a short brief for the agent on connect.
//
// It sees names, paths, shapes and (if allowed) a few example values —
// never a secret: anything that looks like one is left out. Its answer is
// one JSON object, checked here against the project before anything is
// offered to the person.

import type { Project, EnvDef } from '../shared/project';
import type { Shape } from '../shared/scenario';
import { findLinks, readablePath } from '../shared/chains';
import { looksSecret } from '../shared/scan';
import { VALID_NAME } from '../shared/naming';

export interface DocTool {
  name?: string;
  description?: string;
  params?: Record<string, string>;
  /// Why it should be hidden from agents, if it should.
  hide?: string;
}

export interface DocResult {
  brief?: string;
  /// Real questions a person would ask that this API can answer.
  questions?: string[];
  tools: Record<string, DocTool>;
}

/// A shape as a compact outline: { pagination{_limit}, data[]{id, name, …} }.
function outline(s: Shape | undefined, depth = 0, budget = { n: 60 }): string {
  if (!s || budget.n <= 0) return '…';
  if (s.t === 'array') return `${outline(s.of, depth, budget)}[]`;
  if (s.t !== 'object') return s.t;
  if (depth >= 3) return '{…}';
  const keys = Object.entries(s.keys);
  const parts: string[] = [];
  for (const [k, v] of keys) {
    if (budget.n-- <= 0) {
      parts.push('…');
      break;
    }
    parts.push(v.t === 'object' || v.t === 'array' ? `${k}:${outline(v, depth + 1, budget)}` : k);
  }
  return `{${parts.join(', ')}}`;
}

export function documentPrompt(project: Project, env: EnvDef | undefined, opts: { samples: boolean }): string {
  const links = findLinks(project);
  const safe = (v: unknown) => (typeof v === 'string' && (looksSecret(v) || v.length > 80) ? undefined : v);
  const tools = project.tools.map((t) => ({
    id: t.id,
    name: t.name,
    request: `${t.method} ${t.path}`,
    current_description: t.description,
    arguments: t.params.map((p) => ({ name: p.name, in: p.in, type: p.schema.type ?? 'any', required: p.required, ...(p.description ? { note: p.description } : {}), ...(opts.samples && t.example?.[p.name] !== undefined && safe(t.example[p.name]) !== undefined ? { example: t.example[p.name] } : {}) })),
    returns: t.returns ? outline(t.returns) : 'unknown',
    gets_values_from: links.filter((l) => l.to === t.id).map((l) => `${l.param} ← ${l.fromName} (${readablePath(l.path)})`),
    gives_values_to: links.filter((l) => l.from === t.id).map((l) => `${l.toName}.${l.param}`),
    changes_data: t.safety !== 'read',
  }));
  const fixed = Object.entries(env?.vars ?? {}).map(([k, v]) => `${k} = ${opts.samples ? v : '(set)'}`);
  return `You are documenting an HTTP API so that AI agents can use it well as MCP tools. Agents choose and call tools only from the names and descriptions you write, so they must say plainly what each tool is for and how to get its arguments.

API: ${project.title}${env?.baseUrl ? ` (${new URL(env.baseUrl).host})` : ''}
${fixed.length ? `Values fixed for this environment (agents never pass these): ${fixed.join(', ')}\n` : ''}${project.description ? `Notes: ${project.description}\n` : ''}
Tools (JSON):
${JSON.stringify(tools, null, 1)}

Write, for every tool:
- "description": 1–3 sentences, under 300 characters. Start with what it returns or does, in the API's own domain words (e.g. "The league table for a season…"), then when to use it. If an argument comes from another tool, say which (use gets_values_from). No mention of HTTP, paths or how it was found.
- "params": a short note for each argument that needs one — what it is, its format, and where to get it (e.g. "season_id": "The year the season starts, e.g. 2025 for 2025/26.").
- "name": only if the current name is cryptic or misleading. snake_case, verb_noun, under 40 characters, unique, using the API's domain words (e.g. get_player_profile). Otherwise leave it out.
- "hide": only for tools an agent should not see — exact duplicates of another tool, or internal plumbing (metadata, tracking, config). A one-line reason. Otherwise leave it out.

Also write "brief": up to 6 short lines an agent reads when it connects — what this API covers, the usual order of calls (which tool gives the ids others need), and any conventions (id formats, how seasons or dates work).

Also write "questions": 4 short questions a real person would ask that these tools can answer, each needing one to three tool calls, in the API's own words (e.g. "Who's top of the league, and when do they play next?"). Don't name tools in them.

Answer with ONE JSON object and nothing else:
{"brief": "…", "questions": ["…"], "tools": {"<tool id>": {"description": "…", "params": {"<arg>": "…"}, "name": "…", "hide": "…"}}}
Use the tool ids exactly as given. Don't invent tools or arguments.`;
}

/// The model's answer, checked: known tools and arguments only, valid and
/// unique names, sane lengths.
export function parseDocReply(text: string, project: Project): DocResult {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('The AI answered without the JSON overapi asked for. Try again.');
  let data: { brief?: unknown; tools?: Record<string, DocTool> };
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(`The AI's answer wasn't valid JSON (${(e as Error).message}). Try again.`);
  }
  const out: DocResult = { tools: {} };
  if (typeof data.brief === 'string' && data.brief.trim()) out.brief = data.brief.trim().slice(0, 1500);
  const qs = (data as { questions?: unknown }).questions;
  if (Array.isArray(qs)) {
    const list = qs.filter((x): x is string => typeof x === 'string' && x.trim().length > 5).map((x) => x.trim().slice(0, 160)).slice(0, 6);
    if (list.length) out.questions = list;
  }
  const taken = new Set(project.tools.map((t) => t.name));
  for (const [id, d] of Object.entries(data.tools ?? {})) {
    const tool = project.tools.find((t) => t.id === id);
    if (!tool || !d || typeof d !== 'object') continue;
    const doc: DocTool = {};
    if (typeof d.description === 'string' && d.description.trim()) doc.description = d.description.trim().slice(0, 600);
    if (typeof d.name === 'string' && d.name !== tool.name && VALID_NAME.test(d.name) && d.name.length <= 48 && !taken.has(d.name)) {
      doc.name = d.name;
      taken.add(d.name);
    }
    if (d.params && typeof d.params === 'object') {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.params)) if (typeof v === 'string' && v.trim() && tool.params.some((p) => p.name === k)) params[k] = v.trim().slice(0, 300);
      if (Object.keys(params).length) doc.params = params;
    }
    if (typeof d.hide === 'string' && d.hide.trim()) doc.hide = d.hide.trim().slice(0, 200);
    if (Object.keys(doc).length) out.tools[id] = doc;
  }
  if (!out.brief && !out.questions && !Object.keys(out.tools).length) throw new Error('The AI’s answer had nothing overapi could use. Try again.');
  return out;
}
