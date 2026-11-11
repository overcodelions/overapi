import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Separate from vite.config.ts, whose `root: src/renderer` would scope test
// discovery to the renderer and miss src/core and src/shared.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // The logic that decides what's sent, what agents see and what stays
      // secret. Electron's wiring (index.ts, the recording windows, the
      // keychain) and the React components are exercised by hand.
      include: ['src/core/**', 'src/shared/**', 'src/main/**', 'src/cli/**'],
      exclude: ['**/*.test.ts', 'src/main/index.ts', 'src/main/browserRecorder.ts', 'src/main/chromeRecorder.ts', 'src/main/secrets.ts', 'src/shared/ipc.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      // A floor, a little under where it is, so it can't quietly slip.
      thresholds: { lines: 95, statements: 94, functions: 94, branches: 86 },
    },
  },
});
