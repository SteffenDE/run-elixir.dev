import { defineConfig } from 'vite';
import { licenses } from '../../vite-licenses.ts';

// The Hex plugin as the elixir package ships it: dist/hex.js, one module
// with nothing to import (runtime/build.py copies it into the elixir
// package, whose index.js adds it).
export default defineConfig({
  publicDir: false,
  plugins: [licenses('hex').plugin],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    lib: {
      entry: new URL('./src/index.ts', import.meta.url).pathname,
      formats: ['es'],
      fileName: () => 'hex.js',
    },
  },
});
