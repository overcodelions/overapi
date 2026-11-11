import { describe, expect, it } from 'vitest';
import { pasteIntent } from './pasteIntent';

describe('pasteIntent, more', () => {
  it.each([
    ['curl.exe "https://x.example"', 'curl'],
    ['CURL https://x.example', 'curl'],
    ['https://x.example/spec.yaml?v=2', 'import'],
    ['https://x.example/export.har', 'import'],
    ['https://x.example/swagger-ui/index.html', 'import'],
    ['https://x.example/postman/collection', 'import'],
    ['[{"a":1}]', 'import'],
    ['# notes\nswagger: "2.0"', 'import'],
  ])('%s -> %s', (text, mode) => expect(pasteIntent(text)?.mode).toBe(mode));

  it('trims what it prefills', () => {
    expect(pasteIntent('  https://docs.acme.example/a  ')).toEqual({ mode: 'docs', prefill: 'https://docs.acme.example/a' });
  });

  it('does not take curling or a URL with spaces after it for a request', () => {
    expect(pasteIntent('curling is fun')).toBeNull();
    expect(pasteIntent('https://x.example see this')).toBeNull();
  });

  it('treats 200 characters of prose as docs, 199 as nothing', () => {
    expect(pasteIntent('a'.repeat(200))?.mode).toBe('docs');
    expect(pasteIntent('a'.repeat(199))).toBeNull();
  });
});
