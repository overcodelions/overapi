// The engine and the CLI run under plain Node — a published server must
// work on a machine with no app installed. One `import ... from 'electron'`
// anywhere under src/core, src/cli or src/shared breaks that silently, so
// this fails the build instead.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe('no electron outside the app', () => {
  for (const area of ['core', 'cli', 'shared']) {
    it(`src/${area} never imports electron`, () => {
      const offenders = files(path.join(__dirname, '..', area)).filter((f) => /from\s+['"]electron['"]|require\(['"]electron['"]\)/.test(fs.readFileSync(f, 'utf8')));
      expect(offenders).toEqual([]);
    });
  }
});
