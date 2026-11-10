// One call seen by the recorder (src/core/recorder.ts) or the recording
// browser (src/main/browserRecorder.ts). Shared so the app can show calls
// live and work out the request graph (graph.ts) as they arrive.

export interface RecordedCall {
  id: string;
  at: string;
  method: string;
  /// Path and query. From the local address: as the client sent it. From
  /// the browser: the URL's own path and query.
  path: string;
  /// The whole URL — browser calls only, which go to many hosts.
  url?: string;
  status: number;
  statusText: string;
  ms: number;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseHeaders: Record<string, string>;
  responseBody?: string;
  contentType: string;
  bytes: number;
  error?: string;
  /// Sent again from overapi: the call it repeats.
  replayOf?: string;
}

/// How a recording listens: a local address that forwards (proxy), or a
/// browser window overapi drives (browser) — for web apps with no public API.
export type RecordMode = 'proxy' | 'browser';
/// Which browser a browser recording uses: overapi's own window, or the
/// person's Chrome (with its extensions) on overapi's profile.
export type BrowserVia = 'overapi' | 'chrome';

/// Hosts a web app calls that are never its API: analytics, error
/// reporting, chat widgets, feature flags, ads. Left out of a browser
/// recording entirely.
const NOISE =
  /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|googlesyndication\.com|google\.com|gstatic\.com|googleapis\.com|segment\.(io|com)|sentry\.io|ingest\.sentry\.io|mixpanel\.com|amplitude\.com|hotjar\.(com|io)|intercom\.io|intercomcdn\.com|fullstory\.com|datadoghq\.(com|eu)|browser-intake-datadoghq\.com|nr-data\.net|newrelic\.com|launchdarkly\.com|optimizely\.com|heap\.io|heapanalytics\.com|posthog\.com|clarity\.ms|bugsnag\.com|logrocket\.(com|io)|facebook\.(com|net)|linkedin\.com|twitter\.com|ads-twitter\.com|hubspot\.com|hs-analytics\.net|stripe\.network|cloudflareinsights\.com|pendo\.io|gainsight\.com|appcues\.com|userpilot\.io|zdassets\.com|statuspage\.io|rollbar\.com|quantserve\.com|bing\.com)$/i;
/// A dev server's own traffic — hot reload, its socket, bundled assets.
const DEV_SERVER = /^\/(sockjs-node|__webpack_hmr|@vite|@fs|@id|@react-refresh|__vite_ping|ng-cli-ws|browser-sync|livereload|_next\/(static|webpack-hmr)|assets)(\/|$)|\.hot-update\.(json|js)$/i;
const STATIC = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|otf|mp4|webm|mp3|wasm)$/i;

/// Whether a browser request is worth recording at all.
export function isNoise(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (!/^https?:$/.test(u.protocol)) return true;
  return NOISE.test(u.hostname) || STATIC.test(u.pathname) || DEV_SERVER.test(u.pathname);
}

const trim = (s: string) => s.replace(/\/+$/, '');

/// Whether a call went to this API (base URL, path included). Calls from
/// the local address have no URL — they all went there.
export function isUnder(call: RecordedCall, base: string | undefined): boolean {
  if (!call.url || !base) return true;
  const b = trim(base);
  if (!b) return true;
  return call.url === b || call.url.startsWith(`${b}/`) || call.url.startsWith(`${b}?`);
}

export function within(calls: RecordedCall[], base: string | undefined): RecordedCall[] {
  return calls.filter((c) => isUnder(c, base));
}

/// The hosts a browser recording reached, busiest first — so the person
/// can say which one is the API.
export function originsOf(calls: RecordedCall[]): { origin: string; count: number }[] {
  const n = new Map<string, number>();
  for (const c of calls) {
    if (!c.url) continue;
    try {
      const o = new URL(c.url).origin;
      n.set(o, (n.get(o) ?? 0) + 1);
    } catch {
      /* not a URL */
    }
  }
  return [...n.entries()].map(([origin, count]) => ({ origin, count })).sort((a, b) => b.count - a.count);
}

/// The busiest host that answers JSON — the likeliest API in a browser
/// recording. Undefined until something has been recorded.
export function likelyApi(calls: RecordedCall[]): string | undefined {
  const json = calls.filter((c) => c.url && /json/i.test(c.contentType));
  return originsOf(json.length ? json : calls)[0]?.origin;
}
