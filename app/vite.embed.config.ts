import { defineConfig } from 'vite';

// embed.js, the client an embedder's page imports (docs/embed.md): one
// self-contained module at the site's root, under its own name, as sw.js
// is (runtime/build.py keeps it there): a stable URL, no chunks to share.
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  build: {
    // After the app's build, into the same dist/.
    outDir: 'dist',
    emptyOutDir: false,
    target: 'es2022',
    lib: {
      entry: new URL('./src/embed/client.ts', import.meta.url).pathname,
      formats: ['es'],
      fileName: () => 'embed.js',
    },
  },
});
