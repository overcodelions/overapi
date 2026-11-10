// A small stroke icon set, drawn to one grid (24, 1.75 stroke) so they sit
// together. Inline SVG: no icon font, nothing fetched.

const PATHS = {
  overview: 'M4 5h7v6H4zM13 5h7v3h-7zM13 10h7v9h-7zM4 13h7v6H4z',
  requests: 'M5 7h14M5 12h14M5 17h9',
  envs: 'M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5M3 17.5l9 5 9-5',
  publish: 'M12 15V4M7 9l5-5 5 5M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  plus: 'M12 5v14M5 12h14',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  bot: 'M12 4V2M8 4h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM9 10h.01M15 10h.01M9.5 14h5M2 10v3M22 10v3',
  plug: 'M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0V7ZM12 17v5',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6ZM14 3v6h6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 1 1 8 0v4',
  key: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v-3h2.5M15 7h.01',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  x: 'M6 6l12 12M18 6 6 18',
  chevron: 'M9 6l6 6-6 6',
  send: 'M5 12h13M13 6l6 6-6 6',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  laptop: 'M4 5h16v11H4zM2 19h20',
  building: 'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M8 7h4M8 11h4M8 15h4M3 21h18',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${className}`} aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  );
}

/// A coloured tile with an API's initial — how the sidebar tells APIs
/// apart at a glance, the way overcli marks its projects.
/// Whole class strings, never assembled: Tailwind only generates classes it
/// can read verbatim in the source.
const TILE = [
  'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
];

export function Monogram({ name, size = 22 }: { name: string; size?: number }): JSX.Element {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const letter = (name.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-md font-display font-semibold ${TILE[h % TILE.length]}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
    >
      {letter}
    </span>
  );
}
