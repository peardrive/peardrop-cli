import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@engine': resolve(__dirname, 'src/engine'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Engine roundtrip tests spin up a real in-process DHT testnet.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
