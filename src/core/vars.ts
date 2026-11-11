// Where secrets come from at call time: the process environment first,
// then a `.env` file beside the project file. Never the project itself.
//
// The process environment wins so that a client's own `env` block (what
// the install snippets write) overrides a developer's local .env.

import fs from 'node:fs';
import path from 'node:path';

export type VarSource = (name: string) => string | undefined;

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    let v = (m[2] ?? '').trim();
    // A quoted value ends at its closing quote — a `# comment` after it is
    // not part of it.
    const quoted = v.match(/^(["'])((?:\\.|(?!\1).)*)\1(?:\s+#.*)?$/);
    if (quoted) {
      v = quoted[2];
      if (quoted[1] === '"') v = v.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    out[m[1]] = v;
  }
  return out;
}

export function dotenvBeside(projectPath: string): Record<string, string> {
  try {
    return parseDotenv(fs.readFileSync(path.join(path.dirname(projectPath), '.env'), 'utf8'));
  } catch {
    return {};
  }
}

/// The install snippets write `NAME=<NAME>` for the person to fill in. One
/// pasted unfilled must not shadow a real value in .env, so a placeholder
/// counts as unset.
function real(v: string | undefined): string | undefined {
  if (v === undefined || v === '' || /^<[A-Za-z_][A-Za-z0-9_]*>$/.test(v)) return undefined;
  return v;
}

export function varSource(projectPath?: string, env: NodeJS.ProcessEnv = process.env): VarSource {
  const file = projectPath ? dotenvBeside(projectPath) : {};
  return (name) => real(env[name]) ?? real(file[name]);
}
