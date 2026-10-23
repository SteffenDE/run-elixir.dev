import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The playground's own assets go under /_playground/: the Phoenix app in
// the preview owns /assets/.
export default defineConfig({
  plugins: [react()],
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
    // The IDE, the preview popped out into its own window, and the
    // usercontent domain's frames: a preview origin's relay, the frame
    // that runs a project, and the claude frame (docs/frames.md); and a
    // project's former origin's storage frame, which moves its stores to
    // the apex.
    rollupOptions: {
      input: {
        main: 'index.html',
        preview: 'preview.html',
        relay: 'relay.html',
        exec: 'exec.html',
        claude: 'claude.html',
        embed: 'embed.html',
        storage: 'storage.html',
      },
    },
  },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
});
