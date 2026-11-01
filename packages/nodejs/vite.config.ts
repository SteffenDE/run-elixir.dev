import { defineConfig } from 'vite';
import { licenses } from '../../vite-licenses.ts';

// The nodejs package (docs/nodejs.md): the worker program `node`,
// workers/nodejs.js, with the chunks it imports (workers/chunks/); and the
// page programs npm.js and npx.js (`npm`, `npx`, which the exec frame's
// worker imports), into dist/ (runtime/build.py lays it out as
// /npm/@elixir-playground/nodejs@VERSION/). The descriptor names them:
// they keep their names. The service worker gives everything below
// workers/ the worker programs' policy (runtime/src/swBridge.ts
// workerPolicy); the page programs' chunks are there too, which the exec
// frame's worker imports as it would any module.
const src = (name: string) => new URL(`./src/${name}`, import.meta.url).pathname;

export default defineConfig({
  publicDir: false,
  base: './',
  plugins: [licenses('nodejs').plugin],
  // The `process` package (readable-stream's nextTick) as this package's
  // own: a Node.js process's nextTick (process-shim.ts).
  resolve: {
    alias: [{ find: /^process\/?$/, replacement: src('process-shim.ts') }],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: { nodejs: src('index.ts'), npm: src('npmProgram.ts'), npx: src('npxProgram.ts') },
      // The programs' default exports are what the runtime calls.
      preserveEntrySignatures: 'exports-only',
      output: {
        format: 'es',
        entryFileNames: (chunk) => (chunk.name === 'nodejs' ? 'workers/nodejs.js' : '[name].js'),
        chunkFileNames: 'workers/chunks/[name]-[hash].js',
      },
    },
  },
});
