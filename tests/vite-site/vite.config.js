// The fixture site's Vite configuration (run.sh). preserveSymlinks: its
// node_modules links to the laid-out packages, which resolve each other
// from there, as npm installs them side by side.
import { defineConfig } from 'vite';
import { elixirPlayground } from '@elixir-playground/vite';

// The site is below /web/, as an embedder's app below a path is: its
// packages too. Its shared usercontent domain's hosts are the plugin's,
// locally (a *.localhost name).
export default defineConfig({
  base: '/web/',
  plugins: [elixirPlayground({ usercontent: 'usercontent.localhost:8099' })],
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  resolve: { preserveSymlinks: true },
  build: { target: 'es2022' },
});
