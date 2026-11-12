// Your approval of a project, as a fingerprint of what it can do with your
// secrets (shared/trust.ts). The app keeps one per project path; when the
// file no longer matches, secrets are held back — in the app and under
// `overapi serve` — until you review it.

import crypto from 'node:crypto';
import type { Project } from '../shared/project';
import { trustSurface } from '../shared/trust';

export function trustFingerprint(p: Project): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(trustSurface(p)))
    .digest('hex');
}

/// Why nothing secret goes out, in the words the person and an agent see.
export const heldBack = (title: string) =>
  `Secrets are held back for ${title}: it’s new to overapi, or its sign-in, addresses or request labels changed outside the app. Open it in overapi and review it to allow it.`;
