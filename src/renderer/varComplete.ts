// `{{` and `${` as you type: which variable you're in the middle of
// naming, and the text with the one you picked put in its place.

export interface VarAt {
  /// {{name}}: a plain or kept value. ${NAME}: a secret.
  kind: 'var' | 'secret';
  /// What's typed of the name so far.
  partial: string;
  /// Where the `{{` or `${` starts.
  start: number;
}

/// The variable being typed just before the caret, if one is.
export function varAt(value: string, caret: number | null): VarAt | null {
  if (caret === null) return null;
  const m = value.slice(0, caret).match(/(\{\{\s*([A-Za-z0-9_.-]*)|\$\{([A-Za-z0-9_]*))$/);
  if (!m) return null;
  return m[0].startsWith('$') ? { kind: 'secret', partial: m[3] ?? '', start: caret - m[0].length } : { kind: 'var', partial: m[2] ?? '', start: caret - m[0].length };
}

/// The value with the picked name written out in full, and where the caret
/// goes after it. Closing braces already typed after the caret are reused.
export function insertVar(value: string, at: VarAt, caret: number, name: string): { value: string; caret: number } {
  const text = at.kind === 'var' ? `{{${name}}}` : `\${${name}}`;
  const rest = value.slice(caret).replace(at.kind === 'var' ? /^[A-Za-z0-9_.-]*(\s*\}{1,2})?/ : /^[A-Za-z0-9_]*\}?/, '');
  return { value: value.slice(0, at.start) + text + rest, caret: at.start + text.length };
}

/// Names that match what's typed: starting with it first, then containing it.
export function matching<T extends { name: string }>(items: T[], partial: string): T[] {
  const q = partial.toLowerCase();
  const seen = new Set<string>();
  const unique = items.filter((x) => (seen.has(x.name) ? false : (seen.add(x.name), true)));
  if (!q) return unique;
  const starts = unique.filter((x) => x.name.toLowerCase().startsWith(q));
  return [...starts, ...unique.filter((x) => !starts.includes(x) && x.name.toLowerCase().includes(q))];
}
