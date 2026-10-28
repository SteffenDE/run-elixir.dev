import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { licenses } from './vite-licenses.ts';

// The apex's bundles (docs/licenses.md: the site's licenses page lists them).
const bundled = licenses('apex');

// The playground's own assets go under /_playground/: the Phoenix app in
// the preview owns /assets/.
export default defineConfig({
  plugins: [react(), bundled.plugin],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  // Absolute: the page is served at every project's path (/ID/).
  base: '/',
  build: {
    assetsDir: '_playground',
    target: 'es2022',
    // The IDE, the preview popped out into its own window, embed.html,
    // and a project's former origin's storage frame, which moves its
    // stores to the apex. The usercontent domain's frames are the
    // runtime package's (vite.frames.config.ts).
    rollupOptions: {
      input: {
        main: 'index.html',
        preview: 'preview.html',
        embed: 'embed.html',
        storage: 'storage.html',
      },
    },
  },
  // The relay's host list is the backend's (runtime/relay.ts).
  server: { fs: { allow: ['.', '../backend/priv/relay/hosts.json'] } },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es', plugins: bundled.worker },
});
