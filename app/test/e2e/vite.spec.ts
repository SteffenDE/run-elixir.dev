import { expect, test } from './fixtures';
import { newProject, prompted, readText, run, writeText } from './helpers';

// A React project with Vite in an empty project: npm installs Vite (on
// Rolldown's WebAssembly build, napi-rs's, with worker threads), and
// `npm run build` bundles the app.
test('a React project builds with Vite', async ({ page }) => {
  test.setTimeout(600_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(
    page,
    '/work/package.json',
    JSON.stringify({
      name: 'app',
      private: true,
      type: 'module',
      scripts: { build: 'vite build' },
    }),
  );
  expect(await run(page, 'npm install react react-dom vite @vitejs/plugin-react')).toMatch(
    /added \d+ packages/,
  );
  await run(page, 'mkdir -p src');
  await writeText(
    page,
    '/work/vite.config.js',
    "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
  );
  await writeText(
    page,
    '/work/index.html',
    '<!doctype html>\n<html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>\n',
  );
  await writeText(
    page,
    '/work/src/main.jsx',
    "import { createRoot } from 'react-dom/client';\nfunction App() { return <h1>Hello from React</h1>; }\ncreateRoot(document.getElementById('root')).render(<App />);\n",
  );
  const started = Date.now();
  const built = await run(page, 'npm run build; echo "status $?"');
  console.log(`npm run build: ${Date.now() - started} ms`);
  expect(built).toMatch(/✓ \d+ modules transformed/);
  expect(built).toContain('status 0');
  const html = await readText(page, '/work/dist/index.html');
  const script = /src="\/(assets\/index-[\w-]+\.js)"/.exec(html)?.[1];
  expect(script).toBeTruthy();
  expect(await readText(page, `/work/dist/${script}`)).toContain('Hello from React');
});
