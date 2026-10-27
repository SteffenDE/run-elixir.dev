import { defineConfig } from 'vite';

// The usercontent domain's frames (docs/frames.md): a preview origin's
// relay, the frame that runs a project (and its worker, exec/host.ts),
// and the claude frame. They are the runtime package's (docs/packages.md),
// so they share nothing with the IDE's build: after the runtime's scripts,
// into the same dist-runtime/ (runtime/build.py lays it out as
// /npm/@elixir-playground/runtime@VERSION/), their assets in frames/.
// Relative: the package's path is known only once it is built.
export default defineConfig({
  publicDir: false,
  base: './',
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  build: {
    outDir: 'dist-runtime',
    emptyOutDir: false,
    assetsDir: 'frames',
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: {
        exec: 'exec.html',
        relay: 'relay.html',
        claude: 'claude.html',
      },
    },
  },
  worker: { format: 'es' },
});
