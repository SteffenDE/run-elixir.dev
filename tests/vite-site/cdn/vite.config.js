// The plain site of ../plain/vite.config.js, for ../cdn.sh: Vite bundles
// the api alone; the descriptors and every file come from a public npm
// CDN.
import { defineConfig } from 'vite';

const isolated = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  server: { headers: isolated },
  preview: { headers: isolated },
  resolve: { preserveSymlinks: true },
  build: { target: 'es2022' },
});
