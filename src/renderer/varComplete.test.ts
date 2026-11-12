import { describe, expect, it } from 'vitest';
import { insertVar, matching, varAt } from './varComplete';

describe('varAt', () => {
  it('finds the variable being typed just before the caret', () => {
    expect(varAt('{{acm', 5)).toEqual({ kind: 'var', partial: 'acm', start: 0 });
    expect(varAt('Bearer ${ACME_T', 15)).toEqual({ kind: 'secret', partial: 'ACME_T', start: 7 });
    expect(varAt('id-{{', 5)).toEqual({ kind: 'var', partial: '', start: 3 });
  });

  it('is nothing once the braces are closed, or the caret is elsewhere', () => {
    expect(varAt('{{acme_user}}', 13)).toBeNull();
    expect(varAt('{{acm', 1)).toBeNull();
    expect(varAt('plain', 5)).toBeNull();
    expect(varAt('{{x', null)).toBeNull();
  });
});

describe('insertVar', () => {
  it('writes the name out in full and puts the caret after it', () => {
    expect(insertVar('{{ac', varAt('{{ac', 4)!, 4, 'acme_user')).toEqual({ value: '{{acme_user}}', caret: 13 });
    expect(insertVar('Bearer ${AC', varAt('Bearer ${AC', 11)!, 11, 'ACME_TOKEN')).toEqual({ value: 'Bearer ${ACME_TOKEN}', caret: 20 });
  });

  it('reuses what was already typed after the caret, and keeps the rest', () => {
    expect(insertVar('{{ac}}/x', varAt('{{ac}}/x', 4)!, 4, 'acme_user')).toEqual({ value: '{{acme_user}}/x', caret: 13 });
    expect(insertVar('a {{ b', varAt('a {{ b', 4)!, 4, 'tenant').value).toBe('a {{tenant}} b');
  });
});

describe('matching', () => {
  it('puts names starting with what is typed first, without repeats', () => {
    const items = [{ name: 'acme_user' }, { name: 'user_id' }, { name: 'user_id' }, { name: 'tenant' }];
    expect(matching(items, 'user').map((x) => x.name)).toEqual(['user_id', 'acme_user']);
    expect(matching(items, '').map((x) => x.name)).toEqual(['acme_user', 'user_id', 'tenant']);
  });
});
