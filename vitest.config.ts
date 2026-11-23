import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shirt/garment-schema': fileURLToPath(new URL('./packages/garment-schema/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60000 },
});
