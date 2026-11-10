import { describe, expect, it } from 'vitest';
import { pasteIntent } from './pasteIntent';

describe('pasteIntent', () => {
  it.each([
    ["curl 'https://x.example/a' -H 'x: y'", 'curl'],
    ['https://api.acme.example/openapi.json', 'import'],
    ['https://api.acme.example/v3/api-docs', 'import'],
    ['https://docs.acme.example/guide/orders', 'docs'],
    ['{"openapi":"3.0.0"}', 'import'],
    ['openapi: 3.0.3\ninfo:\n  title: x', 'import'],
    ['GET /orders lists orders. '.repeat(10), 'docs'],
  ])('%s -> %s', (text, mode) => expect(pasteIntent(text)?.mode).toBe(mode));

  it('ignores short stray text', () => {
    expect(pasteIntent('hello')).toBeNull();
    expect(pasteIntent('   ')).toBeNull();
  });
});
