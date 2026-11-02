import { defineConfig, type UserConfig } from 'vite';
import { licenses } from '../../vite-licenses.ts';

// The runtime's scripts that load by URL, bundled: the node's worker, the
// shared files' worker and the IDE's git (git.ts), which go into the
// runtime package (Node.js's worker is the nodejs package's)
// (dist/, laid out as /npm/@elixir-playground/runtime@VERSION/ by
// runtime/build.py) under their names, with the frames
// (vite.frames.config.ts); and root/: the service worker and the bridge's
// bootstrap, which the usercontent domain serves at its root (the
// worker's scope is /: runtime/build.py's _usercontent/, the vite
// package).
//
// `vite build -c vite.runtime.config.ts --mode node` bundles the Node
// harness instead: harness.mjs (the library, which the runtime package
// publishes as ./harness), node.mjs (its command line) and beam-node.mjs
// (beam/), into dist-node/ as .mjs.
const runtime = (name: string) => new URL(`./src/${name}`, import.meta.url).pathname;

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
              harness: runtime('harness.ts'),
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
        // public/root/bridge.html: the bootstrap the usercontent domain
        // serves at /bridge.html.
        publicDir: 'public',
        // The runtime package's scripts (docs/licenses.md).
        plugins: [licenses('runtime').plugin],
        build: {
          outDir: 'dist',
          emptyOutDir: true,
          target: 'es2022',
          modulePreload: false,
          rollupOptions: {
            input: {
              worker: runtime('worker/index.ts'),
              files: runtime('files.ts'),
              git: runtime('git.ts'),
              'root/sw': runtime('sw.ts'),
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
