// Reading and writing overapi.json. Written atomically (temp file, then
// rename) because a running `serve` re-reads it on every request and must
// never see half a file.

import fs from 'node:fs';
import path from 'node:path';
import { projectProblem, type Project } from '../shared/project';

export function readProject(file: string): Project {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  const problem = projectProblem(value);
  if (problem) throw new Error(`${file}: ${problem}`);
  return value as Project;
}

export function writeProject(file: string, project: Project): void {
  const problem = projectProblem(project);
  if (problem) throw new Error(`Refusing to save: ${problem}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !fs.existsSync(file);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(project, null, 2)}\n`);
  fs.renameSync(tmp, file);
  // Shared through git: the project names its secrets, and .env beside it
  // holds them on each machine — so a new project's folder keeps .env out.
  // An existing .gitignore is the person's; it's left alone.
  if (fresh) {
    const ignore = path.join(path.dirname(file), '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# Secrets stay on each machine: overapi.json names them, .env holds them.\n.env\n');
  }
}

/// A reader that re-parses only when the file changed, and keeps serving
/// the last good version if an edit leaves it briefly broken.
export function liveProject(file: string, onError?: (msg: string) => void): () => Project {
  let cached = readProject(file);
  let stamp = mtime(file);
  return () => {
    const now = mtime(file);
    if (now !== stamp) {
      stamp = now;
      try {
        cached = readProject(file);
      } catch (e) {
        onError?.(`kept the previous version: ${(e as Error).message}`);
      }
    }
    return cached;
  };
}

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
