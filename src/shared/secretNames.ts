// Which values are secrets — by the name of what carries them — and how to
// keep them out of a project file: the value goes to the keychain, the
// project keeps `${NAME}`.

import type { ToolDef } from './project';

/// A password, secret, token or key, by its name. Names that only look
/// like one (tokenType, secretId, tokenUrl) aren't.
export const isSecretName = (name: string) => /(passw(or)?d|passphrase|secret|token|api_?key|credential|^pin$|^otp$)/i.test(name) && !/(type|id|ids|count|expires?|expiry|url|uri|length)$/i.test(name);

/// A typed value, not a reference to one kept elsewhere (${SECRET}, {{kept}}).
export const isLiteralValue = (v: unknown) => typeof v === 'string' && !!v.trim() && !/^\s*(\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{\{[^}]+\}\})\s*$/.test(v);

/// The secret's name: the project's prefix and the field, ACME_PASSWORD.
export const secretVarName = (prefix: string, field: string) =>
  `${prefix}_${field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .toUpperCase()}`;

/// A request's arguments with every secret field's typed value swapped for
/// `${NAME}`, and the values to put in the keychain under those names.
export function keepSecretsOut(tool: ToolDef, args: Record<string, unknown>, prefix: string): { args: Record<string, unknown>; secrets: [string, string][] } {
  const out = { ...args };
  const secrets: [string, string][] = [];
  for (const p of tool.params) {
    const v = out[p.name];
    if (!isSecretName(p.name) || !isLiteralValue(v)) continue;
    const name = secretVarName(prefix, p.name);
    secrets.push([name, v as string]);
    out[p.name] = `\${${name}}`;
  }
  return { args: out, secrets };
}
