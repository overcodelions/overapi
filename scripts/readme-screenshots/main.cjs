// The entry capture.mjs launches instead of the app's own: the same built
// main process, with the keychain switched off first. A sandboxed run has
// no secrets to decrypt (the seed keeps its made-up tokens in .env files),
// and asking macOS for the keychain from a test run would block the main
// process on a permission prompt.
const path = require('node:path');
const { safeStorage } = require('electron');

safeStorage.isEncryptionAvailable = () => false;

require(path.resolve(__dirname, '..', '..', 'dist', 'main', 'index.js'));
