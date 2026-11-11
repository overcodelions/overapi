import type { ReactNode } from 'react';

/// A small, safe Markdown renderer for answers: headings, paragraphs,
/// lists, tables, code blocks, and **bold**, *italic*, `code` inline. It
/// builds React elements — no HTML from the text is ever injected.
export function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // Code block.
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={out.length} className="selectable overflow-x-auto rounded-lg border border-rule bg-wash p-3 font-mono text-[12px] leading-relaxed">
          {body.join('\n')}
        </pre>,
      );
      continue;
    }
    // Table: a header row, a --- row, then rows.
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        <div key={out.length} className="overflow-x-auto rounded-lg border border-accent/25 bg-surface">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-accent/20 bg-accent/[0.08] text-[11px] uppercase tracking-[0.06em] text-accent">
              <tr>
                {head.map((h, j) => (
                  <th key={j} className="whitespace-nowrap px-3 py-2 font-semibold">
                    {inline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, k) => (
                <tr key={k} className="border-t border-rule first:border-t-0 even:bg-wash/50">
                  {head.map((_, j) => (
                    <td key={j} className={`px-3 py-1.5 align-top ${(r[j] ?? '').trim().length <= 18 ? 'whitespace-nowrap' : ''}`}>
                      {inline(r[j] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // Heading.
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push(
        <div key={out.length} className={`font-semibold ${h[1].length <= 2 ? 'text-[15px]' : 'text-[13.5px]'}`}>
          {inline(h[2])}
        </div>,
      );
      i++;
      continue;
    }
    // Lists.
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
      const Tag = ordered ? 'ol' : 'ul';
      out.push(
        <Tag key={out.length} className={`space-y-1.5 pl-5 leading-[1.6] ${ordered ? 'list-decimal' : 'list-disc'} marker:text-accent`}>
          {items.map((it, k) => (
            <li key={k}>{inline(it)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    // Paragraph: until a blank line or another block.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i]) && !(isTableRow(lines[i]) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? ''))) para.push(lines[i++]);
    const text = para.join(' ').trim();
    // A line that is only bold and ends in a colon is a heading in all but name.
    const lead = /^\*\*([^*]+)\*\*:?$/.exec(text) ?? /^\*\*([^*]+:)\*\*$/.exec(text);
    out.push(
      lead ? (
        <h4 key={out.length} className="pt-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-accent">
          {lead[1].replace(/:$/, '')}
        </h4>
      ) : (
        <p key={out.length} className="leading-[1.65]">
          {inline(text)}
        </p>
      ),
    );
  }
  return <div className="space-y-3 text-[14px] text-ink">{out}</div>;
}

/// **bold**, *italic*, `code` — as elements.
function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) parts.push(<strong key={parts.length} className="font-semibold text-ink">{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) parts.push(<code key={parts.length} className="rounded border border-rule bg-canvas px-1 py-px font-mono text-[12px] text-ink-muted">{t.slice(1, -1)}</code>);
    else parts.push(<em key={parts.length}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
