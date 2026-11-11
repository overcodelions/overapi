import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { findList, flatten } from './ResponseTable';

// A response as a chart — only when its shape is a chart: a label and a
// number (ranked bars), or a date and a number (a line). One measure at a
// time, one hue, no legend: the title names what's shown. Anything else
// gets no chart at all.

const LABEL = /^(name|title|label|displayName|display_name|fullName|full_name|username|subject|summary|shortName|short_name)$/i;
const ID = /(^id$|_id$|Id$|^uuid$|^key$|^code$)/;
const ISO = /^\d{4}-\d{2}-\d{2}(T|$)/;
const last = (k: string) => k.split('.').pop()!;
const MAX_BARS = 20;

export type ChartSpec = { kind: 'bar'; label: string; measures: string[] } | { kind: 'line'; time: string; measures: string[] };

/// What a list could be drawn as, if anything.
export function chartSpec(rows: Record<string, unknown>[], prefer: string[] = []): ChartSpec | null {
  if (rows.length < 2) return null;
  const flat = rows.slice(0, 500).map((r) => flatten(r));
  const keys = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  const share = (k: string, test: (v: unknown) => boolean) => flat.filter((r) => test(r[k])).length / flat.length;
  const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const wanted = new Set(prefer.map((x) => x.toLowerCase()));
  const measures = keys
    .filter((k) => !ID.test(last(k)) && share(k, isNum) >= 0.8 && new Set(flat.map((r) => r[k])).size > 1)
    .sort((a, b) => Number(wanted.has(last(b).toLowerCase())) - Number(wanted.has(last(a).toLowerCase())));
  if (!measures.length) return null;
  const time = keys.find((k) => share(k, (v) => typeof v === 'string' && ISO.test(v)) >= 0.8);
  if (time) return { kind: 'line', time, measures };
  const strings = keys.filter((k) => share(k, (v) => typeof v === 'string' && v.length > 0 && v.length <= 60) >= 0.8 && !ID.test(last(k)));
  const label = strings.filter((k) => LABEL.test(last(k))).sort((a, b) => a.split('.').length - b.split('.').length)[0] ?? strings.find((k) => new Set(flat.map((r) => r[k])).size === flat.length);
  return label ? { kind: 'bar', label, measures } : null;
}

const fmt = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : Number.isInteger(n) ? String(n) : n.toFixed(2));
const words = (k: string) =>
  last(k)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();

/// Round numbers for the axis: 0 … a little past the top.
function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const step = Math.pow(10, Math.floor(Math.log10(max))) * ([1, 2, 5].find((m) => max / (Math.pow(10, Math.floor(Math.log10(max))) * m) <= 5) ?? 10);
  const out: number[] = [];
  for (let t = 0; t <= max + step / 2; t += step) out.push(t);
  return out;
}

function useWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function ResponseChart({ json, prefer = [] }: { json: unknown; prefer?: string[] }): JSX.Element | null {
  const list = useMemo(() => findList(json), [json]);
  const spec = useMemo(() => (list ? chartSpec(list.rows, prefer) : null), [list, prefer.join(',')]);
  const [measure, setMeasure] = useState<string | null>(null);
  useEffect(() => setMeasure(null), [spec?.measures.join(',')]);
  if (!list || !spec) return null;
  const m = measure && spec.measures.includes(measure) ? measure : spec.measures[0];
  const flat = list.rows.map((r) => flatten(r));
  return (
    <div className="rounded-lg border border-rule bg-surface p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h4 className="text-[13px] font-semibold text-ink">
          {words(m)}
          <span className="font-normal text-ink-muted"> {spec.kind === 'bar' ? `by ${words(spec.label)}` : 'over time'}</span>
        </h4>
        <span className="flex-1" />
        {spec.measures.length > 1 && (
          <label className="flex items-center gap-1.5 text-[11.5px] text-ink-muted">
            Show
            <select className="field h-7 w-auto py-0 text-[12px]" value={m} onChange={(e) => setMeasure(e.target.value)}>
              {spec.measures.slice(0, 40).map((k) => (
                <option key={k} value={k}>
                  {words(k)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {spec.kind === 'bar' ? <Bars rows={flat} label={spec.label} measure={m} /> : <Line rows={flat} time={spec.time} measure={m} />}
    </div>
  );
}

/// Ranked horizontal bars: the label reads in full, the biggest on top.
function Bars({ rows, label, measure }: { rows: Record<string, unknown>[]; label: string; measure: string }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const data = rows
    .map((r) => ({ label: String(r[label] ?? ''), v: Number(r[measure]) }))
    .filter((d) => Number.isFinite(d.v))
    .sort((a, b) => b.v - a.v);
  const shown = data.slice(0, MAX_BARS);
  const min = Math.min(0, ...shown.map((d) => d.v));
  const axis = ticks(Math.max(...shown.map((d) => d.v), 0));
  const top = axis[axis.length - 1] || 1;
  const pct = (v: number) => ((v - min) / (top - min)) * 100;
  return (
    <div>
      <div className="space-y-[2px]">
        {shown.map((d, i) => (
          <div
            key={i}
            className={`grid grid-cols-[minmax(90px,180px)_minmax(0,1fr)_56px] items-center gap-2.5 rounded px-1 ${hover === i ? 'bg-wash' : ''}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="truncate text-[12px] text-ink" title={d.label}>
              {d.label}
            </span>
            <div className="relative h-[18px]">
              {axis.map((t) => (
                <span key={t} aria-hidden className="absolute bottom-0 top-0 w-px bg-rule/70" style={{ left: `${pct(t)}%` }} />
              ))}
              <span
                className="absolute bottom-[3px] top-[3px] rounded-r-[4px]"
                style={{
                  left: `${pct(Math.min(0, d.v))}%`,
                  width: `${Math.max(0.5, Math.abs(pct(d.v) - pct(0)))}%`,
                  background: 'rgb(var(--c-chart))',
                  opacity: hover === null || hover === i ? 1 : 0.55,
                }}
              />
            </div>
            {/* The top value, and whichever bar is under the pointer. */}
            <span className={`text-right font-mono text-[11.5px] tabular-nums ${i === 0 || hover === i ? 'text-ink' : 'text-transparent'}`}>{fmt(d.v)}</span>
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-[minmax(90px,180px)_minmax(0,1fr)_56px] gap-2.5 px-1">
        <span />
        <div className="relative h-4">
          {axis.map((t) => (
            <span key={t} className="absolute -translate-x-1/2 font-mono text-[10px] text-ink-faint" style={{ left: `${pct(t)}%` }}>
              {fmt(t)}
            </span>
          ))}
        </div>
      </div>
      {data.length > MAX_BARS && (
        <p className="mt-2 text-[11px] text-ink-faint">
          The top {MAX_BARS} of {data.length} — the table has them all.
        </p>
      )}
    </div>
  );
}

/// A measure over time: one 2px line, a crosshair and tooltip on hover.
function Line({ rows, time, measure }: { rows: Record<string, unknown>[]; time: string; measure: string }): JSX.Element {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const data = rows
    .map((r) => ({ t: new Date(String(r[time])).getTime(), v: Number(r[measure]) }))
    .filter((d) => Number.isFinite(d.t) && Number.isFinite(d.v))
    .sort((a, b) => a.t - b.t);
  const H = 200;
  const pad = { l: 40, r: 12, t: 10, b: 22 };
  const w = Math.max(200, width);
  const t0 = data[0]?.t ?? 0;
  const t1 = data[data.length - 1]?.t ?? 1;
  const axis = ticks(Math.max(...data.map((d) => d.v), 0));
  const top = axis[axis.length - 1] || 1;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(d.t).toFixed(1)},${y(d.v).toFixed(1)}`).join(' ');
  const date = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const h = hover !== null ? data[hover] : null;
  return (
    <div ref={ref} className="relative">
      <svg
        width={w}
        height={H}
        role="img"
        aria-label={`${words(measure)} over time, ${data.length} points`}
        onMouseMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - box.left;
          let best = 0;
          data.forEach((d, i) => {
            if (Math.abs(x(d.t) - px) < Math.abs(x(data[best].t) - px)) best = i;
          });
          setHover(data.length ? best : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {axis.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} stroke="rgb(var(--c-rule))" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" className="fill-ink-faint font-mono" fontSize={10}>
              {fmt(t)}
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 6} className="fill-ink-faint font-mono" fontSize={10}>
          {date(t0)}
        </text>
        <text x={w - pad.r} y={H - 6} textAnchor="end" className="fill-ink-faint font-mono" fontSize={10}>
          {date(t1)}
        </text>
        <path d={path} fill="none" stroke="rgb(var(--c-chart))" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {h && (
          <>
            <line x1={x(h.t)} x2={x(h.t)} y1={pad.t} y2={H - pad.b} stroke="rgb(var(--c-rule-strong))" strokeWidth={1} />
            <circle cx={x(h.t)} cy={y(h.v)} r={4.5} fill="rgb(var(--c-chart))" stroke="rgb(var(--c-surface))" strokeWidth={2} />
          </>
        )}
      </svg>
      {h && (
        <div className="pointer-events-none absolute top-1 rounded-md border border-rule-strong bg-surface-elevated px-2 py-1 text-[11.5px] shadow-lg" style={{ left: Math.min(x(h.t) + 10, w - 150) }}>
          <div className="text-ink-muted">{new Date(h.t).toLocaleString()}</div>
          <div className="font-mono text-ink">
            {words(measure)} {fmt(h.v)}
          </div>
        </div>
      )}
    </div>
  );
}

/// How a request has been answering lately: response time per call, oldest
/// to newest, failures marked — so "is this getting slow or failing more?"
/// is a glance, not a load test.
export function LatencyTrend({ entries }: { entries: { at: string; ms?: number; ok: boolean; status?: number }[] }): JSX.Element | null {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const data = entries
    .filter((e) => typeof e.ms === 'number')
    .slice(0, 40)
    .reverse();
  if (data.length < 3) return null;
  const H = 56;
  const pad = 4;
  const w = Math.max(160, width);
  const max = Math.max(...data.map((d) => d.ms!), 1);
  const x = (i: number) => pad + (i / (data.length - 1)) * (w - pad * 2);
  const y = (ms: number) => pad + (1 - ms / max) * (H - pad * 2);
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.ms!).toFixed(1)}`).join(' ');
  const sorted = data.map((d) => d.ms!).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const failed = data.filter((d) => !d.ok).length;
  const h = hover !== null ? data[hover] : null;
  return (
    <div className="mb-3 rounded-lg border border-rule bg-surface px-3 py-2.5">
      <div className="mb-1.5 flex items-baseline gap-2 text-[12px]">
        <span className="font-semibold text-ink">Response time</span>
        <span className="text-ink-muted">
          last {data.length} calls · median {median} ms · slowest {max} ms
        </span>
        <span className="flex-1" />
        {failed > 0 && (
          <span className="flex items-center gap-1 text-[11.5px] text-bad">
            <span aria-hidden>●</span> {failed} failed
          </span>
        )}
      </div>
      <div ref={ref} className="relative">
        <svg
          width={w}
          height={H}
          role="img"
          aria-label={`Response time over the last ${data.length} calls, median ${median} ms`}
          onMouseMove={(e) => {
            const px = e.clientX - (e.currentTarget as SVGSVGElement).getBoundingClientRect().left;
            setHover(Math.max(0, Math.min(data.length - 1, Math.round(((px - pad) / (w - pad * 2)) * (data.length - 1)))));
          }}
          onMouseLeave={() => setHover(null)}
        >
          <line x1={pad} x2={w - pad} y1={y(median)} y2={y(median)} stroke="rgb(var(--c-rule-strong))" strokeDasharray="3 3" strokeWidth={1} />
          <path d={path} fill="none" stroke="rgb(var(--c-chart))" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {data.map((d, i) => (!d.ok ? <circle key={i} cx={x(i)} cy={y(d.ms!)} r={4} fill="rgb(var(--c-bad))" stroke="rgb(var(--c-surface))" strokeWidth={2} /> : null))}
          {h && hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="rgb(var(--c-rule-strong))" strokeWidth={1} />
              <circle cx={x(hover)} cy={y(h.ms!)} r={4} fill={h.ok ? 'rgb(var(--c-chart))' : 'rgb(var(--c-bad))'} stroke="rgb(var(--c-surface))" strokeWidth={2} />
            </>
          )}
        </svg>
        {h && hover !== null && (
          <div
            className="pointer-events-none absolute -top-1 rounded-md border border-rule-strong bg-surface-elevated px-2 py-1 text-[11.5px] shadow-lg"
            style={{ left: Math.min(x(hover) + 10, w - 170) }}
          >
            <span className="font-mono text-ink">{h.ms} ms</span>
            <span className={`ml-1.5 font-mono ${h.ok ? 'text-good' : 'text-bad'}`}>{h.status ?? (h.ok ? 'ok' : 'failed')}</span>
            <span className="ml-1.5 text-ink-muted">{new Date(h.at).toLocaleTimeString()}</span>
          </div>
        )}
      </div>
    </div>
  );
}
