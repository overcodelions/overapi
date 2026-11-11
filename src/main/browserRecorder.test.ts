import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only the pure helpers and the session lookups — the recording window
// itself needs a real Electron.
const sessions = new Map<string, { setCertificateVerifyProc: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn>; cookies: { get: ReturnType<typeof vi.fn> } }>();
const fromPartition = vi.fn((p: string) => {
  if (!sessions.has(p)) {
    sessions.set(p, {
      setCertificateVerifyProc: vi.fn(),
      fetch: vi.fn(async (url: string) => new Response(`fetched ${url}`)),
      cookies: { get: vi.fn(async () => [{ name: 'sid', value: 'acme', domain: 'app.acme.example', httpOnly: true }]) },
    });
  }
  return sessions.get(p)!;
});
vi.mock('electron', () => ({ BaseWindow: class {}, WebContentsView: class {}, session: { fromPartition: (p: string) => fromPartition(p) } }));

const { partitionFor, normalizeSite, sessionFetch, cookiesFor } = await import('./browserRecorder');

beforeEach(() => {
  sessions.clear();
  fromPartition.mockClear();
});

describe('partitionFor', () => {
  it.each([
    ['https://app.acme.example/dashboard', 'persist:site-app.acme.example'],
    ['https://APP.Acme.Example', 'persist:site-app.acme.example'],
    ['http://localhost:5173/', 'persist:site-localhost_5173'],
    ['http://[::1]:8080/', 'persist:site-___1__8080'],
    ['app.acme.example', 'persist:site-app.acme.example'],
    ['not a url/with stuff', 'persist:site-not_a_url_with_stuff'],
  ])('%s → %s', (site, part) => {
    expect(partitionFor(site)).toBe(part);
  });

  it('one session per host: paths and schemes share it', () => {
    expect(partitionFor('https://app.acme.example/a')).toBe(partitionFor('http://app.acme.example/b?x=1'));
  });
});

describe('normalizeSite', () => {
  it.each([
    ['app.acme.example', 'https://app.acme.example/'],
    ['  app.acme.example/login  ', 'https://app.acme.example/login'],
    ['https://app.acme.example', 'https://app.acme.example/'],
    ['http://app.acme.example:8080/x', 'http://app.acme.example:8080/x'],
    ['localhost', 'http://localhost/'],
    ['localhost:3000', 'http://localhost:3000/'],
    ['LOCALHOST:3000/app', 'http://localhost:3000/app'],
    ['127.0.0.1:8000', 'http://127.0.0.1:8000/'],
    ['0.0.0.0:4200', 'http://0.0.0.0:4200/'],
    ['[::1]:8080', 'http://[::1]:8080/'],
    ['localhost.acme.example', 'https://localhost.acme.example/'],
  ])('%j → %s', (input, out) => {
    expect(normalizeSite(input)).toBe(out);
  });

  it('needs an address', () => {
    expect(() => normalizeSite('   ')).toThrow('Give the web app’s address');
  });

  it('refuses what is not a web address', () => {
    expect(() => normalizeSite('http://')).toThrow('"http://" is not a web address.');
    expect(() => normalizeSite('https://exa mple')).toThrow('is not a web address');
  });

  it('refuses other schemes', () => {
    expect(() => normalizeSite('ftp://files.acme.example')).toThrow('The address must start with http:// or https://.');
    expect(() => normalizeSite('file:///etc/hosts')).toThrow('must start with http');
  });
});

describe('sessionFetch', () => {
  it('fetches in the site’s own session, trusting self-signed certificates only on this machine', async () => {
    const f = sessionFetch('https://app.acme.example/');
    const ses = sessions.get('persist:site-app.acme.example')!;
    const res = await f(new URL('https://app.acme.example/api/me'), { method: 'GET' });
    expect(await res.text()).toBe('fetched https://app.acme.example/api/me');
    expect(ses.fetch).toHaveBeenCalledWith('https://app.acme.example/api/me', { method: 'GET' });

    const verify = ses.setCertificateVerifyProc.mock.calls[0][0] as (req: { hostname: string }, cb: (n: number) => void) => void;
    const verdict = (hostname: string) => {
      let v = NaN;
      verify({ hostname }, (n) => (v = n));
      return v;
    };
    expect(verdict('localhost')).toBe(0);
    expect(verdict('127.0.0.1')).toBe(0);
    expect(verdict('127.4.5.6')).toBe(0);
    expect(verdict('[::1]')).toBe(0);
    expect(verdict('::1')).toBe(0);
    // -3: use Chromium's own verification.
    expect(verdict('app.acme.example')).toBe(-3);
    expect(verdict('localhost.acme.example')).toBe(-3);
    expect(verdict('0.0.0.0')).toBe(-3);
  });
});

describe('cookiesFor', () => {
  it('reads the session’s cookies for a URL as name/value pairs', async () => {
    const list = await cookiesFor('https://app.acme.example', 'https://app.acme.example/api');
    expect(list).toEqual([{ name: 'sid', value: 'acme' }]);
    expect(fromPartition).toHaveBeenCalledWith('persist:site-app.acme.example');
    expect(sessions.get('persist:site-app.acme.example')!.cookies.get).toHaveBeenCalledWith({ url: 'https://app.acme.example/api' });
  });
});
