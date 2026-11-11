import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// CesiumJS loads its web workers, shaders' assets and third-party code at runtime from this path.
const cesiumSource = 'node_modules/cesium/Build/Cesium';
const cesiumBaseUrl = 'cesium';

export default defineConfig({
  define: { CESIUM_BASE_URL: JSON.stringify(`/${cesiumBaseUrl}`) },
  plugins: [
    viteStaticCopy({
      targets: ['ThirdParty', 'Workers', 'Assets', 'Widgets'].map((dir) => ({ src: `${cesiumSource}/${dir}`, dest: cesiumBaseUrl })),
    }),
  ],
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
    chunkSizeWarningLimit: 6000,
  },
});
