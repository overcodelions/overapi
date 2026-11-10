import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { Icon } from './icons';
import { BodyView } from './JsonView';
import { Markdown } from './Markdown';
import { addStep, emptyScenario } from '@shared/wire';
import type { AskEvent } from '../main/ask';

interface Step {
  id: string;
  name: string;
  input: unknown;
  result?: { text: string; isError: boolean };
}

interface Turn {
  question: string;
  steps: Step[];
  note?: string;
  done?: Extract<AskEvent, { kind: 'done' }>;
  error?: string;
  startedAt: number;
}

/// Ask a question in plain words; watch the person's own claude answer it
/// with this API's tools — read-only — as a conversation: the question, the
/// tools it used, the answer, formatted.
export function AskPanel({ env }: { env: string }): JSX.Element {
  const { project, path, selectTool, setTab, say, update } = useStore();
  const p = project!;
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const running = turns.length > 0 && !turns[turns.length - 1].done && !turns[turns.length - 1].error;
  const [now, setNow] = useState(Date.now());
  const end = useRef<HTMLDivElement>(null);

  const patchLast = (fn: (t: Turn) => Turn) => setTurns((ts) => (ts.length ? [...ts.slice(0, -1), fn(ts[ts.length - 1])] : ts));
  useEffect(
    () =>
      window.overapi.onEvent((e) => {
        if (e.type !== 'ask:event') return;
        const ev = e.event;
        if (ev.kind === 'tool') patchLast((t) => ({ ...t, steps: [...t.steps, { id: ev.id, name: ev.name, input: ev.input }] }));
        else if (ev.kind === 'result') patchLast((t) => ({ ...t, steps: t.steps.map((x) => (x.id === ev.id ? { ...x, result: { text: ev.text, isError: ev.isError } } : x)) }));
        else if (ev.kind === 'text') patchLast((t) => ({ ...t, note: ev.text }));
        else if (ev.kind === 'done') patchLast((t) => ({ ...t, done: ev }));
        else if (ev.kind === 'error') patchLast((t) => ({ ...t, error: ev.text }));
      }),
    [],
  );
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), [turns]);

  const examples = useMemo(() => {
    // Questions written for this API by Make it agent-ready, if it has them.
    if (p.examples?.length) return p.examples.slice(0, 4);
    const lists = p.tools.filter((t) => t.enabled && t.safety === 'read' && t.method === 'GET' && !/\{[^}]+\}$/.test(t.path));
    const words = (t: (typeof lists)[number]) => t.name.replace(/^(list|get)_/, '').replace(/_/g, ' ');
    const out = lists.slice(0, 2).map((t) => `What ${words(t)} are there right now?`);
    const pair = p.tools.find((t) => t.enabled && /\{[^}]+\}/.test(t.path) && t.method === 'GET');
    if (pair) out.push(`Pick one and show me its ${pair.name.replace(/^(list|get)_/, '').replace(/_/g, ' ')}.`);
    return out;
  }, [p.tools, p.examples]);

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || running) return;
    setQuestion('');
    setTurns((ts) => [...ts, { question: text, steps: [], startedAt: Date.now() }]);
    const r = await window.overapi.invoke('agent:ask', path!, env, text);
    if (!r.ok) patchLast((t) => ({ ...t, error: r.error }));
  };
  const openTool = (name: string) => {
    const t = p.tools.find((x) => x.name === name);
    if (!t) return say(`${name} isn’t a request in ${p.title}.`, true);
    selectTool(t.id);
    setTab('requests');
  };
  // The calls claude made, in order, as a test that can be run again.
  const saveAsTest = (turn: Turn) => {
    let sc = emptyScenario(turn.question.slice(0, 60), env);
    for (const s of turn.steps) {
      const t = p.tools.find((x) => x.name === s.name);
      if (!t || s.result?.isError) continue;
      let response: unknown;
      try {
        const body = s.result?.text.replace(/^HTTP \d{3}[^\n]*\n+/, '');
        response = body ? JSON.parse(body) : undefined;
      } catch {
        response = undefined;
      }
      sc = addStep(p, sc, t, { args: (s.input ?? {}) as Record<string, unknown>, response }).scenario;
    }
    if (!sc.steps.length) return say('None of those calls can be saved as a test.', true);
    update((x) => ({ ...x, scenarios: [...(x.scenarios ?? []), sc] }));
    say(`Saved ${sc.steps.length} step${sc.steps.length === 1 ? '' : 's'} as the test “${sc.name}”.`);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-6 py-6">
          {turns.length === 0 && (
            <div className="space-y-4 pt-10 text-center">
              <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/15 text-accent">
                <Icon name="sparkle" size={20} />
              </div>
              <div>
                <h2 className="display text-[20px] font-semibold">Ask {p.title} anything</h2>
                <p className="mx-auto mt-1 max-w-lg text-[13px] leading-relaxed text-ink-muted">
                  Your claude answers with {p.title}’s tools on <b className="text-ink">{env}</b> — exactly what Claude Code would get, read-only. You see every call it makes; if it
                  picks the wrong tool or can’t find an id, that’s what to fix.
                </p>
              </div>
              {examples.length > 0 && (
                <div className="flex flex-wrap justify-center gap-2">
                  {examples.map((q) => (
                    <button key={q} className="rounded-full border border-rule px-3.5 py-1.5 text-[12.5px] text-ink-muted hover:border-accent/50 hover:text-ink" onClick={() => void ask(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {turns.map((turn, ti) => {
            const live = ti === turns.length - 1 && running;
            const failed = turn.steps.filter((s) => s.result?.isError).length;
            const tok = turn.steps.reduce((n, s) => n + Math.round((s.result?.text.length ?? 0) / 4), 0);
            return (
              <section key={ti} className="space-y-3">
                <div className="flex justify-end">
                  <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent px-4 py-2 text-[13.5px] text-white">{turn.question}</div>
                </div>

                {(turn.steps.length > 0 || live) && (
                  <details className="group rounded-xl border border-rule bg-surface" open={live || failed > 0}>
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2 text-[12px] text-ink-muted">
                      <Icon name="chevron" size={11} className="text-ink-faint transition-transform group-open:rotate-90" />
                      <Icon name="plug" size={13} className="text-accent" />
                      <span>
                        {live && !turn.steps.length ? 'Choosing tools…' : `Used ${turn.steps.length} tool${turn.steps.length === 1 ? '' : 's'}`}
                        {failed ? <span className="text-bad"> · {failed} failed</span> : null}
                      </span>
                      <span className="flex-1" />
                      {tok > 0 && <span className="text-[11px] tabular-nums text-ink-faint">{tok.toLocaleString()} tok read</span>}
                    </summary>
                    <ol className="relative ml-[22px] border-l border-rule pb-2 pl-4">
                      {turn.steps.map((s) => (
                        <li key={s.id} className="relative py-1.5">
                          <span className={`absolute -left-[21px] top-[11px] h-2.5 w-2.5 rounded-full ring-4 ring-surface ${!s.result ? 'animate-pulse bg-accent' : s.result.isError ? 'bg-bad' : 'bg-good'}`} />
                          <details>
                            <summary className="flex cursor-pointer list-none items-center gap-2 text-[12.5px]">
                              <button
                                className="font-mono font-medium hover:underline"
                                title="Open this request"
                                onClick={(e) => {
                                  e.preventDefault();
                                  openTool(s.name);
                                }}
                              >
                                {s.name}
                              </button>
                              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">{argsText(s.input)}</span>
                              {s.result && <span className="text-[10.5px] tabular-nums text-ink-faint">{Math.round(s.result.text.length / 4).toLocaleString()} tok</span>}
                            </summary>
                            {s.result && (
                              <div className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-rule bg-wash p-2">
                                <BodyView text={s.result.text} />
                              </div>
                            )}
                          </details>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}

                {live && (
                  <p className="flex items-center gap-2 pl-1 text-[12px] text-ink-faint">
                    <span className="flex gap-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.2s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.1s]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" />
                    </span>
                    {turn.note ? <span className="truncate italic">{turn.note}</span> : 'Thinking'} · {Math.round((now - turn.startedAt) / 1000)}s
                  </p>
                )}

                {turn.done && (
                  <div className="flex gap-3">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
                      <Icon name="sparkle" size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="selectable rounded-2xl rounded-tl-md border border-rule bg-surface px-4 py-3 shadow-sm">
                        {turn.done.answer ? <Markdown text={turn.done.answer} /> : <p className="text-ink-faint">(no answer)</p>}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 pl-1 text-[11px] text-ink-faint">
                        <span className="rounded-full bg-wash-strong px-2 py-0.5">
                          {turn.steps.length} tool call{turn.steps.length === 1 ? '' : 's'}
                        </span>
                        <span className="rounded-full bg-wash-strong px-2 py-0.5">{(turn.done.ms / 1000).toFixed(1)}s</span>
                        {turn.done.tokens ? <span className="rounded-full bg-wash-strong px-2 py-0.5">{turn.done.tokens.toLocaleString()} tokens</span> : null}
                        <span className="flex-1" />
                        <button
                          className="rounded-md px-2 py-1 hover:bg-wash hover:text-ink"
                          onClick={async () => {
                            await window.overapi.invoke('clipboard:write', turn.done!.answer);
                            say('Copied the answer.');
                          }}
                        >
                          <span className="inline-flex items-center gap-1">
                            <Icon name="copy" size={11} /> Copy
                          </span>
                        </button>
                        <button className="rounded-md px-2 py-1 hover:bg-wash hover:text-ink" disabled={running} onClick={() => void ask(turn.question)}>
                          <span className="inline-flex items-center gap-1">
                            <Icon name="history" size={11} /> Ask again
                          </span>
                        </button>
                        {turn.steps.length > 0 && (
                          <button className="rounded-md px-2 py-1 hover:bg-wash hover:text-ink" onClick={() => saveAsTest(turn)} title="The calls it made, in order, as a test you can run again">
                            <span className="inline-flex items-center gap-1">
                              <Icon name="check" size={11} /> Save as a test
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                {turn.error && <p className="rounded-lg bg-bad/10 px-3 py-2 text-[12px] text-bad">{turn.error}</p>}
              </section>
            );
          })}
          <div ref={end} />
        </div>
      </div>

      <form
        className="border-t border-rule px-6 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <div className="mx-auto flex max-w-3xl items-center gap-2 rounded-2xl border border-rule-strong bg-surface px-3 py-1.5 focus-within:border-accent/60">
          <Icon name="sparkle" size={15} className="shrink-0 text-accent" />
          <input
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[14px] outline-none placeholder:text-ink-faint focus-visible:outline-none"
            placeholder={turns.length ? 'Ask a follow-up — each question starts fresh' : `Ask ${p.title} something…`}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={running}
            aria-label="Your question"
            autoFocus
          />
          {running ? (
            <button type="button" className="btn" onClick={() => void window.overapi.invoke('agent:stop')}>
              Stop
            </button>
          ) : (
            <button className="btn-primary rounded-xl" disabled={!question.trim()}>
              Ask
            </button>
          )}
        </div>
        <p className="mx-auto mt-1.5 max-w-3xl text-center text-[10.5px] text-ink-faint">Read-only · runs through your claude · uses your Claude usage</p>
      </form>
    </div>
  );
}

/// Arguments as a short line: season_id: 2026 · _sort: kickoff:desc.
function argsText(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}
