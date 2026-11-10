import { useEffect, useState } from 'react';
import { useStore } from './store';
import { EnvDot } from './ui';
import { snippets } from '@shared/install';
import { envKind, offered, type EnvDef } from '@shared/project';
import type { Installs } from '@shared/ipc';

/// Where this API is installed — one row per environment, because each
/// install is its own server: same tools, that environment's base URL,
/// sign-in and writes setting. Claude Code and Codex run it on this Mac;
/// only overgo receives a copy. `compact` is the Tools rail's version.
export function InstallsCard({ compact }: { compact?: boolean }): JSX.Element {
  const { path, info, project, setMcpTab, say } = useStore();
  const p = project!;
  const [installs, setInstalls] = useState<Installs | null>(null);
  const load = () => void window.overapi.invoke('installs:get', path!).then(setInstalls);
  useEffect(load, [path]);

  const add = async (env: EnvDef) => {
    const r = await window.overapi.invoke('install:claude', path!, env.name);
    if (r.ok) say(`Added "${r.name}" (${env.name}) to Claude Code and overcli. New sessions get it.`);
    else say(r.error, true);
    load();
  };
  const remove = async (env: EnvDef) => {
    const r = await window.overapi.invoke('install:claudeRemove', path!, env.name);
    if (r.ok) say(`Removed "${r.name}" from Claude Code and overcli. Open sessions keep it until they restart.`);
    else say(r.error, true);
    load();
  };
  const codex = async (env: EnvDef) => {
    if (!info) return;
    const s = snippets(p, env, path!, info.serve).find((x) => x.client === 'codex')!;
    await window.overapi.invoke('clipboard:write', s.text);
    say(`Copied the Codex config for ${env.name} — paste it into ~/.codex/config.toml.`);
  };
  const local = (e: EnvDef) => !e.baseUrl || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(e.baseUrl);

  const claudeCell = (e: EnvDef) => {
    const inst = installs?.claude[e.name];
    if (!e.baseUrl) return <span className="text-ink-faint">set a base URL first</span>;
    return inst ? (
      <span className="flex items-center gap-2">
        <span className="text-good">✓</span>
        {!compact && <span className="truncate font-mono text-[10px] text-ink-faint" title={inst.name}>{inst.name}</span>}
        <button className="btn h-[24px] px-2 text-[11px]" onClick={() => void remove(e)}>Remove</button>
      </span>
    ) : (
      <button className="btn h-[24px] px-2 text-[11px]" onClick={() => void add(e)}>Add</button>
    );
  };

  const overgoCell = (e: EnvDef) => {
    const pub = installs?.overgo;
    if (pub?.env === e.name) return <span className="flex items-center gap-2"><span className="text-good">✓ published</span><button className="btn h-[24px] px-2 text-[11px]" onClick={() => setMcpTab('install')}>Update</button></span>;
    if (local(e)) return <span className="text-ink-faint">{e.baseUrl ? 'this Mac only' : '—'}</span>;
    if (!info?.overcliTakesApis) return <button className="text-[11px] text-ink-faint hover:text-ink" onClick={() => setMcpTab('install')}>overcli not set up</button>;
    return <button className="btn h-[24px] px-2 text-[11px]" onClick={() => setMcpTab('install')}>Publish</button>;
  };

  if (compact) {
    return (
      <section aria-labelledby="installed" className="rounded-xl border border-rule bg-wash px-5 pb-2 pt-4">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 id="installed" className="text-[13px] font-semibold">Where it’s installed</h2>
          <button className="text-[12px] text-accent hover:underline" onClick={() => setMcpTab('install')}>All</button>
        </div>
        <p className="mb-1 text-[11px] text-ink-faint">One server per environment, in Claude Code and overcli.</p>
        {p.envs.map((e) => (
          <div key={e.name} className="flex items-center gap-2.5 border-b border-rule py-2 last:border-b-0">
            <EnvDot name={e.name} />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{e.name}</span>
            <span className="shrink-0 text-[12px]">{claudeCell(e)}</span>
          </div>
        ))}
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-rule bg-wash">
      <div className="border-b border-rule px-4 py-3">
        <h3 className="text-[13px] font-semibold">Where it’s installed — one row per environment</h3>
        <p className="mt-0.5 text-[12px] text-ink-muted">
          Each install is its own server: same tools, that environment’s base URL, sign-in and writes setting. Claude Code and Codex run it on this Mac when a session starts —
          nothing is uploaded. Only overgo receives a copy, after an admin approves it.
        </p>
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            <th className="px-4 py-2 text-left font-semibold">Environment</th>
            <th className="px-3 py-2 text-left font-semibold">Agents get</th>
            <th className="px-3 py-2 text-left font-semibold">Claude Code &amp; overcli</th>
            <th className="px-3 py-2 text-left font-semibold">Codex</th>
            <th className="px-3 py-2 text-left font-semibold">overgo (org)</th>
          </tr>
        </thead>
        <tbody>
          {p.envs.map((e) => {
            const n = p.tools.filter((t) => offered(t, e)).length;
            return (
              <tr key={e.name} className="border-t border-rule align-top">
                <td className="px-4 py-3">
                  <span className="flex items-center gap-1.5 font-semibold">
                    <EnvDot name={e.name} />
                    {e.name}
                    {envKind(e.name) === 'production' && <span className="rounded bg-bad/15 px-1 text-[9px] uppercase text-bad">real data</span>}
                  </span>
                  <span className={`mt-0.5 block truncate font-mono text-[10px] ${e.baseUrl ? 'text-ink-faint' : 'text-warn'}`}>{e.baseUrl || 'no base URL yet'}</span>
                </td>
                <td className="px-3 py-3 text-ink-muted">{e.baseUrl ? `${n} tool${n === 1 ? '' : 's'} · ${e.allowWrites ? 'writes' : 'read-only'}` : '—'}</td>
                <td className="px-3 py-3">{claudeCell(e)}</td>
                <td className="px-3 py-3">{e.baseUrl ? <button className="btn h-[24px] px-2 text-[11px]" onClick={() => void codex(e)}>Copy config</button> : <span className="text-ink-faint">—</span>}</td>
                <td className="px-3 py-3">{overgoCell(e)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
