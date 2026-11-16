// Where help lives: the guides in docs/, the release notes, and where to
// report a problem. One list, so the Help menu in the menu bar and the ?
// in the app's header always agree.

const REPO = 'https://github.com/overcodelions/overapi';

export interface HelpLink {
  label: string;
  url: string;
  /// The file in this repo a guide is, so a test can check it exists.
  doc?: string;
}

const guide = (label: string, doc: string): HelpLink => ({ label, url: `${REPO}/blob/master/${doc}`, doc });

export const GUIDES: HelpLink[] = [
  guide('Getting started', 'docs/getting-started.md'),
  guide('Record a web app', 'docs/record-a-web-app.md'),
  guide('Sign-in', 'docs/sign-in.md'),
  guide('Sharing and safety', 'docs/sharing-and-safety.md'),
  guide('Command line', 'docs/cli.md'),
];

export const MORE_HELP: HelpLink[] = [
  { label: 'Release notes', url: `${REPO}/releases` },
  { label: 'Report an issue', url: `${REPO}/issues/new` },
  { label: 'Report a security problem', url: `${REPO}/security/advisories/new` },
];
