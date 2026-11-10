// The engine: import, call, serve. Never imports electron — the CLI and a
// published server run it under plain Node, with no app installed.
// noElectron.test.ts holds that line.

export { importText, parseDocument } from './import';
export { importFromUrl, specLinks } from './import/fromUrl';
export { buildRequest, send, scrub, ArgumentError, type CallResult, type BuiltRequest } from './http';
export { createServer, pickEnv, toMcpTool, instructionsFor } from './server';
export { readProject, writeProject, liveProject } from './projectFile';
export { varSource, parseDotenv, dotenvBeside, type VarSource } from './vars';
export { safetyFor } from '../shared/safety';
export { callTool, signIn, loginFor, loginKey, loginAtKey, borrowSignIn, type Peer } from './flow';
export { runScenario, runLoad, writesAllowed, LOAD_LIMITS, type LoadSnapshot, type LoadOptions } from './scenario';
