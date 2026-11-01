// A site that uses neither @elixir-playground/vite nor its layout
// (../plain.sh): the page cross-origin isolated, the packages from another
// origin (a CDN's, runtime/serve.py here). Vite only bundles the api, and
// its apex worker with it.
import { defineConfig } from 'vite';

const isolated = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  server: { headers: isolated },
  preview: { headers: isolated },
  resolve: { preserveSymlinks: true },
  build: { target: 'es2022' },
});
