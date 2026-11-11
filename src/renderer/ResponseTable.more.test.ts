import { describe, expect, it } from 'vitest';
import { findList, nounFor, summarize } from './ResponseTable';

describe('findList, more', () => {
  it('is nothing for scalars, empty arrays and arrays of non-objects', () => {
    expect(findList(null)).toBeNull();
    expect(findList('x')).toBeNull();
    expect(findList([])).toBeNull();
    expect(findList([1, 2])).toBeNull();
    expect(findList([[1]])).toBeNull();
    expect(findList({ a: 1 })).toBeNull();
  });

  it('takes a results key whatever its case', () => {
    expect(findList({ Items: [{ a: 1 }], other: [{ b: 1 }, { b: 2 }] })?.path).toBe('Items');
  });

  it('otherwise takes the biggest list one or two levels in, never paging or links', () => {
    const json = { meta: { pages: [{ n: 1 }, { n: 2 }, { n: 3 }] }, _links: [{ href: 'a' }, { href: 'b' }, { href: 'c' }], response: { body: { teams: [{ id: 1 }, { id: 2 }] }, few: [{ id: 1 }] } };
    expect(findList(json)).toEqual({ path: 'response.body.teams', rows: [{ id: 1 }, { id: 2 }] });
  });

  it('does not look deeper than two levels', () => {
    expect(findList({ a: { b: { c: { d: [{ x: 1 }] } } } })).toBeNull();
  });
});

describe('nounFor', () => {
  it.each([
    ['list_order_lines', '', 'order lines'],
    ['search_teams_by_name', '', 'teams'],
    ['find_players_in_squad', '', 'players'],
    ['get_partner', '', 'partner'],
    ['query_x', '', 'x'],
    ['create_order', 'data.orders', 'orders'],
    ['create_order', '', 'items'],
    ['list_for_x', '', 'items'],
  ])('%s at %j -> %s', (name, path, noun) => expect(nounFor(name, path)).toBe(noun));
});

describe('summarize, more', () => {
  it('is nothing when there is no list', () => expect(summarize({ a: 1 }, 'list_x')).toBeNull());

  it('says one in the singular', () => {
    expect(summarize([{ id: 1 }], 'list_teams')).toBe('1 team');
  });

  it('says how many of the total, and which page', () => {
    expect(summarize({ data: [{ id: 1 }, { id: 2 }], total: 1234, page: 3, total_pages: 5 }, 'list_teams')).toBe('2 teams of 1,234 · page 3 of 5');
    expect(summarize({ content: [{ id: 1 }, { id: 2 }], totalElements: 40, number: 0, totalPages: 20 }, 'list_teams')).toBe('2 teams of 40 · page 1 of 20');
    expect(summarize({ items: [{ id: 1 }, { id: 2 }], count: 2, page: 1, pages: 1 }, 'list_teams')).toBe('2 teams');
    expect(summarize({ items: [{ id: 1 }, { id: 2 }], totalCount: '9', page: 1 }, 'list_teams')).toBe('2 teams');
    expect(summarize({ items: [{ id: 1 }, { id: 2 }], total_count: 3 }, 'list_teams')).toBe('2 teams of 3');
  });
});

describe('rows made of nested objects', () => {
  it('opens them up into columns, name first, then what it was sorted by', async () => {
    const { tableColumns } = await import('./ResponseTable');
    const stats = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`stat${i}`, i]));
    const rows = [1, 2].map((n) => ({
      playerMetadata: { id: `p${n}`, name: `Player ${n}`, firstName: 'A', position: 'Forward', currentTeam: { id: 't1', name: 'Acme FC' } },
      stats: { ...stats, goals: n * 3 },
    }));
    const cols = tableColumns(rows, ['goals']);
    expect(cols[0]).toBe('playerMetadata.name');
    expect(cols).toContain('stats.goals');
    expect(cols.indexOf('stats.goals')).toBeLessThan(3);
    expect(cols).not.toContain('playerMetadata.firstName');
    expect(cols.length).toBeLessThanOrEqual(7);
  });
  it('has no columns for rows with nothing tabular', async () => {
    const { tableColumns } = await import('./ResponseTable');
    expect(tableColumns([{ a: [1, 2] }, { a: [3] }])).toEqual([]);
  });
});
