import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: { alias: { '@shirt/garment-schema': here('../packages/garment-schema/src/index.ts') } },
  ssr: { noExternal: true },
  build: {
    ssr: here('./export-garment.ts'),
    outDir: here('./dist'),
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'export-garment.mjs' } },
  },
});
