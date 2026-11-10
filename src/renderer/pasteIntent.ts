// What a paste outside any text field most likely means. A cURL is a
// request; a URL to a spec or the text of one is an import; any other URL
// is documentation; a long block of prose is documentation too.

import type { NewMode } from './store';

export interface PasteIntent {
  mode: NewMode;
  prefill: string;
}

const SPEC_URL = /\.(json|ya?ml|har)(\?|#|$)|openapi|swagger|api-docs|postman/i;

export function pasteIntent(raw: string): PasteIntent | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^curl(\.exe)?\s/i.test(text)) return { mode: 'curl', prefill: text };
  if (/^https?:\/\/\S+$/i.test(text)) return { mode: SPEC_URL.test(text) ? 'import' : 'docs', prefill: text };
  if (/^[{[]/.test(text) || /^(openapi|swagger)\s*:/m.test(text.slice(0, 400))) return { mode: 'import', prefill: text };
  if (text.length >= 200) return { mode: 'docs', prefill: text };
  return null;
}
