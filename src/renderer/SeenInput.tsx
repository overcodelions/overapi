import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { Icon } from './icons';
import type { SeenSuggestions } from '@shared/ipc';
import { insertVar, matching, varAt } from './varComplete';

const SECRET_FROM: Record<string, string> = { keychain: 'in the keychain', env: 'from your shell', dotenv: 'from .env' };

/// A parameter's box that offers what earlier responses held: the partners
/// a list answered with, by name — from the request that gives this value
/// (a chain, across the workspace), or any field of the same name. Nothing
/// seen yet: offers to run that request.
/// `secret`: a password or key — hidden unless shown, never offered from responses.
export function SeenInput({
  toolId,
  param,
  value,
  onValue,
  placeholder,
  autoFocus,
  secret,
}: {
  toolId: string;
  param: string;
  value: string;
  onValue: (v: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  secret?: boolean;
}): JSX.Element {
  const { path, project, env, say, runtime, secrets } = useStore();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SeenSuggestions | null>(null);
  const [active, setActive] = useState(0);
  const [filling, setFilling] = useState<string | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const box = useRef<HTMLInputElement>(null);
  const [reveal, setReveal] = useState(false);
  // A reference (${SECRET}, {{kept}}) isn't the secret itself: no need to hide it.
  const masked = !!secret && !reveal && !!value && !/^\s*(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{\{[^}]+\}\})\s*$/.test(value);
  const [caret, setCaret] = useState<number | null>(null);
  // Typing {{ or ${: the variables there are, instead of earlier values.
  const at = varAt(value, caret);
  const envVars = project?.envs.find((e) => e.name === env)?.vars ?? {};
  const vars = !at
    ? []
    : matching(
        at.kind === 'var'
          ? [
              ...runtime.map((r) => ({ name: r.name, hint: r.from ? `kept from ${r.from}` : 'kept', preview: r.value })),
              ...Object.entries(envVars).map(([name, v]) => ({ name, hint: `${env} variable`, preview: v })),
            ]
          : Object.entries(secrets).map(([name, src]) => ({ name, hint: src ? `secret, ${SECRET_FROM[src] ?? src}` : 'secret, not set yet', preview: '' })),
        at.partial,
      ).slice(0, 30);
  const pickVar = (name: string) => {
    if (!at || caret === null) return;
    const r = insertVar(value, at, caret, name);
    onValue(r.value);
    setCaret(r.caret);
    requestAnimationFrame(() => box.current?.setSelectionRange(r.caret, r.caret));
  };

  const load = async () => {
    if (!path || !project || !env) return;
    setData(await window.overapi.invoke('seen:suggest', path, project, toolId, param, env));
  };
  useEffect(() => setData(null), [toolId, env]);

  const q = value.trim().toLowerCase();
  const exact = data?.values.some((x) => String(x.v) === value);
  const list = (data?.values ?? []).filter((x) => !q || exact || String(x.v).toLowerCase().includes(q) || x.label?.toLowerCase().includes(q));
  const show = open && !!data && (list.length > 0 || data.sources.length > 0);

  const pick = (v: string | number) => {
    onValue(String(v));
    setOpen(false);
  };
  const fill = async (s: SeenSuggestions['sources'][number]) => {
    setFilling(s.toolId);
    const r = await window.overapi.invoke('seen:fill', s.path, s.toolId, env!);
    setFilling(null);
    if (!r.ok) return say(r.error, true);
    await load();
    setOpen(true);
  };

  return (
    <div className="relative">
      <input
        ref={box}
        autoFocus={autoFocus}
        className={`field py-1 font-mono text-[12px] ${secret ? 'pr-8' : ''}`}
        type={masked ? 'password' : 'text'}
        spellCheck={secret ? false : undefined}
        autoComplete={secret ? 'off' : undefined}
        value={value}
        placeholder={placeholder}
        onSelect={(e) => setCaret((e.target as HTMLInputElement).selectionStart)}
        onChange={(e) => {
          onValue(e.target.value);
          setCaret(e.target.selectionStart);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => {
          clearTimeout(closeTimer.current);
          setOpen(true);
          setActive(0);
          if (!secret) void load();
        }}
        onBlur={() => (closeTimer.current = setTimeout(() => setOpen(false), 150))}
        onKeyDown={(e) => {
          if (open && at && vars.length) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, vars.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if ((e.key === 'Enter' && !e.metaKey) || e.key === 'Tab') {
              e.preventDefault();
              pickVar(vars[Math.min(active, vars.length - 1)].name);
            } else if (e.key === 'Escape') setOpen(false);
            return;
          }
          if (!show || !list.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, list.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter' && !e.metaKey) {
            e.preventDefault();
            pick(list[active].v);
          } else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {secret && (
        <button
          type="button"
          className="absolute right-1.5 top-[15px] flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-ink-faint hover:bg-wash-strong hover:text-ink"
          aria-label={reveal ? 'Hide the value' : 'Show the value'}
          title={reveal ? 'Hide' : 'Show'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setReveal((r) => !r)}
        >
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
            <circle cx="12" cy="12" r="3" />
            {reveal && <path d="M3 3l18 18" />}
          </svg>
        </button>
      )}
      {open && at ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-rule-strong bg-surface-elevated shadow-xl" onMouseDown={(e) => e.preventDefault()}>
          <div className="border-b border-rule px-2.5 py-1.5 text-[10.5px] text-ink-faint">
            {at.kind === 'var' ? `Values kept from responses, and ${env}’s variables` : 'Secrets — their values stay hidden'}
          </div>
          {vars.length ? (
            <ul className="max-h-[240px] overflow-y-auto py-1">
              {vars.map((v, i) => (
                <li key={v.name}>
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-[12px] ${i === Math.min(active, vars.length - 1) ? 'bg-accent/12' : 'hover:bg-wash'}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pickVar(v.name)}
                  >
                    <span className="shrink-0 font-mono text-ink">{at.kind === 'var' ? `{{${v.name}}}` : `\${${v.name}}`}</span>
                    {v.preview && <span className="min-w-0 truncate font-mono text-[11px] text-ink-faint">{v.preview}</span>}
                    <span className="ml-auto shrink-0 pl-2 text-[10.5px] text-ink-faint">{v.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2.5 py-2 text-[11.5px] text-ink-muted">
              {at.kind === 'var'
                ? at.partial
                  ? `Nothing named like “${at.partial}”. Keep one from a response, or add it to ${env}’s variables under Environments.`
                  : `No variables yet. Keep one from a response, or add one to ${env} under Environments.`
                : 'No secrets yet — add them under Environments.'}
            </p>
          )}
        </div>
      ) : show ? (
        <div
          className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-rule-strong bg-surface-elevated shadow-xl"
          onMouseDown={(e) => {
            // Keep the box focused while picking.
            e.preventDefault();
          }}
        >
          {list.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 border-b border-rule px-2.5 py-1.5 text-[10.5px] text-ink-faint">
                <Icon name="history" size={10} /> Seen in earlier responses on {env}
              </div>
              <ul className="max-h-[240px] overflow-y-auto py-1">
                {list.slice(0, 40).map((x, i) => (
                  <li key={String(x.v)}>
                    <button
                      className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-[12px] ${i === active ? 'bg-accent/12' : 'hover:bg-wash'}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(x.v)}
                    >
                      {x.label ? <span className="min-w-0 max-w-[45%] shrink-0 truncate text-ink">{x.label}</span> : null}
                      <span className={`min-w-0 truncate font-mono text-[11.5px] ${x.label ? 'text-ink-faint' : 'text-ink'}`}>{String(x.v)}</span>
                      <span className="ml-auto shrink-0 truncate pl-2 text-[10.5px] text-ink-faint">{x.from}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {data!.sources.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 border-t border-rule px-2.5 py-2 text-[11.5px] text-ink-muted first:border-t-0">
              <span>{list.length ? 'Refresh from' : `Nothing seen for ${param} yet — run`}</span>
              {data!.sources.slice(0, 3).map((s) => (
                <button
                  key={`${s.path}:${s.toolId}`}
                  className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-0.5 font-mono text-[11px] text-ink hover:border-accent/60"
                  disabled={!!filling}
                  onClick={() => void fill(s)}
                  title={`Runs ${s.toolName} (${s.api}) on ${env} with its saved values`}
                >
                  {filling === s.toolId ? 'running…' : s.toolName}
                  {s.path !== path && <span className="font-sans text-ink-faint">· {s.api}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
