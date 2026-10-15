import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The playground's own assets go under /_playground/: the Phoenix app in
// the preview owns /assets/.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      '@runtime': new URL('./src/runtime', import.meta.url).pathname,
    },
  },
  // Absolute: the page is served at every project's path (/ID/).
  base: '/',
  build: {
    assetsDir: '_playground',
    target: 'es2022',
    // The IDE, the preview popped out into its own window, and the frames
    // the apex and a project's origin call each other through (site.ts).
    rollupOptions: {
      input: {
        main: 'index.html',
        preview: 'preview.html',
        registry: 'registry.html',
        storage: 'storage.html',
      },
    },
  },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
});
