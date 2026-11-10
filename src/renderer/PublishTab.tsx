import { useEffect, useState } from 'react';
import { useStore } from './store';
import { Card, EnvChip } from './ui';
import { Icon } from './icons';
import { InstallsCard } from './Installs';
import { snippets } from '@shared/install';
import { envKind, envVars, offered } from '@shared/project';
import type { Published } from '@shared/ipc';

/// Three places an API goes: this Mac's agents, the org's server, a file.
export function PublishTab(): JSX.Element {
  const { project, path, info, env: active } = useStore();
  const p = project!;
  const [macEnv, setMacEnv] = useState(active ?? p.envs[0]?.name);
  const [orgEnv, setOrgEnv] = useState(p.envs.find((e) => envKind(e.name) !== 'local')?.name ?? p.envs[0]?.name);
  const [published, setPublished] = useState<Published | null>(null);
  useEffect(() => {
    void window.overapi.invoke('overgo:published', path!).then(setPublished);
  }, [path]);

  if (!p.envs.length) return <div className="p-8 text-ink-muted">Add an environment first — publishing serves one of them.</div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-6 pt-6">
        <InstallsCard />
      </div>
      <div className="grid content-start items-start gap-5 p-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <ThisMac envName={macEnv} setEnvName={setMacEnv} />
        <div className="space-y-5">
        <Overgo envName={orgEnv} setEnvName={setOrgEnv} published={published} onPublished={setPublished} available={!!info?.overcliTakesApis} />
        <Card title="A file">
          <p className="text-[12px] leading-relaxed text-ink-muted">
            The project is one JSON file with no secrets in it — commit it beside the API’s code, or hand it to a teammate, who opens it in overapi or serves it with{' '}
            <span className="font-mono">overapi serve</span>. A shared registry is next.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              className="btn"
              onClick={async () => {
                const r = await window.overapi.invoke('projects:export', path!);
                if (r.ok) useStore.getState().say(`Exported to ${r.to}.`);
                else if (r.error) useStore.getState().say(r.error, true);
              }}
            >
              Export a copy…
            </button>
            <button className="btn" onClick={() => void window.overapi.invoke('projects:reveal', path!)}>Show in Finder</button>
          </div>
        </Card>
        </div>
      </div>
    </div>
  );
}

function EnvPicker({ value, onChange, filter }: { value?: string; onChange: (v: string) => void; filter?: (name: string) => boolean }): JSX.Element {
  const { project } = useStore();
  return (
    <div className="flex flex-wrap gap-1.5">
      {project!.envs
        .filter((e) => !filter || filter(e.name))
        .map((e) => (
          <button key={e.name} onClick={() => onChange(e.name)} className={`rounded-full ring-2 ${value === e.name ? 'ring-accent' : 'ring-transparent'}`}>
            <EnvChip name={e.name} writes={e.allowWrites} />
          </button>
        ))}
    </div>
  );
}

function ThisMac({ envName, setEnvName }: { envName?: string; setEnvName: (v: string) => void }): JSX.Element {
  const { project, path, info, secrets, say } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const [client, setClient] = useState<'claude' | 'codex' | 'json'>('claude');
  if (!info) return <></>;
  const all = snippets(p, env, path!, info.serve);
  const s = all.find((x) => x.client === client)!;
  const names = envVars(env);
  const viaApp = info.packaged;

  return (
    <Card title="This Mac — Claude Code, overcli, Codex and other MCP clients">
      <div className="mb-3 flex items-center gap-3">
        <span className="text-[12px] text-ink-muted">Serve</span>
        <EnvPicker value={env.name} onChange={setEnvName} />
        <span className="text-[12px] text-ink-faint">{p.tools.filter((t) => offered(t, env)).length} tools</span>
      </div>
      <div className="flex gap-1 border-b border-rule">
        {all.map((x) => (
          <button key={x.client} onClick={() => setClient(x.client)} className={`-mb-px border-b-2 px-3 py-1.5 text-[12px] font-medium ${client === x.client ? 'border-accent' : 'border-transparent text-ink-muted hover:text-ink'}`}>
            {x.label}
          </button>
        ))}
      </div>
      {client === 'claude' && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-accent/10 px-3 py-2.5">
          <span className="flex-1 text-[12px]">
            <b>One click:</b> adds <span className="font-mono">{env.name}</span> to Claude Code — and so to overcli, which uses the same list. Start a new Claude session to see it.
          </span>
          <button
            className="btn"
            title="Take it out of Claude Code (and overcli)"
            onClick={async () => {
              const r = await window.overapi.invoke('install:claudeRemove', path!, env.name);
              if (r.ok) say(`Removed "${r.name}" from Claude Code and overcli.`);
              else say(r.error, true);
            }}
          >
            Remove
          </button>
          <button
            className="btn-primary"
            onClick={async () => {
              const r = await window.overapi.invoke('install:claude', path!, env.name);
              if (r.ok) say(`Added "${r.name}" to Claude Code. Open a new session and ask it to use the API.`);
              else say(r.error, true);
            }}
          >
            Add to Claude Code
          </button>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[12px] text-ink-muted">{client === 'claude' ? 'Or run it yourself in a terminal:' : s.where}</p>
        <button
          className="btn shrink-0"
          onClick={async () => {
            await window.overapi.invoke('clipboard:write', s.text);
            say('Copied.');
          }}
        >
          <Icon name="copy" size={12} /> Copy
        </button>
      </div>
      <pre className="selectable mt-2 whitespace-pre-wrap break-all rounded-lg border border-rule bg-wash p-3 font-mono text-[11px] leading-relaxed">{s.text}</pre>
      {names.length > 0 && (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          {viaApp
            ? 'The server runs inside overapi, so it uses the secrets saved in Environments. Leave the <PLACEHOLDERS> as they are.'
            : `In development the server runs under Node and can’t read the keychain: replace each <PLACEHOLDER>, or put them in the .env beside the project.${names.every((n) => secrets[n] === 'dotenv' || secrets[n] === 'env') ? ' (They are all there.)' : ''}`}
        </p>
      )}
      <p className="mt-1 text-[11px] text-ink-faint">A running server notices edits within seconds and tells the client its tools changed — no restart.</p>
    </Card>
  );
}

function Overgo({ envName, setEnvName, published, onPublished, available }: { envName?: string; setEnvName: (v: string) => void; published: Published | null; onPublished: (p: Published) => void; available: boolean }): JSX.Element {
  const { project, path, say, refreshInfo } = useStore();
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const on = p.tools.filter((t) => t.enabled);
  const reads = on.filter((t) => t.safety === 'read').length;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(env.baseUrl) || !env.baseUrl;
  const secretNames = envVars(env);

  const publish = async () => {
    setBusy(true);
    const r = await window.overapi.invoke('overgo:publish', path!, p, env.name);
    setBusy(false);
    setConfirming(false);
    if (r.ok) {
      onPublished({ at: new Date().toISOString(), env: env.name, id: r.id });
      say('Handed to overcli. An admin finishes it in overgo’s console under Setup → APIs.');
    } else say(r.error, true);
  };

  return (
    <Card
      title="Your org — overgo"
      right={published && <span className="text-[11px] text-good">Published {env.name === published.env ? '' : `(${published.env}) `}{new Date(published.at).toLocaleString()}</span>}
    >
      {!available ? (
        <div className="space-y-2 text-[12px] leading-relaxed text-ink-muted">
          <p>
            Publishing goes through overcli, which signs in to your org’s overgo. overcli isn’t set up for it on this Mac yet — update overcli, sign in to your org, and open it
            once.
          </p>
          <button className="btn" onClick={() => void refreshInfo()}>Check again</button>
        </div>
      ) : (
        <>
          <ol className="mb-4 grid grid-cols-3 gap-3 text-[11px] leading-snug text-ink-muted">
            <li><b className="text-ink">1. You publish.</b> The project goes to overcli, then to overgo — with no secret in it.</li>
            <li><b className="text-ink">2. An admin finishes it.</b> In overgo’s console (Setup → APIs): read-only or writes, and the secrets typed there.</li>
            <li><b className="text-ink">3. Workers use it.</b> overgo runs it as a tool workers can be given, like any other.</li>
          </ol>
          <div className="mb-3 flex items-center gap-3">
            <span className="text-[12px] text-ink-muted">Environment</span>
            <EnvPicker value={env.name} onChange={setEnvName} />
          </div>
          <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 rounded-lg bg-wash p-3 text-[12px]">
            <dt className="text-ink-faint">Base URL</dt>
            <dd className={`font-mono ${local ? 'text-bad' : ''}`}>{env.baseUrl || '(none)'}</dd>
            <dt className="text-ink-faint">Tools</dt>
            <dd>
              {on.length} — {reads} read, {on.length - reads} change data{!env.allowWrites && on.length - reads ? ' (hidden: read-only)' : ''}
            </dd>
            <dt className="text-ink-faint">Admin must set</dt>
            <dd className="font-mono">{secretNames.length ? secretNames.join(', ') : 'nothing — no sign-in'}</dd>
            <dt className="text-ink-faint">Not sent</dt>
            <dd>Secret values, other environments, requests that are off, your history.</dd>
          </dl>
          {local && <p className="mt-2 text-[12px] text-bad">This environment points at this Mac; the org’s server can’t reach it. Pick one with a shared address.</p>}
          <div className="mt-4 flex items-center gap-2">
            {confirming ? (
              <>
                <button className="btn-primary" disabled={busy} onClick={() => void publish()}>{busy ? 'Publishing…' : `Publish ${p.title} (${env.name})`}</button>
                <button className="btn" onClick={() => setConfirming(false)}>Cancel</button>
              </>
            ) : (
              <button className="btn-primary" disabled={local || !on.length} onClick={() => setConfirming(true)}>
                {published ? 'Publish an update…' : 'Publish to overgo…'}
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
