import { defineConfig } from 'vite';
import { licenses } from '../../vite-licenses.ts';

// The inotify-tools package (docs/packages.md): program.js into dist/,
// with what they import in chunks/ and their assets in files/
// (runtime/build.py lays it out as /npm/@elixir-playground/inotify-tools@VERSION/).
// The descriptor names the entries: they keep their names.
export default defineConfig({
  publicDir: false,
  base: './',
  plugins: [licenses('inotify-tools').plugin],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'files',
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: { program: 'src/program.ts' },
      // The entries' exports are what their users call.
      preserveEntrySignatures: 'exports-only',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
});
