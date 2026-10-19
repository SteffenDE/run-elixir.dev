import { defineConfig, type UserConfig } from 'vite';

// The runtime's scripts that load by URL, bundled: the node's worker, the
// shared files' worker and the apex's Tailscale worker (src/tailscale),
// which go into the build (b/ID/, runtime/build.py) under their names, and
// the service worker, which stays at the site's root (its scope is /). The page's own parts of the
// runtime (host.ts, bridge.ts, …) are in the app's build.
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
        build: {
          // After the app's build, into the same dist/.
          outDir: 'dist',
          emptyOutDir: false,
          target: 'es2022',
          modulePreload: false,
          rollupOptions: {
            input: {
              worker: runtime('worker/index.ts'),
              files: runtime('files.ts'),
              sw: runtime('sw.ts'),
              tailscale: new URL('./src/tailscale/worker.ts', import.meta.url).pathname,
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
