import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from './store';
import { Icon, type IconName } from './icons';
import type { Settings } from '@shared/ipc';

type Section = 'general' | 'ai' | 'connections' | 'about';

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'ai', label: 'AI', icon: 'sparkle' },
  { id: 'connections', label: 'Connections', icon: 'plug' },
  { id: 'about', label: 'About', icon: 'file' },
];

/// Settings as a sidebar of short sections, the way macOS and overcli lay
/// them out: one decision per row, the label and what it means on the left,
/// the control on the right.
export function SettingsSheet(): JSX.Element {
  const { settings, info, saveSettings, refreshInfo, openSheet } = useStore();
  const [section, setSection] = useState<Section>('general');
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);
  useEffect(() => void refreshInfo(), [refreshInfo]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && openSheet(null);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [openSheet]);
  if (!settings || !info) return <></>;
  const set = (patch: Partial<Settings>) => void saveSettings(patch);

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 px-6 pt-[9vh] backdrop-blur-[3px]" onMouseDown={() => openSheet(null)}>
      <div
        className="rise flex h-[min(560px,80vh)] w-full max-w-3xl overflow-hidden rounded-xl border border-rule-strong bg-surface-elevated shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-rule bg-surface/60 p-2">
          <div className="display px-2 pb-3 pt-2 text-[16px] font-semibold">Settings</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] ${section === s.id ? 'bg-wash-strong font-medium text-ink' : 'text-ink-muted hover:bg-wash hover:text-ink'}`}
            >
              <Icon name={s.icon} size={14} />
              {s.label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-rule px-5 py-3.5">
            <h2 className="text-[14px] font-semibold">{SECTIONS.find((s) => s.id === section)?.label}</h2>
            <button className="icon-btn h-6 w-6" onClick={() => openSheet(null)} aria-label="Close">
              <Icon name="x" size={13} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5">
            {section === 'general' && (
              <>
                <Row title="Appearance" note="Follows macOS unless you pick one.">
                  <Segmented
                    value={settings.theme}
                    onChange={(v) => set({ theme: v as Settings['theme'] })}
                    options={[
                      ['system', 'System'],
                      ['light', 'Light'],
                      ['dark', 'Dark'],
                    ]}
                  />
                </Row>
                <Row title="New APIs are saved in" note="Each API gets a folder of its own here, with its overapi.json.">
                  <div className="flex items-center gap-2">
                    <span className="max-w-[220px] truncate font-mono text-[12px] text-ink-muted" title={settings.projectsDir}>
                      {settings.projectsDir.replace(/^\/Users\/[^/]+/, '~')}
                    </span>
                    <button
                      className="btn"
                      onClick={async () => {
                        const d = await window.overapi.invoke('settings:pickDir');
                        if (d) set({ projectsDir: d });
                      }}
                    >
                      Change…
                    </button>
                  </div>
                </Row>
                <Row title="Load testing" note="Load-test a scenario's reads from the Tests tab. Off by default: aimed at the wrong environment, a load test is the easiest way to hurt a real API.">
                  <Segmented value={settings.loadTesting ? 'on' : 'off'} onChange={(v) => set({ loadTesting: v === 'on' })} options={[['off', 'Off'], ['on', 'On']]} />
                </Row>
                <Row title="Request timeout" note="How long a request sent from the app waits for an answer.">
                  <div className="flex items-center gap-2">
                    <input className="field w-20 text-right" type="number" min={1} max={300} value={settings.timeoutSec} onChange={(e) => set({ timeoutSec: Number(e.target.value) })} />
                    <span className="text-[12px] text-ink-faint">seconds</span>
                  </div>
                </Row>
              </>
            )}

            {section === 'ai' && (
              <>
                <p className="pt-4 text-[12px] leading-relaxed text-ink-muted">
                  Used only for <b className="text-ink">From documentation</b>, when overapi drafts an API from PDFs or pages. It runs the CLI you already use and are signed in
                  to — there is no API key or account in overapi, and nothing is sent anywhere that CLI would not send it.
                </p>
                <Row title="Installed">
                  <div className="flex gap-2">
                    <Detected name="claude" ok={info.ai.claude} />
                    <Detected name="codex" ok={info.ai.codex} />
                  </div>
                </Row>
                <Row title="Use" note="Automatic picks claude when it’s installed. Only claude can read PDFs.">
                  <Segmented
                    value={settings.ai}
                    onChange={(v) => set({ ai: v as Settings['ai'] })}
                    options={[
                      ['auto', 'Automatic'],
                      ['claude', 'claude'],
                      ['codex', 'codex'],
                    ]}
                  />
                </Row>
                <Row title="Model" note="Leave empty for the CLI’s own default.">
                  <input className="field w-48 font-mono text-[12px]" value={settings.aiModel} onChange={(e) => set({ aiModel: e.target.value })} placeholder="default" />
                </Row>
              </>
            )}

            {section === 'connections' && (
              <>
                <Row title="Keychain" note="Where secrets typed into Environments are kept, encrypted by macOS.">
                  <Status ok={info.keychain} yes="Available" no="Unavailable — use a .env file" />
                </Row>
                <Row title="Publish to your org" note="overapi hands APIs to overcli, which signs in to your org’s overgo.">
                  <div className="flex items-center gap-2">
                    <Status ok={info.overcliTakesApis} yes="Ready" no="Not set up" />
                    {!info.overcliTakesApis && <button className="btn" onClick={() => void refreshInfo()}>Check again</button>}
                  </div>
                </Row>
                {!info.overcliTakesApis && (
                  <p className="-mt-2 pb-4 text-[11px] leading-relaxed text-ink-faint">
                    Install or update overcli, sign in to your org there, and open it once. That creates the hand-off folder overapi looks for.
                  </p>
                )}
                <div className="border-t border-rule py-4">
                  <div className="text-[13px] font-medium">How MCP clients start overapi</div>
                  <p className="mt-0.5 text-[12px] text-ink-faint">Publish → This Mac writes this into each client for you. Shown here for reference.</p>
                  <CommandBox text={[info.serve.command, ...info.serve.prefix, 'serve <overapi.json> --env <name>'].join(' ')} copy={[info.serve.command, ...info.serve.prefix].join(' ')} />
                </div>
              </>
            )}

            {section === 'about' && (
              <>
                <div className="flex items-center gap-3 border-b border-rule py-5">
                  <svg viewBox="0 0 64 64" width={36} height={36} aria-hidden="true">
                    <path d="M20 8 Q 10 8 10 18 L 10 26 Q 10 32 4 32 Q 10 32 10 38 L 10 46 Q 10 56 20 56" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
                    <path d="M44 8 Q 54 8 54 18 L 54 26 Q 54 32 60 32 Q 54 32 54 38 L 54 46 Q 54 56 44 56" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
                    <circle cx="22" cy="32" r="4.5" className="fill-accent" />
                    <circle cx="32" cy="32" r="4.5" className="fill-accent" />
                    <circle cx="42" cy="32" r="4.5" className="fill-accent" />
                  </svg>
                  <div>
                    <div className="display text-[18px] font-semibold">overapi</div>
                    <div className="text-[12px] text-ink-faint">
                      Version {info.version}
                      {info.packaged ? '' : ' · development build'}
                    </div>
                  </div>
                </div>
                <Row title="Automatic updates" note={settings.autoUpdate ? 'Downloads in the background and installs when you quit.' : 'Tells you when there’s a new version; downloads only when you say.'}>
                  <Segmented value={settings.autoUpdate ? 'on' : 'off'} onChange={(v) => set({ autoUpdate: v === 'on' })} options={[['on', 'On'], ['off', 'Off']]} />
                </Row>
                <Row
                  title="Update channel"
                  note={
                    settings.updateChannel === 'beta'
                      ? 'Betas as well as releases — newer, less tested. Going back to Stable waits for a release newer than the beta you have.'
                      : 'Tested releases only.'
                  }
                >
                  <Segmented value={settings.updateChannel} onChange={(v) => set({ updateChannel: v as Settings['updateChannel'] })} options={[['stable', 'Stable'], ['beta', 'Beta']]} />
                </Row>
                <Row title="Check for updates" note={checked ?? (info.packaged ? undefined : 'Updates only run in the installed app.')}>
                  <button
                    className="btn"
                    disabled={checking || !info.packaged}
                    onClick={async () => {
                      setChecking(true);
                      const r = await window.overapi.invoke('update:check');
                      setChecking(false);
                      setChecked(
                        !r.ok
                          ? `Couldn’t check: ${r.error}`
                          : r.available
                            ? `${r.version} is available${settings.autoUpdate ? ' — downloading.' : '.'}`
                            : `You’re up to date${r.version ? ` (${r.version})` : ''}.`,
                      );
                    }}
                  >
                    {checking ? 'Checking…' : 'Check now'}
                  </button>
                </Row>
                <Row title="App data" note="Settings, history and keychain references. Your APIs live in their own folders.">
                  <span className="max-w-[260px] truncate font-mono text-[11px] text-ink-muted" title={info.userData}>
                    {info.userData.replace(/^\/Users\/[^/]+/, '~')}
                  </span>
                </Row>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ title, note, children }: { title: string; note?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-rule py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{title}</div>
        {note && <div className="mt-0.5 text-[12px] leading-snug text-ink-faint">{note}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }): JSX.Element {
  return (
    <div className="inline-flex gap-0.5 rounded-lg bg-wash-strong p-0.5">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className={`rounded-md px-3 py-1 text-[12px] font-medium ${value === v ? 'bg-surface-elevated text-ink shadow-sm' : 'text-ink-muted hover:text-ink'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

function Detected({ name, ok }: { name: string; ok: boolean }): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] ${ok ? 'bg-good/15 text-good' : 'bg-wash-strong text-ink-faint'}`}>
      <Icon name={ok ? 'check' : 'x'} size={11} />
      {name}
    </span>
  );
}

function Status({ ok, yes, no }: { ok: boolean; yes: string; no: string }): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[12px] ${ok ? 'text-good' : 'text-ink-faint'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-good' : 'bg-ink-faint/50'}`} />
      {ok ? yes : no}
    </span>
  );
}

function CommandBox({ text, copy }: { text: string; copy: string }): JSX.Element {
  const say = useStore((s) => s.say);
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg border border-rule bg-wash p-2.5">
      <code className="selectable min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed text-ink-muted">{text}</code>
      <button
        className="btn shrink-0"
        onClick={async () => {
          await window.overapi.invoke('clipboard:write', copy);
          say('Copied.');
        }}
      >
        <Icon name="copy" size={12} /> Copy
      </button>
    </div>
  );
}
