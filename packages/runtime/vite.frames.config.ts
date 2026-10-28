import { defineConfig } from 'vite';
import { licenses } from '../../vite-licenses.ts';

// The runtime package's frames (docs/licenses.md).
const bundled = licenses('frames');

// The usercontent domain's frames (docs/frames.md): a preview origin's
// relay, and the frame that runs a project (and its worker, exec/host.ts).
// The claude frame is the claude package's. They are the runtime package's (docs/packages.md),
// so they share nothing with the IDE's build: after the runtime's scripts,
// into the same dist/ (runtime/build.py lays it out as
// /npm/@elixir-playground/runtime@VERSION/), their assets in frames/.
// Relative: the package's path is known only once it is built.
export default defineConfig({
  publicDir: false,
  base: './',
  plugins: [bundled.plugin],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    assetsDir: 'frames',
    target: 'es2022',
    modulePreload: false,
    rollupOptions: {
      input: {
        exec: 'exec.html',
        relay: 'relay.html',
      },
    },
  },
  worker: { format: 'es', plugins: bundled.worker },
});
