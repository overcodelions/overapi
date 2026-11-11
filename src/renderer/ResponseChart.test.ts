import { describe, expect, it } from 'vitest';
import { chartSpec } from './ResponseChart';

describe('what a response could be charted as', () => {
  it('ranked bars for a name and numbers, the sort key first', () => {
    const rows = [1, 2, 3].map((n) => ({ playerMetadata: { id: `p${n}`, name: `Player ${n}` }, stats: { goals: n * 2, shots: 10 - n, played: 5 } }));
    const spec = chartSpec(rows, ['shots']);
    expect(spec?.kind).toBe('bar');
    expect(spec && 'label' in spec && spec.label).toBe('playerMetadata.name');
    expect(spec?.measures[0]).toBe('stats.shots');
    // A constant ("played: 5") and ids are never measures.
    expect(spec?.measures).not.toContain('stats.played');
  });
  it('a line for dates and numbers', () => {
    const rows = ['2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z', '2026-01-15T00:00:00Z'].map((d, i) => ({ kickoff: d, attendance: 50000 + i * 10 }));
    expect(chartSpec(rows)).toEqual({ kind: 'line', time: 'kickoff', measures: ['attendance'] });
  });
  it('nothing when there is no number, no label, or a single row', () => {
    expect(chartSpec([{ name: 'a' }, { name: 'b' }])).toBeNull();
    expect(chartSpec([{ x: 1 }, { x: 2 }])).toBeNull();
    expect(chartSpec([{ name: 'a', v: 1 }])).toBeNull();
  });
});
