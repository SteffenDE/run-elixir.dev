import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  newProject,
  output,
  preview,
  prompted,
  prompts,
  reachesPreview,
  readText,
  run,
  seesInPreview,
  writeText,
} from './helpers';

// A React project with Vite in an empty project: npm installs Vite (on
// Rolldown's WebAssembly build, napi-rs's, with worker threads).
async function reactProject(page: Page): Promise<void> {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(
    page,
    '/work/package.json',
    JSON.stringify({
      name: 'app',
      private: true,
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build' },
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
    "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
  );
  await writeText(
    page,
    '/work/src/App.jsx',
    "const greeting = 'Hello from React';\nexport default function App() {\n  return <h1>{greeting}</h1>;\n}\n",
  );
}

// `npm run build` bundles the app.
test('a React project builds with Vite', async ({ page }) => {
  test.setTimeout(600_000);
  await reactProject(page);
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

// `npm run dev`: Vite's server listens on 5173, which the preview shows;
// an edit saved in the editor reaches it by fs.watch, and its page
// updates in place over its WebSocket (React Fast Refresh), not reloaded.
test('Vite’s dev server shows the app in the preview and updates it on an edit', async ({
  page,
}) => {
  test.setTimeout(600_000);
  await reactProject(page);
  const before = await output(page);
  const started = Date.now();
  await page.evaluate(() => window.playground.sessions.get(1).node.input('npm run dev\n'));
  await seesInPreview(page, 'Hello from React', 120_000);
  console.log(`npm run dev to the page in the preview: ${Date.now() - started} ms`);
  expect((await output(page)).slice(before.length)).toContain('http://localhost:5173/');
  // A mark on the page, which a reload would lose (where Playwright reaches
  // the frame: not in Firefox, helpers.ts reachesPreview).
  const heading = preview(page).locator('h1');
  const inFrame = reachesPreview(page);
  if (inFrame) await heading.evaluate(() => Object.assign(window, { playgroundKept: true }));

  for (const name of ['src', 'App.jsx']) {
    await page.getByRole('treeitem', { name, exact: true }).first().click();
    await page.waitForTimeout(300);
  }
  await expect(page.locator('.tab', { hasText: 'App.jsx' })).toBeVisible();
  await page.waitForTimeout(1000);
  await page.locator('.editor-scroll').click({ position: { x: 120, y: 12 } });
  await page.keyboard.press('Control+Home');
  await page.keyboard.type("const greeting = 'Edited in the editor';\n// ");
  await page.keyboard.press('Control+s');
  await expect(page.locator('.tab-close.dirty')).toHaveCount(0);
  await seesInPreview(page, 'Edited in the editor');
  if (inFrame)
    expect(
      await heading.evaluate(
        () => (window as unknown as { playgroundKept?: boolean }).playgroundKept,
      ),
    ).toBe(true);
  await expect.poll(() => output(page)).toContain('hmr update /src/App.jsx');

  // Ctrl+C stops the server: the shell's prompt again.
  await page.evaluate(() => window.playground.sessions.get(1).discipline.keys('\x03'));
  await prompted(page, prompts(before) + 1);
});
