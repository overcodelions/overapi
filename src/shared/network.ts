// Is an address yours to hammer? Load tests on a machine you run — this
// one, a private network, a dev name — are routine. On anything public
// they look like an attack to whoever runs it, so they're held back to a
// polite size and need you to say you're allowed.

/// The most a load test may send to a public host.
export const PUBLIC_LOAD_LIMITS = { users: 5, durationSec: 30 };

export function isPrivateHost(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl.replace(/\{\{[^}]+\}\}/g, 'x')).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (/\.(localhost|local|internal|test|lan|home|corp|intranet)$/.test(host)) return true;
  const ip = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (/^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:')) return true;
  // A single-label name (no dots) is a machine on your network.
  return !host.includes('.');
}
