import { RenewButton } from './Renew';
import { useEffect, useState } from 'react';
import { useStore } from './store';
import { Empty, EnvChip, EnvDot, Toggle } from './ui';
import { Icon } from './icons';
import { isSessionHeader, sameSite, siteGuess } from '@shared/session';
import { envKind, envVars, exampleSecrets, fillVars, offered, slug, varPrefix, type AuthSpec, type EnvDef } from '@shared/project';
import type { SecretSource } from '@shared/ipc';

const PRESETS = [
  { name: 'local', hint: 'Your machine or a dev server' },
  { name: 'staging', hint: 'Shared test system' },
  { name: 'production', hint: 'The real thing — starts read-only' },
];

export function EnvsTab(): JSX.Element {
  const { project, update, env: activeName, setEnv } = useStore();
  const p = project!;
  const [selected, setSelected] = useState<string | undefined>(activeName ?? p.envs[0]?.name);
  const env = p.envs.find((e) => e.name === selected) ?? p.envs[0];

  const add = (name: string, from?: EnvDef) => {
    let n = slug(name) || 'env';
    for (let i = 2; p.envs.some((e) => e.name === n); i++) n = `${slug(name)}-${i}`;
    const base = from ?? p.envs[0];
    update((x) => ({
      ...x,
      envs: [
        ...x.envs,
        {
          name: n,
          baseUrl: from?.baseUrl ?? '',
          auth: base?.auth ?? { type: 'none' },
          allowWrites: envKind(n) !== 'production' && (from?.allowWrites ?? envKind(n) === 'local'),
          vars: { ...(base?.vars ?? {}) },
          // A browser sign-in belongs to the environment it was made for:
          // the copy starts without it (and its own secrets when it signs in).
          headers: from?.headers ? Object.fromEntries(Object.entries(from.headers).filter(([, v]) => !isSessionHeader(v))) : undefined,
        },
      ],
    }));
    setSelected(n);
  };

  return (
    <div className="flex h-full">
      <div className="flex w-[260px] shrink-0 flex-col border-r border-rule">
        <div className="border-b border-rule p-3 text-[12px] leading-relaxed text-ink-muted">
          <div className="mb-1 font-semibold text-ink">What’s an environment?</div>
          The same API usually runs in more than one place — on your machine, on a shared test server, and the real one customers use. Each environment is one of those
          places: <b className="text-ink">where requests go</b> (its base URL) and <b className="text-ink">how they sign in</b>. Your requests stay the same; pick the
          environment in the top bar to choose where they’re sent.
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {p.envs.map((e) => (
            <button
              key={e.name}
              onClick={() => setSelected(e.name)}
              className={`mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left ${e.name === env?.name ? 'bg-accent/10' : 'hover:bg-wash'}`}
            >
              <EnvDot name={e.name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] font-medium">
                  {e.name}
                  {e.name === activeName && <span className="text-[10px] font-normal text-ink-faint">active</span>}
                </div>
                <div className="truncate font-mono text-[10px] text-ink-faint">{e.baseUrl || 'no base URL'}</div>
              </div>
              {!e.allowWrites && <span className="text-[10px] text-ink-faint">RO</span>}
            </button>
          ))}
        </div>
        <div className="space-y-1 border-t border-rule p-3">
          <div className="label">Add</div>
          {PRESETS.filter((x) => !p.envs.some((e) => e.name === x.name)).map((x) => (
            <button key={x.name} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-wash-strong" onClick={() => add(x.name)}>
              <EnvDot name={x.name} />
              <span className="font-medium">{x.name}</span>
              <span className="truncate text-[11px] text-ink-faint">{x.hint}</span>
            </button>
          ))}
          <button className="w-full rounded-md px-2 py-1.5 text-left text-[12px] text-ink-muted hover:bg-wash-strong" onClick={() => add('custom')}>+ Custom…</button>
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {env ? (
          <EnvEditor
            key={env.name}
            env={env}
            active={env.name === activeName}
            makeActive={() => setEnv(env.name)}
            duplicate={() => add(`${env.name}-copy`, env)}
            remove={
              p.envs.length > 1
                ? () => {
                    update((x) => ({ ...x, envs: x.envs.filter((e) => e.name !== env.name) }));
                    setSelected(p.envs.find((e) => e.name !== env.name)?.name);
                  }
                : undefined
            }
            rename={(n) => setSelected(n)}
          />
        ) : (
          <Empty>Add an environment: where requests go, and how they sign in.</Empty>
        )}
      </div>
    </div>
  );
}

function EnvEditor({ env, active, makeActive, duplicate, remove, rename }: { env: EnvDef; active: boolean; makeActive: () => void; duplicate: () => void; remove?: () => void; rename: (n: string) => void }): JSX.Element {
  const { project, path, update, secrets, refreshSecrets, say, info } = useStore();
  const p = project!;
  const set = (fn: (e: EnvDef) => EnvDef) => update((x) => ({ ...x, envs: x.envs.map((e) => (e.name === env.name ? fn(e) : e)) }));
  const [name, setName] = useState(env.name);
  const [confirmWrites, setConfirmWrites] = useState('');
  const prod = envKind(env.name) === 'production';
  const toolsOffered = p.tools.filter((t) => offered(t, env)).length;
  const hidden = p.tools.filter((t) => t.enabled && t.safety !== 'read').length;
  useEffect(() => void refreshSecrets(), [refreshSecrets]);

  const commitName = () => {
    const n = slug(name);
    if (!n || n === env.name) return setName(env.name);
    if (p.envs.some((e) => e.name === n)) {
      say(`There is already an environment called ${n}.`, true);
      return setName(env.name);
    }
    set((e) => ({ ...e, name: n }));
    rename(n);
  };

  const setAuth = (auth: AuthSpec) => set((e) => ({ ...e, auth }));
  const prefix = varPrefix(p.name);
  const a = env.auth;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <EnvChip name={env.name} writes={env.allowWrites} />
        <span className="flex-1" />
        {active ? <span className="text-[12px] text-ink-faint">Active — requests go here</span> : <button className="btn" onClick={makeActive}>Make active</button>}
        <button className="btn" onClick={duplicate}>Duplicate</button>
        {remove && <button className="btn text-bad" onClick={remove}>Delete</button>}
      </div>

      <section className="grid grid-cols-[200px_1fr] gap-4">
        <div>
          <label className="label">Name</label>
          <input className="field font-mono" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        </div>
        <div>
          <label className="label">Base URL</label>
          <input className="field font-mono" placeholder="https://api.acme.example/v1" value={env.baseUrl} onChange={(e) => set((x) => ({ ...x, baseUrl: e.target.value.trim() }))} />
          {/\{\{/.test(env.baseUrl) && <div className="mt-1 truncate font-mono text-[11px] text-ink-faint">→ {fillVars(env.baseUrl, env)}</div>}
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-[13px] font-semibold">Sign-in</h3>
        <p className="mb-3 text-[12px] text-ink-muted">
          The project names the secret; its value stays on this Mac{info?.keychain ? ', in the keychain' : ''}. Agents and published copies never see it.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ['none', 'None'],
              ['bearer', 'Bearer token'],
              ['apiKey', 'API key'],
              ['basic', 'User + password'],
              ['wsse', 'WS-Security'],
              ['login', 'Log in with a request'],
              ['via', 'Another API'],
            ] as const
          ).map(([t, label]) => (
            <button
              key={t}
              onClick={() => {
                if (t === a.type) return;
                if (t === 'none') setAuth({ type: 'none' });
                if (t === 'bearer') setAuth({ type: 'bearer', tokenVar: `${prefix}_TOKEN` });
                if (t === 'apiKey') setAuth({ type: 'apiKey', in: 'header', name: 'X-API-Key', valueVar: `${prefix}_API_KEY` });
                if (t === 'basic') setAuth({ type: 'basic', userVar: `${prefix}_USER`, passVar: `${prefix}_PASSWORD` });
                if (t === 'wsse') setAuth({ type: 'wsse', userVar: `${prefix}_USER`, passVar: `${prefix}_PASSWORD` });
                if (t === 'via') {
                  const { projects, systems } = useStore.getState();
                  const mine = systems.find((x) => x.members.includes(path!));
                  const others = projects.filter((x) => x.path !== path && !x.missing);
                  const pick = (mine?.signedInBy && others.find((x) => x.name === mine.signedInBy)) || others.find((x) => /secur|auth|identity|login|sso|account/i.test(x.name)) || others[0];
                  setAuth({ type: 'via', api: pick?.name ?? '', path: pick?.path });
                }
                if (t === 'login') {
                  const guess = p.tools.find((x) => /login|signin|sign-in|auth|token|session/i.test(`${x.name} ${x.path}`)) ?? p.tools[0];
                  setAuth({ type: 'login', toolId: guess?.id ?? '', from: 'body', path: 'token', sendAs: 'bearer' });
                }
              }}
              className={`rounded-md border px-3 py-1.5 text-[12px] ${a.type === t ? 'border-accent bg-accent/10 font-semibold' : 'border-rule hover:bg-wash-strong'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mt-3 space-y-2">
          {a.type === 'bearer' && <SecretField label="Token" varName={a.tokenVar} onVar={(v) => setAuth({ ...a, tokenVar: v })} source={secrets[a.tokenVar]} path={path!} />}
          {a.type === 'apiKey' && (
            <>
              <div className="flex items-center gap-2 text-[12px]">
                <span className="w-24 text-ink-muted">Sent as</span>
                <select className="field w-28" value={a.in} onChange={(e) => setAuth({ ...a, in: e.target.value as 'header' | 'query' })}>
                  <option value="header">header</option>
                  <option value="query">query</option>
                </select>
                <input className="field w-56 font-mono" value={a.name} onChange={(e) => setAuth({ ...a, name: e.target.value })} />
              </div>
              <SecretField label="Key" varName={a.valueVar} onVar={(v) => setAuth({ ...a, valueVar: v })} source={secrets[a.valueVar]} path={path!} />
            </>
          )}
          {a.type === 'login' && <LoginFields env={env} a={a} setAuth={setAuth} />}
          {a.type === 'via' && <ViaFields env={env} a={a} setAuth={setAuth} />}
          {(a.type === 'none' || env.browserSession) && <BrowserSession env={env} set={set} />}
          {a.type === 'wsse' && (
            <>
              <p className="text-[11px] text-ink-faint">A WS-Security UsernameToken, sent in the SOAP envelope’s header of every SOAP request.</p>
              <SecretField label="User" varName={a.userVar} onVar={(v) => setAuth({ ...a, userVar: v })} source={secrets[a.userVar]} path={path!} />
              <SecretField label="Password" varName={a.passVar} onVar={(v) => setAuth({ ...a, passVar: v })} source={secrets[a.passVar]} path={path!} />
            </>
          )}
          {a.type === 'basic' && (
            <>
              <SecretField label="User" varName={a.userVar} onVar={(v) => setAuth({ ...a, userVar: v })} source={secrets[a.userVar]} path={path!} />
              <SecretField label="Password" varName={a.passVar} onVar={(v) => setAuth({ ...a, passVar: v })} source={secrets[a.passVar]} path={path!} />
            </>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-[13px] font-semibold">Variables</h3>
        <p className="mb-3 text-[12px] text-ink-muted">
          Plain values that differ by environment — a tenant, a region, an API version. Use them as <span className="font-mono">{'{{name}}'}</span> in the base URL, headers or paths. Not
          for secrets.
        </p>
        <KeyValues values={env.vars ?? {}} onChange={(vars) => set((e) => ({ ...e, vars }))} keyPlaceholder="tenant" valuePlaceholder="acme-west" />
      </section>

      <section>
        <h3 className="mb-1 text-[13px] font-semibold">Headers on every request</h3>
        <KeyValues values={env.headers ?? {}} onChange={(headers) => set((e) => ({ ...e, headers: Object.keys(headers).length ? headers : undefined }))} keyPlaceholder="X-Tenant" valuePlaceholder="{{tenant}}" />
      </section>

      <section className={`rounded-xl p-4 ${env.allowWrites ? (prod ? 'bg-bad/10' : 'bg-warn/10') : 'bg-wash'}`}>
        <div className="flex items-center gap-3">
          <Toggle
            on={env.allowWrites}
            onChange={(v) => {
              if (v && prod) {
                setConfirmWrites(' ');
                return;
              }
              set((e) => ({ ...e, allowWrites: v }));
            }}
            label="Allow writes"
          />
          <div className="flex-1 text-[12px]">
            <div className="font-semibold">{env.allowWrites ? 'Agents can change data here' : 'Read-only for agents'}</div>
            <div className="text-ink-muted">
              {toolsOffered} request{toolsOffered === 1 ? '' : 's'} offered.{' '}
              {env.allowWrites ? 'Destructive ones still need confirm: true.' : hidden ? `${hidden} that change data are hidden. You can still send them yourself from Requests.` : ''}
            </div>
          </div>
        </div>
        {confirmWrites && (
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmWrites.trim() !== env.name) return;
              set((x) => ({ ...x, allowWrites: true }));
              setConfirmWrites('');
            }}
          >
            <span className="text-[12px]">
              Type <b className="font-mono">{env.name}</b> to let agents write to production:
            </span>
            <input className="field w-40 font-mono" autoFocus value={confirmWrites.trim()} onChange={(e) => setConfirmWrites(e.target.value || ' ')} />
            <button className="btn text-bad" disabled={confirmWrites.trim() !== env.name}>Allow</button>
            <button type="button" className="text-[12px] text-ink-muted" onClick={() => setConfirmWrites('')}>Cancel</button>
          </form>
        )}
      </section>
    </div>
  );
}

const SOURCE_TEXT: Record<Exclude<SecretSource, null>, string> = {
  keychain: 'saved in keychain',
  env: 'from your shell',
  dotenv: 'from .env beside the project',
};

/// Signed in through overapi's browser: the person's own session on a web
/// app, as the environment's Cookie (and CSRF or token) headers.
function BrowserSession({ env, set }: { env: EnvDef; set: (fn: (e: EnvDef) => EnvDef) => void }): JSX.Element {
  const { project, path, say, refreshSecrets, info } = useStore();
  const p = project!;
  const [via, setVia] = useState<'overapi' | 'chrome'>(env.browserSession?.via ?? 'overapi');
  const [site, setSite] = useState(env.browserSession?.site ?? '');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<string | null>(null);
  const s = env.browserSession;
  const sent = Object.entries(env.headers ?? {}).filter(([, v]) => isSessionHeader(v));
  // The base URL moved to another site since signing in: that session
  // can't sign these requests.
  const moved = !!s && !!env.baseUrl && !sameSite(s.site, env.baseUrl);
  const newSite = siteGuess(env.baseUrl);

  const run = async (how: 'browser:signIn' | 'browser:session', at?: string) => {
    if (!env.baseUrl) return say(`${env.name} needs a base URL first — the API the web app calls.`, true);
    const target = (at || site || s?.site || '').trim();
    if (!target) return say('Give the web app’s address — where you sign in.', true);
    setBusy(true);
    const using = s?.via ?? via;
    if (how === 'browser:signIn') setWaiting(using === 'chrome' ? info?.chrome ?? 'Chrome' : 'the window that opened');
    const r = await window.overapi.invoke(how, path!, p, env.name, target, using);
    setBusy(false);
    setWaiting(null);
    if (!r.ok) return say(r.error, true);
    set((e) => ({ ...e, auth: r.headers.Authorization ? { type: 'none' } : e.auth, headers: { ...Object.fromEntries(Object.entries(e.headers ?? {}).filter(([, v]) => !isSessionHeader(v))), ...r.headers }, browserSession: { site: r.site, at: r.at, via: r.via } }));
    await refreshSecrets();
    say(`${env.name} signs in with your browser session now (${r.found.join(', ')}).`);
  };

  const stop = async () => {
    for (const [, v] of sent) {
      const name = v.match(/\$\{([A-Za-z0-9_]+)\}/)?.[1];
      // Another environment may still use it (a copy made before sign-ins
      // were per environment): leave it for that one.
      const shared = p.envs.some((o) => o.name !== env.name && Object.values(o.headers ?? {}).some((x) => x.includes(`\${${name}}`)));
      if (name && !shared) await window.overapi.invoke('secrets:set', path!, name, '');
    }
    set((e) => {
      const headers = Object.fromEntries(Object.entries(e.headers ?? {}).filter(([, v]) => !isSessionHeader(v)));
      const { browserSession: _gone, ...rest } = e;
      return { ...rest, headers: Object.keys(headers).length ? headers : undefined };
    });
    await refreshSecrets();
    say(`${env.name} no longer uses the browser session.`);
  };

  if (waiting) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/50 bg-accent/10 p-3 text-[12px]">
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
        </span>
        <span className="flex-1">
          <b>Waiting for you to sign in</b> in {waiting}. When you’re signed in, click <b>Done</b> — here or in the bar at the top of that window — and overapi keeps the session.
        </span>
        <button className="btn-primary" onClick={() => void window.overapi.invoke('browser:signInDone')}>
          Done
        </button>
      </div>
    );
  }
  if (s && moved) {
    return (
      <div className="rounded-xl border border-warn/40 bg-warn/[0.07] p-3 text-[12px]">
        <div className="flex items-center gap-2">
          <Icon name="alert" size={14} className="text-warn" />
          <b>This sign-in is for another site</b>
        </div>
        <p className="mt-1.5 text-ink-muted">
          It came from <span className="font-mono">{s.site.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>, but {env.name}’s requests now go to{' '}
          <span className="font-mono">{env.baseUrl.replace(/^https?:\/\//, '')}</span> — so it won’t sign them. Sign in where this environment points:
        </p>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <input className="field w-[300px] py-1 font-mono text-[12px]" value={site && site !== s.site ? site : newSite} onChange={(e) => setSite(e.target.value)} aria-label="Web app address" />
          <button className="btn-primary" disabled={busy} onClick={() => void run('browser:signIn', site && site !== s.site ? site : newSite)}>
            {busy ? 'Waiting for the window to close…' : 'Sign in there'}
          </button>
          <button className="btn text-bad" disabled={busy} onClick={() => void stop()}>
            Stop using the old one
          </button>
        </div>
      </div>
    );
  }
  if (s) {
    return (
      <div className="rounded-xl border border-accent/40 bg-accent/5 p-3 text-[12px]">
        <div className="flex items-center gap-2">
          <Icon name="globe" size={14} className="text-accent" />
          <b>Signed in through the browser</b>
          <span className="text-ink-faint">
            at <span className="font-mono">{s.site.replace(/^https?:\/\//, '').replace(/\/$/, '')}</span>
            {s.via === 'chrome' ? ` in ${info?.chrome ?? 'Chrome'}` : ''} · {new Date(s.at).toLocaleString()}
          </span>
        </div>
        <p className="mt-1.5 text-ink-muted">
          Sends {sent.map(([k]) => k).join(', ') || 'your session'} from the keychain. It’s your own session: it ends when the site ends it, and this environment can’t be published to overgo.
          When requests start coming back 401, sign in again.
        </p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy} onClick={() => void run('browser:signIn')}>
            Sign in again
          </button>
          <button className="btn" disabled={busy} title="Read the session again without opening the site — after you used it in a recording" onClick={() => void run('browser:session')}>
            Refresh from browser
          </button>
          <button className="btn text-bad" disabled={busy} onClick={() => void stop()}>
            Stop using it
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-dashed border-rule p-3 text-[12px]">
      <div className="font-medium">A web app with no API token?</div>
      <p className="mt-1 text-ink-muted">Sign in to it in overapi’s browser and use your session — the cookies, plus any CSRF or token header the app sends. Kept in the keychain; never published.</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <input className="field w-[300px] py-1 font-mono text-[12px]" placeholder="https://app.acme.example" value={site} onChange={(e) => setSite(e.target.value)} aria-label="Web app address" />
        {info?.chrome && (
          <select className="field w-auto py-1 text-[12px]" value={via} onChange={(e) => setVia(e.target.value as 'overapi' | 'chrome')} aria-label="Which browser">
            <option value="overapi">in overapi’s window</option>
            <option value="chrome">in {info.chrome} (with extensions)</option>
          </select>
        )}
        <button className="btn" disabled={busy || !site.trim()} onClick={() => void run('browser:signIn')}>
          {busy ? 'Waiting for the window to close…' : 'Sign in in the browser'}
        </button>
      </div>
    </div>
  );
}

/// Signed in by another API — usually the sign-in service of the system
/// this one belongs to. Its sign-in for the environment of the same name
/// goes on every request here.
function ViaFields({ env, a, setAuth }: { env: EnvDef; a: Extract<AuthSpec, { type: 'via' }>; setAuth: (x: AuthSpec) => void }): JSX.Element {
  const { projects, systems, path, project, open } = useStore();
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = systems.find((x) => x.members.includes(path!));
  const others = projects.filter((x) => x.path !== path && !x.missing);
  const inSystem = others.filter((x) => mine?.members.includes(x.path));
  const rest = others.filter((x) => !mine?.members.includes(x.path));
  const picked = others.find((x) => x.name === a.api);
  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2 text-[12px]">
        <span className="w-24 text-ink-muted">Signed in by</span>
        <select
          className="field w-72"
          value={a.api}
          onChange={(e) => {
            const x = others.find((o) => o.name === e.target.value);
            setAuth({ type: 'via', api: e.target.value, path: x?.path });
            setTest(null);
          }}
        >
          {!picked && <option value={a.api}>{a.api || 'Pick an API'}</option>}
          {inSystem.length > 0 && (
            <optgroup label={mine!.title}>
              {inSystem.map((x) => (
                <option key={x.path} value={x.name}>{x.title}</option>
              ))}
            </optgroup>
          )}
          <optgroup label={inSystem.length ? 'Other APIs' : 'APIs'}>
            {rest.map((x) => (
              <option key={x.path} value={x.name}>{x.title}</option>
            ))}
          </optgroup>
        </select>
        {picked && (
          <button className="text-[12px] text-accent hover:underline" onClick={() => void open(picked.path, 'envs')}>
            Open {picked.title}
          </button>
        )}
      </div>
      <p className="pl-[104px] text-[12px] leading-relaxed text-ink-muted">
        Every request here carries {picked?.title ?? 'that API'}’s sign-in for its <b>{env.name}</b> environment — whatever it uses: a login request (signed in once, refreshed when refused), a browser session or a token. Set it up there, once, for all the APIs it signs in.
      </p>
      <div className="flex items-center gap-2 pl-[104px]">
        <button
          className="btn"
          disabled={busy || !a.api}
          onClick={async () => {
            setBusy(true);
            const r = await window.overapi.invoke('auth:testVia', path!, project!, env.name);
            setBusy(false);
            setTest(r.ok ? { ok: true, text: `${r.from} signs these in — sends ${r.sends.join(', ')}` } : { ok: false, text: r.error });
          }}
        >
          {busy ? 'Checking…' : 'Check the sign-in'}
        </button>
        {test && <span className={`text-[12px] ${test.ok ? 'text-good' : 'text-warn'}`}>{test.ok ? '✓ ' : ''}{test.text}</span>}
        {test && !test.ok && <RenewButton path={path!} env={env.name} small />}
      </div>
    </div>
  );
}

function LoginFields({ env, a, setAuth }: { env: EnvDef; a: Extract<AuthSpec, { type: 'login' }>; setAuth: (x: AuthSpec) => void }): JSX.Element {
  const { project, path, secrets, say, selectTool, setTab, update } = useStore();
  const p = project!;
  const login = p.tools.find((t) => t.id === a.toolId);
  const creds = login ? [...new Set(exampleSecrets(login))] : [];
  const [status, setStatus] = useState<{ signedIn: boolean; at?: string; tail?: string } | null>(null);
  const refresh = () => void window.overapi.invoke('auth:status', path!, env.name).then(setStatus);
  useEffect(refresh, [path, env.name, a.toolId]);
  return (
    <div className="mt-1 space-y-3 rounded-xl border border-rule bg-wash p-4 text-[12px]">
      <div className="grid grid-cols-[150px_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
        <span className="text-ink-muted">1 · Log in by calling</span>
        <select className="field" value={a.toolId} onChange={(e) => setAuth({ ...a, toolId: e.target.value })}>
          {!login && <option value="">Pick a request…</option>}
          {p.tools.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} — {t.method} {t.path}
            </option>
          ))}
        </select>

        <span className="self-start pt-1 text-ink-muted">with</span>
        <div className="space-y-1.5">
          <p className="text-ink-faint">
            The values saved on {login ? <b className="text-ink">{login.name}</b> : 'it'} — its Params and Body. Write <span className="font-mono">{'${ACME_PASSWORD}'}</span> for a secret; the value comes from the keychain.
          </p>
          {creds.map((v) => (
            <SecretField key={v} label={v} varName={v} onVar={() => undefined} source={secrets[v]} path={path!} />
          ))}
          {login && (
            <button
              className="text-accent hover:underline"
              onClick={() => {
                if (!login.enabled) update((x) => x);
                selectTool(login.id);
                setTab('requests');
              }}
            >
              Open {login.name} to set its values →
            </button>
          )}
        </div>

        <span className="text-ink-muted">2 · The token is at</span>
        <div className="flex gap-2">
          <select className="field w-44" value={a.from} onChange={(e) => setAuth({ ...a, from: e.target.value as 'body' | 'header' })}>
            <option value="body">response body</option>
            <option value="header">a response header</option>
          </select>
          <input className="field font-mono" value={a.path} placeholder={a.from === 'body' ? 'data.access_token' : 'x-session-token'} onChange={(e) => setAuth({ ...a, path: e.target.value })} />
        </div>

        <span className="text-ink-muted">3 · Send it as</span>
        <div className="flex gap-2">
          <select className="field w-56" value={a.sendAs} onChange={(e) => setAuth({ ...a, sendAs: e.target.value as typeof a.sendAs })}>
            <option value="bearer">Authorization: Bearer …</option>
            <option value="header">a header</option>
            <option value="query">a query parameter</option>
            <option value="cookie">a cookie</option>
          </select>
          {a.sendAs !== 'bearer' && (
            <input
              className="field font-mono"
              value={a.name ?? ''}
              placeholder={a.sendAs === 'header' ? 'X-Auth-Token' : a.sendAs === 'query' ? 'token' : 'session'}
              onChange={(e) => setAuth({ ...a, name: e.target.value || undefined })}
            />
          )}
        </div>

        <span className="text-ink-muted">4 · Log in again</span>
        <div className="flex flex-wrap items-center gap-2 text-ink-muted">
          <span className="rounded-full border border-accent/50 px-2.5 py-0.5 text-[11px] text-ink">when there’s no token</span>
          <span className="rounded-full border border-accent/50 px-2.5 py-0.5 text-[11px] text-ink">on 401/403, then retry once</span>
          <span>and every</span>
          <input
            className="field w-16 py-0.5 text-right"
            type="number"
            min={1}
            value={a.refreshMinutes ?? ''}
            placeholder="—"
            onChange={(e) => setAuth({ ...a, refreshMinutes: Number(e.target.value) || undefined })}
          />
          <span>minutes</span>
        </div>
      </div>

      <div className={`flex items-center gap-3 rounded-lg px-3 py-2 ${status?.signedIn ? 'bg-good/10' : 'bg-wash-strong'}`}>
        <span className={`h-2 w-2 rounded-full ${status?.signedIn ? 'bg-good' : 'bg-ink-faint/50'}`} />
        <span className="flex-1 text-ink-muted">
          {status?.signedIn ? (
            <>
              <b className="text-ink">Signed in</b> {status.at ? new Date(status.at).toLocaleTimeString() : ''} · token ends ••••{status.tail}
            </>
          ) : (
            'Not signed in yet — it happens on the first request that needs it.'
          )}
        </span>
        <button
          className="btn"
          disabled={!login}
          onClick={async () => {
            const r = await window.overapi.invoke('auth:signIn', path!, p, env.name);
            if (r.ok) say(`Signed in — token ends ••••${r.tail}.`);
            else say(r.error, true);
            refresh();
          }}
        >
          Test sign-in
        </button>
      </div>
      <p className="text-[11px] text-ink-faint">{login ? `${login.name} is hidden from agents — it’s plumbing, not a tool.` : ''} Agents just call the API’s tools; overapi signs in first when it needs to.</p>
    </div>
  );
}

export function SecretField({ label, varName, onVar, source, path }: { label: string; varName: string; onVar: (v: string) => void; source: SecretSource | undefined; path: string }): JSX.Element {
  const { refreshSecrets, say } = useStore();
  const [value, setValue] = useState('');
  const save = async (v: string) => {
    const r = await window.overapi.invoke('secrets:set', path, varName, v);
    if (!r.ok) say(r.error ?? 'Not saved.', true);
    else say(v ? `${label} saved in the keychain.` : `${label} removed from the keychain.`);
    setValue('');
    void refreshSecrets();
  };
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="w-24 text-ink-muted">{label}</span>
      <input
        className="field flex-1"
        type="password"
        placeholder={source ? `•••••••• (${SOURCE_TEXT[source]})` : 'Paste the value'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && value && void save(value)}
      />
      <button className="btn" disabled={!value} onClick={() => void save(value)}>Save</button>
      {source === 'keychain' && <button className="text-[11px] text-ink-faint hover:text-bad" onClick={() => void save('')}>Remove</button>}
      <input
        className="field w-48 font-mono text-[11px] text-ink-muted"
        title="The variable name: what a published copy or a client’s env block sets"
        value={varName}
        onChange={(e) => onVar(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
      />
    </div>
  );
}

export function KeyValues({ values, onChange, keyPlaceholder, valuePlaceholder }: { values: Record<string, string>; onChange: (v: Record<string, string>) => void; keyPlaceholder: string; valuePlaceholder: string }): JSX.Element {
  const rows = Object.entries(values);
  const [k, setK] = useState('');
  const [v, setV] = useState('');
  return (
    <div className="space-y-1.5">
      {rows.map(([key, val]) => (
        <div key={key} className="flex items-center gap-2">
          <span className="field w-48 bg-wash font-mono text-[12px]">{key}</span>
          <input className="field flex-1 font-mono text-[12px]" value={val} onChange={(e) => onChange({ ...values, [key]: e.target.value })} />
          <button
            className="w-5 text-[14px] text-ink-faint hover:text-bad"
            onClick={() => {
              const next = { ...values };
              delete next[key];
              onChange(next);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!k.trim()) return;
          onChange({ ...values, [k.trim()]: v });
          setK('');
          setV('');
        }}
      >
        <input className="field w-48 font-mono text-[12px]" placeholder={keyPlaceholder} value={k} onChange={(e) => setK(e.target.value)} />
        <input className="field flex-1 font-mono text-[12px]" placeholder={valuePlaceholder} value={v} onChange={(e) => setV(e.target.value)} />
        <button className="btn w-auto shrink-0">Add</button>
      </form>
    </div>
  );
}

export { envVars };
