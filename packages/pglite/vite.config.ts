import { defineConfig } from 'vite';
import { licenses } from '../../vite-licenses.ts';

// @elixir-playground/pglite as published (docs/api.md): the pglite plugin; PGlite stays the embedder's install (its dependency), whose WebAssembly the embedder's bundler lays out,
// into dist/index.js. runtime/build.py lays it out as
// /npm/@elixir-playground/pglite@VERSION/ with its package.json; its bundled
// npm packages' licenses (docs/licenses.md).
export default defineConfig({
  publicDir: false,
  plugins: [licenses('pglite').plugin],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    lib: {
      entry: new URL('./src/index.ts', import.meta.url).pathname,
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: { external: [/^@electric-sql\/pglite(\/.*)?$/] },
  },
});
