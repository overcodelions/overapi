// A first guess at what a call does, from its method and path. The person
// curating the project has the last word; this only sets the default, and
// errs toward the stricter class when the two signals disagree.

import type { HttpMethod, Safety } from './project';

/// POSTs that only read. Legacy APIs use POST for search because the
/// query did not fit in a URL, and treating those as writes would hide the
/// most useful tool in the API.
const READ_ACTION = /\/(search|query|find|lookup|filter|list|export|report|preview|validate|calculate|quote|estimate)(\/|$)/i;

/// Paths that destroy whatever their method, from APIs that predate REST:
/// `POST /orders/{id}/delete`, `GET /purge`.
const DESTRUCTIVE_ACTION = /\/(delete|remove|destroy|purge|wipe|truncate|drop|void|revoke|terminate)(\/|$)/i;

export function safetyFor(method: HttpMethod | string, path: string): Safety {
  const m = method.toUpperCase();
  if (DESTRUCTIVE_ACTION.test(path) || m === 'DELETE') return 'destructive';
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'read';
  if (m === 'POST' && READ_ACTION.test(path)) return 'read';
  return 'write';
}
