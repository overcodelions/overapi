import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GUIDES, MORE_HELP } from './help';

describe('help links', () => {
  it('every guide is a file in this repo', () => {
    for (const g of GUIDES) expect(fs.existsSync(path.resolve(__dirname, '..', '..', g.doc!)), g.doc).toBe(true);
  });

  it('every link is https on the overapi repo', () => {
    for (const l of [...GUIDES, ...MORE_HELP]) expect(l.url).toMatch(/^https:\/\/github\.com\/overcodelions\/overapi\//);
  });
});
