// While overapi explores a site on its own, nothing but reads leaves the
// browser. The explorer's click rules keep it away from buttons that act;
// this is the guarantee underneath them: a page's own script can still
// send a POST when a tab opens (tracking, a "viewed" ping), and that is
// stopped here, at the network, before it goes.
//
// "Safe search" lets one kind of POST through: a query that only reads —
// a search, a filter, a GraphQL query (never a mutation) — because some
// sites fetch their data that way and would otherwise show nothing.

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SEARCHY = /(search|query|queries|filter|find|lookup|autocomplete|suggest|typeahead|graphql|gql|facets?|browse)/i;
const ACTS = /(delete|remove|destroy|create|update|upsert|save|submit|send|post(?!s)|pay|payment|order(?!s)|checkout|cart|basket|login|logout|sign-?in|sign-?out|sign-?up|register|subscribe|vote|comment|like|follow|share|track|event|analytics|collect|beacon|telemetry|log(?:s|ging)?\b|metrics|consent|upload|import|publish)/i;

export type GuardDecision = { send: true } | { send: false; why: string };

export function guardRequest(method: string, url: string, body: string | undefined, safeSearch: boolean): GuardDecision {
  const m = method.toUpperCase();
  if (READS.has(m)) return { send: true };
  if (safeSearch && m === 'POST' && looksLikeSearch(url, body)) return { send: true };
  return { send: false, why: safeSearch && m === 'POST' ? 'a POST that doesn’t look like a search' : `a ${m} — it could change something` };
}

/// A POST that only asks: a search-shaped path with nothing that acts in
/// it, or a GraphQL query that isn't a mutation.
export function looksLikeSearch(url: string, body: string | undefined): boolean {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Use it as given.
  }
  if (/graphql|gql/i.test(path)) {
    const b = body ?? '';
    if (/\bmutation\b/i.test(b) || /\bsubscription\b/i.test(b)) return false;
    return /\bquery\b|"query"\s*:/i.test(b);
  }
  return SEARCHY.test(path) && !ACTS.test(path);
}
