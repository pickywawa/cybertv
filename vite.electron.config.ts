import { defineConfig } from 'vite';

/** Electron main process → dist-electron/main.cjs (Node, CommonJS) */
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'electron/main.ts',
    outDir: 'dist-electron',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      external: ['electron', /^node:/],
      output: { format: 'cjs', entryFileNames: 'main.cjs' },
    },
  },
  ssr: { noExternal: true },
});
