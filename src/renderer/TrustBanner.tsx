import { useEffect, useState } from 'react';
import { useStore } from './store';
import type { TrustSummary } from '@shared/trust';

// A project that's new to overapi, or changed outside it (a clone, a git
// pull), can't use your secrets until you've seen where they'd go. This is
// where you see it, once.
export function TrustBanner(): JSX.Element | null {
  const { project, path, say } = useStore();
  const [status, setStatus] = useState<{ trusted: boolean; summary: TrustSummary } | null>(null);
  const [later, setLater] = useState<string | null>(null);

  useEffect(() => {
    if (!project || !path) return setStatus(null);
    // After an edit here the app saves (and approves) first; ask once that's landed.
    const t = setTimeout(() => void window.overapi.invoke('trust:status', path, project).then(setStatus), 900);
    return () => clearTimeout(t);
  }, [project, path]);

  if (!project || !path || !status || status.trusted || later === path) return null;
  const { envs, warnings } = status.summary;
  const allow = async () => {
    await window.overapi.invoke('trust:allow', path, project);
    setStatus({ ...status, trusted: true });
    say(`${project.title} can use its secrets now.`);
  };
  return (
    <section role="alert" className="mx-3 mt-3 rounded-xl border border-warn/40 bg-warn/[0.07] p-4 text-[12.5px]">
      <h2 className="text-[13px] font-semibold">Review {project.title} before it uses your secrets</h2>
      <p className="mt-1 text-ink-muted">It’s new to overapi, or it changed outside the app. Until you allow it, nothing secret is sent — here or to agents. This is what it would do:</p>
      <ul className="mt-2.5 space-y-1">
        {envs.map((e) => (
          <li key={e.name} className="flex flex-wrap gap-x-2">
            <b>{e.name}</b>
            <span className="text-ink-muted">sends requests to</span>
            <span className="font-mono">{e.host}</span>
            <span className="text-ink-muted">· signs in with {e.signIn}</span>
            {e.secrets.length > 0 && (
              <span className="text-ink-muted">
                · uses <span className="font-mono">{e.secrets.join(', ')}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
      {warnings.length > 0 && (
        <ul className="mt-2.5 list-disc space-y-1 pl-5 text-warn">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className="btn-primary" onClick={() => void allow()}>
          Allow
        </button>
        <button type="button" className="btn" onClick={() => setLater(path)}>
          Not now
        </button>
        <span className="text-[11.5px] text-ink-faint">Only allow APIs you trust to receive these secrets.</span>
      </div>
    </section>
  );
}
