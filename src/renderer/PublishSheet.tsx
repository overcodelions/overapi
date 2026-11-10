import { useEffect, useState } from 'react';
import { useStore } from './store';
import { EnvDot, Sheet } from './ui';
import { Icon, type IconName } from './icons';
import { TestsBadge, ago } from './TestsTab';
import { checkProject } from '@shared/check';
import { forEnv } from '@shared/scan';
import { ScoreChip, useScan } from './SecurityTab';
import { envKind, offered, type EnvDef } from '@shared/project';
import type { Installs } from '@shared/ipc';

/// Publishing, in one place: an API becomes an MCP server agents can use —
/// on this Mac (Claude Code, and overcli, which reads the same config), for
/// the team (overgo, through overcli), or as a file. Each says what it is,
/// who gets it, where it stands, and the one thing to press.
export function PublishSheet(): JSX.Element {
  const { project, path, env: active, secrets, info, openSheet, setTab, setMcpTab, say } = useStore();
  const p = project!;
  const [installs, setInstalls] = useState<Installs | null>(null);
  const [macEnv, setMacEnv] = useState(active ?? p.envs[0]?.name);
  const [teamEnv, setTeamEnv] = useState(p.envs.find((e) => envKind(e.name) !== 'local' && !e.browserSession && !isLocal(e))?.name ?? p.envs[0]?.name);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmTeam, setConfirmTeam] = useState(false);
  const load = () => void window.overapi.invoke('installs:get', path!).then(setInstalls);
  useEffect(load, [path]);

  const scan = useScan()!;
  const score = checkProject(p, Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, !!v]))).score;
  const mac = p.envs.find((e) => e.name === macEnv) ?? p.envs[0];
  const team = p.envs.find((e) => e.name === teamEnv) ?? p.envs[0];
  const tools = (e?: EnvDef) => (e ? p.tools.filter((t) => offered(t, e)).length : 0);
  const installed = mac ? installs?.claude[mac.name] : undefined;
  const published = installs?.overgo;
  const close = () => openSheet(null);
  const details = () => {
    close();
    setTab('mcp');
    setMcpTab('install');
  };

  const teamBlocker = !team
    ? 'Add an environment first.'
    : team.browserSession
      ? `${team.name} signs in with your own browser session — publishing it would let everyone act as you. Pick an environment that signs in with a token.`
      : isLocal(team)
        ? `${team.name} points at this Mac (${host(team.baseUrl)}); the team's server can't reach it. Pick an environment with a shared address.`
        : forEnv(scan, team).blocking.length
          ? `The security scan found ${forEnv(scan, team).blocking.length} serious issue${forEnv(scan, team).blocking.length === 1 ? '' : 's'} for ${team.name}: ${forEnv(scan, team).blocking[0].title}. Fix or accept ${forEnv(scan, team).blocking.length === 1 ? 'it' : 'them'} under MCP server → Security.`
          : !tools(team)
          ? `${team.name} offers no tools yet — turn requests into tools first.`
          : !info?.overcliTakesApis
            ? 'Publishing to the team goes through overcli, which isn’t set up for it on this Mac yet: update overcli, sign in to your org, and open it once.'
            : undefined;

  return (
    <Sheet title={`Publish ${p.title}`} onClose={close} wide footer={<FooterLinks onDetails={details} />}>
      <div className="space-y-4 text-[13px]">
        <p className="leading-relaxed text-ink-muted">
          Publishing makes {p.title} an <b className="text-ink">MCP server</b>: its tools, for agents to call. Pick where it goes. Each environment is its own server — publish the
          one agents should talk to.
        </p>

        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-wash px-3 py-2 text-[12px]">
          <span className={`rounded-full px-2 py-0.5 font-semibold tabular-nums ${score >= 90 ? 'bg-good/15 text-good' : score >= 60 ? 'bg-warn/15 text-warn' : 'bg-bad/15 text-bad'}`}>Ready {score}</span>
          <button className="contents" onClick={() => { close(); setTab('mcp'); setMcpTab('security'); }} title="Open the security scan">
            <ScoreChip score={scan.score} />
          </button>
          <TestsBadge />
          <span className="text-ink-muted">{p.tools.filter((t) => t.enabled).length} of {p.tools.length} requests are tools</span>
          <span className="flex-1" />
          {score < 90 && (
            <button
              className="text-accent hover:underline"
              onClick={() => {
                close();
                setTab('mcp');
                setMcpTab('tools');
              }}
            >
              What to fix
            </button>
          )}
        </div>

        <Destination
          icon="laptop"
          title="This Mac — Claude Code and overcli"
          who="You. Agents on this Mac call it; secrets come from your keychain."
          status={installed ? <Ok>In Claude Code as {installed.name} · {ago(installed.at)}</Ok> : <Muted>Not installed</Muted>}
        >
          <EnvRow envs={p.envs} value={mac?.name} onChange={setMacEnv} count={tools(mac)} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              className="btn-primary"
              disabled={!mac || !tools(mac) || busy === 'mac'}
              onClick={async () => {
                setBusy('mac');
                const r = await window.overapi.invoke('install:claude', path!, mac!.name);
                setBusy(null);
                if (r.ok) say(`Added "${r.name}" to Claude Code — overcli picks it up too. Open a new session and ask it to use ${p.title}.`);
                else say(r.error, true);
                load();
              }}
            >
              {busy === 'mac' ? 'Adding…' : installed ? `Update ${mac?.name} in Claude Code` : `Add ${mac?.name ?? ''} to Claude Code`}
            </button>
            {installed && (
              <button
                className="btn"
                onClick={async () => {
                  const r = await window.overapi.invoke('install:claudeRemove', path!, mac!.name);
                  if (r.ok) say(`Removed "${r.name}" from Claude Code and overcli.`);
                  else say(r.error, true);
                  load();
                }}
              >
                Remove
              </button>
            )}
            <button className="text-[12px] text-accent hover:underline" onClick={details}>
              Codex, Cursor or another client →
            </button>
          </div>
        </Destination>

        <Destination
          icon="building"
          title="Your team — overgo"
          who="Everyone in your org. An admin approves it and types the secrets on the server; workers can then be given it as a tool."
          status={published ? <Ok>Published {published.env} · {ago(published.at)}</Ok> : <Muted>Not published</Muted>}
        >
          <EnvRow envs={p.envs} value={team?.name} onChange={(v) => { setTeamEnv(v); setConfirmTeam(false); }} count={tools(team)} />
          {teamBlocker ? (
            <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-[12px] text-warn">{teamBlocker}</p>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {confirmTeam ? (
                <>
                  <span className="text-[12px] text-ink-muted">
                    Sends {tools(team)} tools on {team!.name} ({host(team!.baseUrl)}) — no secret values.
                  </span>
                  <button
                    className="btn-primary"
                    disabled={busy === 'team'}
                    onClick={async () => {
                      setBusy('team');
                      const r = await window.overapi.invoke('overgo:publish', path!, p, team!.name);
                      setBusy(null);
                      setConfirmTeam(false);
                      if (r.ok) say('Handed to overcli. An admin finishes it in overgo’s console under Setup → APIs.');
                      else say(r.error, true);
                      load();
                    }}
                  >
                    {busy === 'team' ? 'Publishing…' : 'Publish'}
                  </button>
                  <button className="btn" onClick={() => setConfirmTeam(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn-primary" onClick={() => setConfirmTeam(true)}>
                  {published ? `Publish ${team!.name} again` : `Publish ${team!.name} to overgo…`}
                </button>
              )}
            </div>
          )}
        </Destination>

        <Destination icon="file" title="A file" who="Anyone you hand it to. One JSON file with no secrets — commit it beside the API’s code; they open it in overapi or run overapi serve.">
          <div className="flex flex-wrap gap-2">
            <button
              className="btn"
              onClick={async () => {
                const r = await window.overapi.invoke('projects:export', path!);
                if (r.ok) say(`Exported to ${r.to}.`);
                else if (r.error) say(r.error, true);
              }}
            >
              Export a copy…
            </button>
            <button className="btn" onClick={() => void window.overapi.invoke('projects:reveal', path!)}>
              Show in Finder
            </button>
          </div>
        </Destination>
      </div>
    </Sheet>
  );
}

function Destination({ icon, title, who, status, children }: { icon: IconName; title: string; who: string; status?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <section className="rounded-xl border border-rule p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Icon name={icon} size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3 className="text-[14px] font-semibold">{title}</h3>
            {status}
          </div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{who}</p>
          <div className="mt-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

function EnvRow({ envs, value, onChange, count }: { envs: EnvDef[]; value?: string; onChange: (v: string) => void; count: number }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className="text-ink-muted">Environment</span>
      <div className="flex flex-wrap gap-1">
        {envs.map((e) => (
          <button key={e.name} aria-pressed={e.name === value} onClick={() => onChange(e.name)} className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 ${e.name === value ? 'border-accent bg-accent/10 font-medium text-ink' : 'border-rule text-ink-muted hover:text-ink'}`}>
            <EnvDot name={e.name} /> {e.name}
          </button>
        ))}
      </div>
      <span className="text-ink-faint">
        {count} tool{count === 1 ? '' : 's'} · {host(envs.find((e) => e.name === value)?.baseUrl ?? '') || 'no base URL'}
      </span>
    </div>
  );
}

function FooterLinks({ onDetails }: { onDetails: () => void }): JSX.Element {
  return (
    <div className="flex w-full items-center justify-between text-[12px]">
      <span className="text-ink-faint">Each environment is a separate server; publishing one doesn’t touch the others.</span>
      <button className="text-accent hover:underline" onClick={onDetails}>
        All the details →
      </button>
    </div>
  );
}

const Ok = ({ children }: { children: React.ReactNode }) => (
  <span className="flex items-center gap-1 text-[12px] text-good">
    <Icon name="check" size={12} /> {children}
  </span>
);
const Muted = ({ children }: { children: React.ReactNode }) => <span className="text-[12px] text-ink-faint">{children}</span>;

const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
function isLocal(e: EnvDef): boolean {
  return /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(host(e.baseUrl));
}
