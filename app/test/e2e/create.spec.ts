import { expect, test } from './fixtures';
import { newProject, prompted, run } from './helpers';

// Scaffolding tools in an empty project (docs/nodejs.md): npm create
// (create-vue: util.parseArgs) and sv create, each project installed and
// built (Vue's run-p by child_process, its CSS minified by lightningcss's
// WebAssembly build; SvelteKit's TypeScript and zlib).

test('npm create vue@latest: a Vue project installs and builds', async ({ page }) => {
  test.setTimeout(600_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(await run(page, 'npm create vue@latest my-vue -- --default')).toContain(
    'Scaffolding project in /work/my-vue',
  );
  expect(await run(page, 'cd my-vue && npm install')).toMatch(/added \d+ packages/);
  const build = await run(page, 'npm run build');
  expect(build).toContain('> vue-tsc --build');
  expect(build).toMatch(/dist\/assets\/index-[\w-]+\.css/);
  expect(build).toMatch(/✓ built in/);
  expect(await run(page, 'ls dist/assets')).toMatch(/index-[\w-]+\.js/);
});

test('npx sv create: a SvelteKit project installs and builds', async ({ page }) => {
  test.setTimeout(600_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(
    await run(page, 'npx sv create my-app --template minimal --types ts --no-add-ons --no-install'),
  ).toContain('Project created');
  expect(await run(page, 'cd my-app && npm install')).toMatch(/added \d+ packages/);
  const build = await run(page, 'npm run build');
  expect(build).toContain('building client environment for production');
  expect(build).toContain('✔ done');
  expect(await run(page, 'ls .svelte-kit/output/client/_app')).toContain('immutable');
});
