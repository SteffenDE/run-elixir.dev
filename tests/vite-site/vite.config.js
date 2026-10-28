// The fixture site's Vite configuration (run.sh). preserveSymlinks: its
// node_modules links to the laid-out packages, which resolve each other
// from there, as npm installs them side by side.
import { defineConfig } from 'vite';
import { elixirPlayground } from '@elixir-playground/vite';

export default defineConfig({
  plugins: [
    elixirPlayground({
      apex: 'apex.localhost:8099',
      usercontent: 'usercontent.localhost:8099',
      https: false,
    }),
  ],
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  resolve: { preserveSymlinks: true },
  build: { target: 'es2022' },
});
