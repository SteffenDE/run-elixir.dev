import { defineConfig } from 'vite';
import { licenses } from '../../vite-licenses.ts';

// @elixir-playground/api as published (docs/api.md): create() and its sandbox, with the runtime's code it needs (one ES module),
// into dist/index.js, and the apex's worker beside it (dist/apexWorker.js,
// which index.js starts by its URL relative to its own). runtime/build.py lays it out as
// /npm/@elixir-playground/api@VERSION/ with its package.json; its bundled
// npm packages' licenses (docs/licenses.md).
export default defineConfig({
  publicDir: false,
  base: './',
  worker: {
    format: 'es',
    rollupOptions: { output: { entryFileNames: '[name].js' } },
  },
  plugins: [licenses('api').plugin],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    assetsDir: '',
    lib: {
      entry: new URL('./src/index.ts', import.meta.url).pathname,
      formats: ['es'],
      fileName: () => 'index.js',
    },
  },
});
