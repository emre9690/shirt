import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shirt/garment-schema': fileURLToPath(new URL('../../packages/garment-schema/src/index.ts', import.meta.url)),
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
});
