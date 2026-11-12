// How each client is told about a served project. Every client runs the
// same thing — `<command> serve <project.json> --env <name>` over stdio —
// and differs only in where that line goes.
//
// Secrets are never written into a snippet. Each variable the environment
// reads appears with a placeholder for the person to fill in. One left
// unfilled counts as unset (src/core/vars.ts), so a .env beside the project
// still applies.

import { envVars, type EnvDef, type Project } from './project';

export interface ServeCommand {
  /// The executable: the packaged app binary, or node.
  command: string;
  /// Arguments before `serve` — e.g. the CLI script path when command is node.
  prefix: string[];
}

export type ClientId = 'claude' | 'codex' | 'json';

export interface Snippet {
  client: ClientId;
  label: string;
  where: string;
  text: string;
}

export function serverName(project: Project, env: EnvDef): string {
  // Always cleaned: it's passed to `claude mcp add`, where "--x" would be a flag.
  const name = env.name === 'default' ? project.name || 'api' : `${project.name || 'api'}-${env.name}`;
  return name.replace(/[^a-z0-9-]/gi, '-').replace(/^-+/, '').toLowerCase() || 'api';
}

export function serveArgs(cmd: ServeCommand, projectPath: string, env: EnvDef): string[] {
  return [...cmd.prefix, 'serve', projectPath, '--env', env.name];
}

function placeholders(env: EnvDef): Record<string, string> {
  return Object.fromEntries(envVars(env).map((v) => [v, `<${v}>`]));
}

/// POSIX shell quoting: bare when safe, single-quoted otherwise.
export function shq(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

export function snippets(project: Project, env: EnvDef, projectPath: string, cmd: ServeCommand): Snippet[] {
  const name = serverName(project, env);
  const args = serveArgs(cmd, projectPath, env);
  const vars = placeholders(env);

  const claude = [
    'claude mcp add',
    shq(name),
    '--scope user',
    ...Object.entries(vars).map(([k, v]) => `--env ${shq(`${k}=${v}`)}`),
    '--',
    shq(cmd.command),
    ...args.map(shq),
  ].join(' ');

  const codexLines = [
    `[mcp_servers.${name.replace(/[^A-Za-z0-9_-]/g, '_')}]`,
    `command = ${tomlString(cmd.command)}`,
    `args = [${args.map(tomlString).join(', ')}]`,
  ];
  if (Object.keys(vars).length) {
    codexLines.push(`env = { ${Object.entries(vars).map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`);
  }

  const json = JSON.stringify(
    { mcpServers: { [name]: { command: cmd.command, args, ...(Object.keys(vars).length ? { env: vars } : {}) } } },
    null,
    2,
  );

  return [
    {
      client: 'claude',
      label: 'Claude Code and overcli',
      where: 'Run in a terminal. overcli picks up servers added to Claude Code, so this one line covers both.',
      text: claude,
    },
    {
      client: 'codex',
      label: 'Codex',
      where: 'Add to ~/.codex/config.toml.',
      text: codexLines.join('\n'),
    },
    {
      client: 'json',
      label: 'Any MCP client (JSON)',
      where: 'The common mcpServers shape: Claude Desktop, Cursor, Windsurf, and a .mcp.json in a repo.',
      text: json,
    },
  ];
}
