import { useState } from 'react';
import { useStore } from './store';
import { Sheet } from './ui';

/// Deleting an API: says exactly what goes, and lets the files go to the
/// Trash (recoverable) or stay where they are.
export function DeleteApiSheet({ path, title }: { path: string; title: string }): JSX.Element {
  const { openSheet, refreshProjects, close, say, path: openPath } = useStore();
  const [trash, setTrash] = useState(true);
  const [busy, setBusy] = useState(false);
  const folder = path.replace(/\/overapi\.json$/, '').replace(/^\/Users\/[^/]+/, '~');
  return (
    <Sheet
      title={`Delete ${title}?`}
      onClose={() => openSheet(null)}
      footer={
        <>
          <button className="btn" onClick={() => openSheet(null)}>Cancel</button>
          <button
            className="btn-primary !bg-bad"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const r = await window.overapi.invoke('projects:delete', path, { trash });
              setBusy(false);
              openSheet(null);
              if (openPath === path) close();
              await refreshProjects();
              if (r.ok) say(`Deleted ${title}${r.removed.length ? ` and removed ${r.removed.join(', ')} from Claude Code` : ''}${trash ? ' — its folder is in the Trash' : ''}.`);
              else say(r.error, true);
            }}
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </>
      }
    >
      <ul className="space-y-1.5 text-[13px] text-ink-muted">
        <li>• Taken out of Claude Code and overcli, in every environment it was added to.</li>
        <li>• Its secrets leave the keychain, and its request history is cleared.</li>
        <li>• It comes off the list here.</li>
        <li>• If it was published to overgo, it stays there until an admin removes it under Setup → APIs.</li>
      </ul>
      <label className="mt-4 flex items-start gap-2 rounded-lg bg-wash p-3 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={trash} onChange={(e) => setTrash(e.target.checked)} />
        <span>
          Also move its folder to the Trash — <span className="font-mono text-[12px]">{folder}</span>, with its overapi.json and .env. You can put it back from the Trash. Off: the
          files stay, and you can open them again later.
        </span>
      </label>
    </Sheet>
  );
}
