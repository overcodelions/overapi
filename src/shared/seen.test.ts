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
    expect(s['content[].id'].map(({ v, label }) => ({ v, label }))).toEqual([
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
  it('keeps the record an id came from, so a picker can tell two apart', () => {
    expect(extractSeen(page)['content[].id'][0].row).toEqual({ id: 'g1', name: 'All partners', status: 'ACTIVE', clientId: 'c9', memberCount: 3 });
    // An id inside the list item: its own fields first, then the rest of the item.
    const board = { data: [{ playerMetadata: { id: '223094', name: 'Rowan Hale', team: { name: 'Acme City' } }, stats: { goals: 21 }, tags: ['x'] }] };
    expect(extractSeen(board)['data[].playerMetadata.id'][0].row).toEqual({
      id: '223094',
      name: 'Rowan Hale',
      'team.name': 'Acme City',
      'stats.goals': 21,
    });
    // A pointer to another record gets no row.
    expect(extractSeen(page)['content[].clientId'][0].row).toBeUndefined();
  });
  it('finds the record an id object names, and a name given in parts', () => {
    const players = {
      data: [
        { id: { competitionId: '8', seasonId: '2026', playerId: '232980' }, name: { firstName: 'Mara', lastName: 'Quill' }, position: 'Defender', currentTeam: { id: '91', name: 'Acme Rovers' } },
        { id: { competitionId: '8', seasonId: '2026', playerId: '427637' }, name: { firstName: 'Theo', lastName: 'Brandt' }, position: 'Midfielder', currentTeam: { id: '91', name: 'Acme Rovers' } },
      ],
    };
    const s = extractSeen(players);
    expect(s['data[].id.playerId'][0]).toMatchObject({ v: '232980', label: 'Mara Quill', row: { position: 'Defender', 'currentTeam.name': 'Acme Rovers' } });
    // Same on every row: doesn't name the row.
    expect(s['data[].id.competitionId']).toEqual([{ v: '8' }]);
    // One team, many players: the team keeps its own fields, not a player's.
    expect(s['data[].currentTeam.id']).toEqual([{ v: '91', label: 'Acme Rovers', row: { id: '91', name: 'Acme Rovers' } }]);
  });
  it('reads chain paths', () => expect(seenPath('content[0].id')).toBe('content[].id'));
});

describe('labels', () => {
  it('skips a name field that is itself an id', () => {
    const r = extractSeen({ content: [{ id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', name: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', description: 'Acme resellers' }] });
    expect(Object.values(r).flat()).toContainEqual(expect.objectContaining({ v: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', label: 'Acme resellers' }));
  });
});
