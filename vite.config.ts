import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { devProxyPlugin } from './dev-server/proxy.ts';
import { mockXtreamPlugin } from './dev-server/mock-xtream.ts';
import { enrollDevPlugin } from './dev-server/enroll.ts';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig(({ command }) => ({
  // the dev-only TMDB token must never reach a production bundle / APK
  define: {
    // CYBER_VERSION / CYBER_UPDATE_URL: overrides for testing the self-update against a local server
    __APP_VERSION__: JSON.stringify(process.env.CYBER_VERSION || pkg.version),
    __UPDATE_URL__: JSON.stringify(process.env.CYBER_UPDATE_URL ?? pkg.cyber?.updateUrl ?? ''),
    ...(command === 'build' ? { 'import.meta.env.VITE_DEV_TMDB_TOKEN': JSON.stringify('') } : {}),
  },
  plugins: [react(), devProxyPlugin(), mockXtreamPlugin(), enrollDevPlugin()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  worker: { format: 'es' },
  build: { target: 'es2020', sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { port: 5173, strictPort: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
}) as any);
