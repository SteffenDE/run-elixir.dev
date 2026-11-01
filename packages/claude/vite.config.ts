import { defineConfig } from 'vite';
import { licenses } from '../../vite-licenses.ts';

// The claude package (docs/nodejs.md): its shared frame, claude.html, and
// the frame's worker, which makes Claude Code's files; and its page
// program, program.js (`claude`, which the exec frame's worker imports),
// into dist/ (runtime/build.py lays it out as
// /npm/@elixir-playground/claude@VERSION/), their assets in frames/.
// Relative: the package's path is known only once it is built. The
// descriptor names claude.html and program.js: they keep their names.
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
    rollupOptions: {
      input: { claude: 'claude.html', program: 'src/program.ts' },
      // The program's default export is what the runtime calls.
      preserveEntrySignatures: 'exports-only',
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'program' ? 'program.js' : 'frames/[name]-[hash].js',
      },
    },
  },
  worker: { format: 'es', plugins: bundled.worker },
});
