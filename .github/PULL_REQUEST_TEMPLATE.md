## What

<!-- One or two sentences. What changes in user-visible terms. -->

## Why

<!-- The motivation. Link any related issue with "Closes #123". -->

## How

<!-- Brief notes on the implementation if it's not obvious from the diff. -->

## Checklist

- [ ] `npm run build` passes
- [ ] `npm test` passes
- [ ] One logical change per PR
- [ ] If this touches an IPC channel, it's wired through `IPCInvokeMap` in `src/shared/ipc.ts`
- [ ] If this touches a security-sensitive area (secrets, what agents are offered, child processes, AI prompts, Electron `webPreferences` / CSP / navigation), it's called out below

## Security-sensitive notes

<!-- Delete this section if not applicable. Otherwise describe what you touched and why it's safe. -->
