import { describe, expect, it } from 'vitest';
import { extractSeen, mergeSeen, seenPath } from './seen';

describe('seen values', () => {
  const page = {
    content: [
      { id: 'g1', name: 'All partners', status: 'ACTIVE', clientId: 'c9', memberCount: 3 },
      { id: 'g2', name: 'Top partners', status: 'PAUSED', clientId: 'c9' },
    ],
    totalElements: 2,
  };
  it('keeps ids with the name beside them, and small sets of statuses', () => {
    const s = extractSeen(page);
    expect(s['content[].id']).toEqual([
      { v: 'g1', label: 'All partners' },
      { v: 'g2', label: 'Top partners' },
    ]);
    expect(s['content[].clientId']).toEqual([{ v: 'c9' }]);
    expect(s['content[].status']).toEqual([{ v: 'ACTIVE' }, { v: 'PAUSED' }]);
    expect(s['totalElements']).toBeUndefined();
    expect(s['content[].memberCount']).toBeUndefined();
  });
  it('puts the newest first without repeats', () => {
    const merged = mergeSeen({ 'content[].id': [{ v: 'g0' }, { v: 'g1' }] }, extractSeen(page));
    expect(merged['content[].id'].map((x) => x.v)).toEqual(['g1', 'g2', 'g0']);
  });
  it('reads chain paths', () => expect(seenPath('content[0].id')).toBe('content[].id'));
});
