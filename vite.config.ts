import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      // satellite.js' main entry also pulls in a multi-threaded WASM build we do not need;
      // import its plain-JS modules directly to keep the bundle small.
      '@sat': fileURLToPath(new URL('./node_modules/satellite.js/dist', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
