import { describe, expect, it } from 'vitest';
import { titleOf } from './RequestsTab';
import type { ToolDef } from '@shared/project';

const tool = (name: string, summary?: string): ToolDef => ({ id: `GET /${name}`, name, description: '', enabled: true, safety: 'read', method: 'GET', path: `/${name}`, params: [], bodyMode: 'none', ...(summary !== undefined ? { origin: { summary } } : {}) });

describe('titleOf', () => {
  it('uses a short summary from the spec', () => {
    expect(titleOf(tool('list_orders', '  Lists all orders  '))).toBe('Lists all orders');
  });

  it('ignores a summary that is too long, empty, or just the name', () => {
    expect(titleOf(tool('list_orders', 'x'.repeat(61)))).toBe('Orders');
    expect(titleOf(tool('list_orders', '   '))).toBe('Orders');
    expect(titleOf(tool('list_orders', 'list_orders'))).toBe('Orders');
  });

  it.each([
    ['list_order_lines', 'Order lines'],
    ['get_partner', 'One partner'],
    ['get_partner_2', 'One partner'],
    ['cancel_order', 'Cancel order'],
    ['list', 'List'],
    ['get', 'Get'],
    ['ping', 'Ping'],
  ])('%s -> %s', (name, title) => expect(titleOf(tool(name))).toBe(title));
});
