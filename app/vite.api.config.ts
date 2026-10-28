import { defineConfig } from 'vite';
import { licenses } from './vite-licenses.ts';

// The JavaScript packages an embedder installs (docs/api.md), each one ES
// module into dist-api/NAME/index.js (runtime/build.py lays them out as
// /npm/@elixir-playground/NAME@VERSION/):
//
//   vite build -c vite.api.config.ts --mode api      create() and its sandbox
//   vite build -c vite.api.config.ts --mode pglite   the pglite plugin
//
// Each bundles the playground's own code it needs; pglite leaves PGlite to
// the embedder's install (its dependency), whose WebAssembly the
// embedder's bundler then lays out.
const entries: Record<string, string> = {
  api: './src/api/index.ts',
  pglite: './src/api/pglite.ts',
};

export default defineConfig(({ mode }) => {
  const entry = entries[mode];
  if (!entry) throw new Error(`vite.api.config.ts: --mode ${Object.keys(entries).join(' or ')}`);
  return {
    publicDir: false,
    // Its bundled npm packages' licenses (docs/licenses.md).
    plugins: [licenses(mode).plugin],
    resolve: {
      alias: { '@': new URL('./src', import.meta.url).pathname },
    },
    build: {
      outDir: `dist-api/${mode}`,
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      lib: {
        entry: new URL(entry, import.meta.url).pathname,
        formats: ['es'],
        fileName: () => 'index.js',
      },
      rollupOptions: {
        external: [/^@electric-sql\/pglite(\/.*)?$/],
        output: { codeSplitting: false },
      },
    },
  };
});
