import { defineConfig, type Plugin } from 'vite';
import { licenses } from '../../vite-licenses.ts';

// The apex worker as a site's bundler finds it: Vite's library build
// writes the worker's URL as `new URL(new URL("apexWorker.js",
// import.meta.url).href, …)`, which no bundler follows. index.js gets
// `new URL("./apexWorker.js", import.meta.url)` instead, the form Vite and
// webpack bundle as a worker of their own (docs/api.md).
const WORKER_URL =
  /new URL\(\s*\/\* @vite-ignore \*\/\s*new URL\("apexWorker\.js", import\.meta\.url\)\.href,\s*"" \+ import\.meta\.url\s*\)/g;
const workerUrl: Plugin = {
  name: 'apex-worker-url',
  generateBundle(_, bundle) {
    const index = bundle['index.js'];
    if (index?.type !== 'chunk') throw new Error('apex-worker-url: no index.js');
    const found = index.code.match(WORKER_URL)?.length ?? 0;
    if (found !== 1)
      throw new Error(`apex-worker-url: the worker's URL is in index.js ${found} times, not once`);
    index.code = index.code.replace(WORKER_URL, 'new URL("./apexWorker.js", import.meta.url)');
  },
};

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
  plugins: [licenses('api').plugin, workerUrl],
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
