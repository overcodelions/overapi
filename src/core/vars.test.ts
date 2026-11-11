import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dotenvBeside, parseDotenv, varSource } from './vars';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'overapi-vars-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('parseDotenv', () => {
  it('reads plain, exported, spaced and empty values', () => {
    expect(parseDotenv('A=1\nexport B=two\n  C = three  \nD=\nE')).toEqual({ A: '1', B: 'two', C: 'three', D: '' });
  });

  it('skips comments, blank lines and names that are not names', () => {
    expect(parseDotenv('# a comment\n\n1BAD=x\nBAD-NAME=y\nGOOD_1=z')).toEqual({ GOOD_1: 'z' });
  });

  it('handles CRLF line endings', () => {
    expect(parseDotenv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });

  it('strips an inline comment from an unquoted value, but keeps a # inside one', () => {
    expect(parseDotenv('A=value # the comment\nB=pass#word')).toEqual({ A: 'value', B: 'pass#word' });
  });

  it('unquotes double quotes with \\n and \\" escapes', () => {
    expect(parseDotenv('A="line1\\nline2"\nB="say \\"hi\\""\nC="# not a comment"')).toEqual({ A: 'line1\nline2', B: 'say "hi"', C: '# not a comment' });
  });

  it('unquotes single quotes literally', () => {
    expect(parseDotenv("A='raw\\nvalue'\nB=' spaced '")).toEqual({ A: 'raw\\nvalue', B: ' spaced ' });
  });

  it('lets a later line win', () => {
    expect(parseDotenv('A=1\nA=2')).toEqual({ A: '2' });
  });

  // BUG: a quoted value followed by an inline comment keeps its quotes —
  // `A="secret" # note` parses to `"secret"` (quotes included), because the
  // quote check runs before the comment is stripped.
  it('unquotes a quoted value that has an inline comment after it', () => {
    expect(parseDotenv('A="secret" # note')).toEqual({ A: 'secret' });
  });
});

describe('dotenvBeside', () => {
  it('reads the .env in the project file’s folder', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, '.env'), 'ACME_TOKEN=tok-1\n');
    expect(dotenvBeside(path.join(d, 'overapi.json'))).toEqual({ ACME_TOKEN: 'tok-1' });
  });

  it('is empty when there is no .env', () => {
    expect(dotenvBeside(path.join(tmp(), 'overapi.json'))).toEqual({});
  });
});

describe('varSource', () => {
  it('prefers the process environment over .env', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, '.env'), 'ACME_TOKEN=from-file\nACME_ONLY_FILE=file-only\n');
    const get = varSource(path.join(d, 'overapi.json'), { ACME_TOKEN: 'from-env' });
    expect(get('ACME_TOKEN')).toBe('from-env');
    expect(get('ACME_ONLY_FILE')).toBe('file-only');
    expect(get('ACME_MISSING')).toBeUndefined();
  });

  it('treats an empty value or an unfilled <NAME> placeholder as unset', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, '.env'), 'ACME_TOKEN=real\nACME_KEY=<ACME_KEY>\n');
    const get = varSource(path.join(d, 'overapi.json'), { ACME_TOKEN: '<ACME_TOKEN>', ACME_KEY: '' });
    expect(get('ACME_TOKEN')).toBe('real');
    expect(get('ACME_KEY')).toBeUndefined();
  });

  it('keeps a value that only looks partly like a placeholder', () => {
    expect(varSource(undefined, { A: '<not a placeholder>', B: '<B>x' })('A')).toBe('<not a placeholder>');
    expect(varSource(undefined, { B: '<B>x' })('B')).toBe('<B>x');
  });

  it('reads only the environment without a project path, process.env by default', () => {
    expect(varSource(undefined, { X: '1' })('X')).toBe('1');
    process.env.OVERAPI_TEST_VAR_SOURCE = 'yes';
    try {
      expect(varSource()('OVERAPI_TEST_VAR_SOURCE')).toBe('yes');
    } finally {
      delete process.env.OVERAPI_TEST_VAR_SOURCE;
    }
  });
});
