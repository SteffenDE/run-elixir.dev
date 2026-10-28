import { defineConfig } from 'vite';
import { licenses } from '../../vite-licenses.ts';

// The claude package's frame (docs/nodejs.md): claude.html, on the claude
// origin (claude.USERCONTENT), and its worker, which makes Claude Code's
// files, into dist/ (runtime/build.py lays it out as
// /npm/@elixir-playground/claude@VERSION/), their assets in frames/.
// Relative: the package's path is known only once it is built.
const bundled = licenses('claude');

export default defineConfig({
  publicDir: false,
  base: './',
  plugins: [bundled.plugin],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'frames',
    target: 'es2022',
    modulePreload: false,
    rollupOptions: { input: { claude: 'claude.html' } },
  },
  worker: { format: 'es', plugins: bundled.worker },
});
