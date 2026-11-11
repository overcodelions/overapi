import { describe, expect, it } from 'vitest';
import { findList, summarize } from './ResponseTable';

const page = (content: unknown[]) => ({ content, pageable: { sort: [{ direction: 'ASC', property: 'name' }] }, sort: [{ direction: 'ASC', property: 'name' }], totalElements: content.length, number: 0, totalPages: 1 });

describe('the list in a response', () => {
  it('is the results, not the sort settings', () => {
    expect(findList(page([{ id: 'a', name: 'West' }]))?.path).toBe('content');
  });
  it('is the results even when they are empty', () => {
    const l = findList(page([]));
    expect(l?.path).toBe('content');
    expect(l?.rows).toEqual([]);
    expect(summarize(page([]), 'list_order_lines')).toBe('0 order lines');
  });
  it('is a top-level array', () => expect(findList([{ id: 1 }])?.rows.length).toBe(1));
});
