import { ago } from './TestsTab';
import { SecurityTab, useScan } from './SecurityTab';
import { ChainsTab, Journey } from './ChainsTab';
import { ToolsTab } from './ToolsTab';
import { findLinks, sharedValues } from '@shared/chains';
import { useEffect, useState } from 'react';
import { useStore, type McpTab as Sub } from './store';
import { OverviewTab } from './OverviewTab';
import { AgentTab } from './AgentTab';
import { PublishTab } from './PublishTab';
import { SubTabs, TryAgentTab } from './ui';
import { Icon } from './icons';
import { checkProject, TOOL_BUDGET } from '@shared/check';
import { offered, slug } from '@shared/project';

/// The API as an MCP server — the output, beside the API client that makes
/// it (Requests, Environments). Three views of one thing:
///   Tools        what agents get here, readiness, the agent brief, where
///                it's installed
///   Test         connect as an MCP client and call tools (was "As an agent")
///   Install      Claude Code, Codex, overgo, a file (was "Publish")
const MCP_PAGES: { id: import('./store').McpTab; label: string; icon: import('./icons').IconName }[] = [
  { id: 'tools', label: 'Tools', icon: 'bot' },
  { id: 'chains', label: 'Chains', icon: 'plug' },
  { id: 'security', label: 'Security', icon: 'lock' },
  // Last: see it work, right before Publish.
  { id: 'test', label: 'Try as an agent', icon: 'send' },
];

export function McpTab(): JSX.Element {
  const { project, path, env: envName, secrets, mcpTab, setMcpTab, say, update, openSheet } = useStore();
  const [installed, setInstalled] = useState<{ at: string; name: string; env: string } | undefined>(undefined);
  const load = () => void window.overapi.invoke('installs:get', path!).then((i) => setInstalled(i.claude[envName ?? ''] ? { ...i.claude[envName ?? ''], env: envName ?? '' } : undefined));
  useEffect(load, [path, envName]);
  const p = project!;
  const env = p.envs.find((e) => e.name === envName) ?? p.envs[0];
  const vars = Object.fromEntries(Object.entries(secrets).map(([k, v]) => [k, !!v]));
  const score = checkProject(p, vars).score;
  const count = env ? p.tools.filter((t) => offered(t, env)).length : 0;
  const scan = useScan();
  const live = env ? p.tools.filter((t) => offered(t, env)) : [];
  // Roughly what the tool list costs an agent on every turn (≈4 characters a token).
  const tokens = Math.round(live.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, params: t.params.map((x) => [x.name, x.schema, x.description]) }).length, 0) / 4);
  const weakCount = live.filter((t) => !t.description || /inferred from \d+ captured|seen \d+ times? in the capture|captured call/i.test(t.description)).length;

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-3.5 px-7 pt-5">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[260px] flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">MCP server</div>
            <input
              className="display w-full bg-transparent text-[26px] font-semibold leading-tight outline-none hover:underline hover:decoration-rule-strong hover:decoration-dotted focus:no-underline"
              value={p.title}
              aria-label="API name"
              title="Rename this API"
              onChange={(e) => update((x) => ({ ...x, title: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              onBlur={async (e) => {
                // On finishing, the internal name follows the title, and any
                // Claude Code installs move to the new name.
                const title = e.target.value.trim();
                if (!title || slug(title) === p.name) return;
                const r = await window.overapi.invoke('projects:rename', path!, title);
                if (!r.ok) return say(r.error, true);
                update((x) => ({ ...x, title, name: r.name }));
                load();
                say(`Renamed to ${r.name}.` + (r.moved.length ? ` Claude Code now has it as ${r.moved.join(', ')}.` : '') + (r.overgo ? ' Publish to overgo again to rename it there.' : ''));
              }}
            />
          </div>
          {installed && (
            <span className="flex items-center gap-1 pb-2 text-[12px] text-good" title={`Installed in Claude Code as ${installed.name}`}>
              <Icon name="check" size={12} /> In Claude Code
            </span>
          )}
          <span className="mb-1">
            <Journey />
          </span>
          <button className="btn mb-1 h-[36px] px-3.5 text-[13px]" title="Tidy, connect and document it — with your claude or codex" onClick={() => openSheet({ kind: 'agentready' })}>
            <Icon name="sparkle" size={13} /> Make it agent-ready
          </button>
          <button className="btn-primary mb-1 h-[36px] px-4 text-[13px]" disabled={!env} onClick={() => openSheet({ kind: 'publish' })}>
            <Icon name="publish" size={13} /> Publish…
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2.5" aria-label="Server health">
          <Tile
            label={`Tools on ${env?.name ?? '—'}`}
            tone={count > TOOL_BUDGET ? 'warn' : 'plain'}
            value={
              <>
                {count}
                {count > TOOL_BUDGET && <span className="ml-1.5 text-[13px] font-normal text-warn">· budget {TOOL_BUDGET}</span>}
              </>
            }
            note={`≈${tokens.toLocaleString()} tokens every agent turn · ${env?.allowWrites ? 'writes allowed' : 'read-only'}`}
            onClick={() => setMcpTab('tools')}
          />
          <Tile
            label="Ready for agents"
            tone={score >= 90 ? 'good' : score >= 60 ? 'warn' : 'bad'}
            value={String(score)}
            note={weakCount ? `${weakCount} weak description${weakCount === 1 ? '' : 's'}` : 'descriptions look fine'}
            onClick={() => setMcpTab('tools')}
            colorValue
          />
          <Tile
            label="Security"
            tone={scan && scan.score >= 90 ? 'good' : scan && scan.score >= 60 ? 'warn' : 'bad'}
            value={String(scan?.score ?? '—')}
            note={
              scan?.blocking.length
                ? `${scan.blocking.length} serious — blocks publishing to the team`
                : scan?.findings.length
                  ? `${scan.findings.length} finding${scan.findings.length === 1 ? '' : 's'}, none blocking`
                  : 'nothing found'
            }
            onClick={() => setMcpTab('security')}
            colorValue
          />
          <TestsTile />
        </div>

        {/* The server's own pages. "Publish details" is reached from the
            Publish sheet. */}
        <nav aria-label="MCP server pages" className="flex items-end gap-4 border-b border-rule">
          {MCP_PAGES.map((t) => {
            const on = mcpTab === t.id || (t.id === 'tools' && mcpTab === 'install');
            if (t.id === 'test') return <TryAgentTab key={t.id} on={on} onClick={() => setMcpTab(t.id)} />;
            return (
              <button
                key={t.id}
                onClick={() => setMcpTab(t.id)}
                aria-current={on ? 'page' : undefined}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-0.5 pb-2 text-[13px] font-medium transition-colors ${on ? 'border-accent text-ink' : 'border-transparent text-ink-muted hover:text-ink'}`}
              >
                <Icon name={t.icon} size={13} className={on ? 'text-accent' : 'text-ink-faint'} />
                {t.label}
                {t.id === 'chains' && <ChainCount />}
              </button>
            );
          })}
        </nav>
        {mcpTab === 'install' && (
          <div className="flex items-center gap-2 border-b border-rule pb-2 text-[12px] text-ink-muted">
            <span className="font-medium text-ink">Publish details</span>
            <span>— Codex, Cursor and other clients, overgo, a file.</span>
          </div>
        )}
      </header>
      <div key={mcpTab} className="rise min-h-0 flex-1 overflow-hidden">
        {mcpTab === 'tools' && <ToolsTab />}
        {mcpTab === 'chains' && <ChainsTab />}
        {mcpTab === 'test' && <AgentTab />}
        {mcpTab === 'security' && <SecurityTab />}
        {mcpTab === 'install' && <PublishTab />}
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  tone,
  onClick,
  colorValue,
}: {
  label: string;
  value: React.ReactNode;
  note: string;
  tone: 'good' | 'warn' | 'bad' | 'plain';
  onClick: () => void;
  colorValue?: boolean;
}): JSX.Element {
  const box = tone === 'bad' ? 'border-bad/40 bg-bad/[0.05]' : tone === 'warn' ? 'border-warn/40 bg-warn/[0.05]' : 'border-rule bg-surface';
  const ink = !colorValue ? '' : tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : '';
  return (
    <button onClick={onClick} className={`flex flex-col gap-0.5 rounded-xl border px-3.5 py-2.5 text-left hover:brightness-110 ${box}`}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{label}</span>
      <span className={`display text-[22px] font-semibold tabular-nums leading-tight ${ink}`}>{value}</span>
      <span className="truncate text-[11px] text-ink-muted">{note}</span>
    </button>
  );
}

/// The tests' latest result, as a tile: opens Tests.
function TestsTile(): JSX.Element {
  const { project, path, setTab } = useStore();
  const [runs, setRuns] = useState<Record<string, import('@shared/scenario').ScenarioRun>>({});
  useEffect(() => {
    if (path) void window.overapi.invoke('scenario:runs', path).then(setRuns);
  }, [path]);
  const scenarios = project?.scenarios ?? [];
  const latest = scenarios
    .map((s) => runs[s.id])
    .filter(Boolean)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  const failing = scenarios.filter((s) => runs[s.id]?.failed).length;
  const name = latest ? scenarios.find((s) => s.id === latest.scenarioId)?.name : undefined;
  return (
    <Tile
      label="Tests"
      tone={!scenarios.length || !latest ? 'plain' : failing ? 'bad' : 'good'}
      value={!scenarios.length ? 'None yet' : !latest ? 'Not run' : failing ? `${failing} failing` : 'Passing'}
      note={
        latest
          ? `${name ?? 'Last run'} · ${latest.env} · ${ago(latest.at)}`
          : scenarios.length
            ? `${scenarios.length} scenario${scenarios.length === 1 ? '' : 's'}`
            : 'Record traffic, then save it as a test'
      }
      onClick={() => setTab('tests')}
      colorValue
    />
  );
}

/// Chains still to connect, on the tab.
export function ChainCount(): JSX.Element | null {
  const { project, env: envName } = useStore();
  if (!project) return null;
  const env = project.envs.find((e) => e.name === envName) ?? project.envs[0];
  const n = findLinks(project).filter((l) => !l.done).length + sharedValues(project, env).length;
  return n ? <span className="ml-1 rounded-full bg-accent/20 px-1.5 text-[10px] font-semibold tabular-nums text-accent">{n}</span> : null;
}
