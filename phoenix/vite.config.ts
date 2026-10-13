import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The playground's own assets go under /_playground/: the Phoenix app in
// the preview owns /assets/.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { assetsDir: '_playground', target: 'es2022' },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  worker: { format: 'es' },
});
