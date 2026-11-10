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
  },
});
