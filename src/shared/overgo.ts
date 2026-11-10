// Publishing a project to the org's server (overgo), through overcli.
//
// The same road overdb's connections take:
//
//   overapi  — writes an ApiPush into ~/.overcli/inbox/apis/ (this file's
//              format). The folder existing is the whole handshake: overcli
//              makes it, so overapi offers Publish only when it is there.
//   overcli  — pushes it to the control plane with the person's org sign-in
//              (POST /api/publish/overapi-project).
//   overgo   — holds it as an offer until an admin finishes it in Setup →
//              APIs: picks read-only or writes, types each secret the
//              environment names. Approving writes the project to the org's
//              data folder and installs a tool that runs
//              `overapi serve <file> --env <env>` with the secrets in its env.
//
// overapi owns this format; overcli reads it (its src/shared/overapiProject.ts)
// and must be kept in step. The push carries NO secret — the project only
// ever names variables — and says which of them the admin must fill in.

import { envVars, isLoginTool, projectProblem, secretNames, type Project } from './project';

export const API_PUSH_VERSION = 1;
export const API_PUSH_KIND = 'overapi-project';
/// A project with hundreds of tools is a few hundred kilobytes.
export const API_PUSH_MAX_BYTES = 4 * 1024 * 1024;

export interface ApiPush {
  version: typeof API_PUSH_VERSION;
  kind: typeof API_PUSH_KIND;
  id: string;
  createdAt: string;
  /// The environment the server should serve. The admin can still choose
  /// read-only for it; it is never made more permissive than published.
  env: string;
  /// Variable names the server must be given values for.
  secrets: string[];
  project: Project;
}

export function buildApiPush(project: Project, envName: string, opts: { id: string; now: number }): { ok: true; push: ApiPush } | { ok: false; error: string } {
  const problem = projectProblem(project);
  if (problem) return { ok: false, error: problem };
  const env = project.envs.find((e) => e.name === envName);
  if (!env) return { ok: false, error: `No environment "${envName}".` };
  if (!/^https?:\/\//i.test(env.baseUrl)) return { ok: false, error: `"${envName}" needs a base URL the server can reach.` };
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(env.baseUrl)) {
    return { ok: false, error: `"${envName}" points at this machine (${env.baseUrl}); the org's server can't reach it. Publish an environment with a shared address.` };
  }
  if (!project.tools.some((t) => t.enabled)) return { ok: false, error: 'Every tool is off.' };
  // Only the published environment travels: the others may name hosts and
  // variables that are nobody else's business.
  const trimmed: Project = { ...project, envs: [env], tools: project.tools.filter((t) => t.enabled || isLoginTool(t, env)) };
  return {
    ok: true,
    push: {
      version: API_PUSH_VERSION,
      kind: API_PUSH_KIND,
      id: opts.id,
      createdAt: new Date(opts.now).toISOString(),
      env: env.name,
      secrets: [...new Set([...envVars(env), ...secretNames(trimmed)])],
      project: trimmed,
    },
  };
}

/// Sorts by arrival, like overdb's connection pushes.
export function apiPushFileName(push: Pick<ApiPush, 'id' | 'createdAt'>): string {
  return `${push.createdAt.replace(/[:.]/g, '-')}-${push.id}.json`;
}
