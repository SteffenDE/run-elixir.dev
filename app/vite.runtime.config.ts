import { defineConfig, type UserConfig } from 'vite';
import { licenses } from './vite-licenses.ts';

// The runtime's scripts that load by URL, bundled: the node's worker, the
// shared files' worker, the IDE's git (git.ts) and Node.js's (`node`,
// nodejs/), which go into the runtime package
// (dist-runtime/, laid out as /npm/@elixir-playground/runtime@VERSION/ by
// runtime/build.py) under their names, with the frames
// (vite.frames.config.ts); and the service worker, which runtime/build.py
// puts at the site's root (its scope is /).
//
// `vite build -c vite.runtime.config.ts --mode node` bundles the Node
// harness instead: node.mjs, and beam-node.mjs (beam/), into dist-node/
// as .mjs.
const runtime = (name: string) => new URL(`./src/runtime/${name}`, import.meta.url).pathname;

export default defineConfig(({ mode }): UserConfig =>
  mode === 'node'
    ? {
        publicDir: false,
        ssr: { target: 'node', noExternal: true },
        build: {
          ssr: true,
          outDir: 'dist-node',
          target: 'node24',
          minify: false,
          rollupOptions: {
            input: {
              node: runtime('node.ts'),
              'beam-node': runtime('beam-node.ts'),
            },
            output: {
              format: 'es',
              entryFileNames: '[name].mjs',
              chunkFileNames: '[name]-[hash].mjs',
            },
          },
        },
      }
    : {
        publicDir: false,
        // The runtime package's scripts (docs/licenses.md).
        plugins: [licenses('runtime').plugin],
        // The `process` package (readable-stream's nextTick) as the
        // runtime's own: a Node.js process's nextTick (process-shim.ts).
        resolve: {
          alias: [{ find: /^process\/?$/, replacement: runtime('nodejs/process-shim.ts') }],
        },
        build: {
          outDir: 'dist-runtime',
          emptyOutDir: true,
          target: 'es2022',
          modulePreload: false,
          rollupOptions: {
            input: {
              worker: runtime('worker/index.ts'),
              files: runtime('files.ts'),
              git: runtime('git.ts'),
              nodejs: runtime('nodejs/index.ts'),
              sw: runtime('sw.ts'),
            },
            output: {
              format: 'es',
              entryFileNames: '[name].js',
              chunkFileNames: 'chunks/[name]-[hash].js',
            },
          },
        },
      },
);
