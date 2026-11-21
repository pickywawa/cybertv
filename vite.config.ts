import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { devProxyPlugin } from './dev-server/proxy.ts';
import { mockXtreamPlugin } from './dev-server/mock-xtream.ts';

export default defineConfig(({ command }) => ({
  // the dev-only TMDB token must never reach a production bundle / APK
  define: command === 'build' ? { 'import.meta.env.VITE_DEV_TMDB_TOKEN': JSON.stringify('') } : {},
  plugins: [react(), devProxyPlugin(), mockXtreamPlugin()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  worker: { format: 'es' },
  build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { port: 5173, strictPort: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
}) as any);
