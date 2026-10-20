import { expect, test } from './fixtures';
import { newProject, prompted, readText, run, writeText } from './helpers';

// npm and npx on the page (programs/npm.ts): packages from the npm
// registry into node_modules, their bins, scripts run by the page's sh.
test('npm installs packages, runs scripts and npx runs bins', async ({ page }) => {
  test.setTimeout(600_000);
  await newProject(page, 'empty');
  await prompted(page, 1);

  expect(await run(page, 'npm init')).toContain('Wrote to /work/package.json');
  const installed = await run(page, 'npm install picocolors ms@2.1.3');
  expect(installed).toMatch(/added 2 packages/);
  const pkg = JSON.parse(await readText(page, '/work/package.json'));
  expect(pkg.dependencies).toEqual({ ms: '^2.1.3', picocolors: expect.stringMatching(/^\^1\./) });
  const lock = JSON.parse(await readText(page, '/work/package-lock.json'));
  expect(lock.packages['node_modules/ms'].version).toBe('2.1.3');
  expect(
    await run(page, `node -p "require('ms')('2 days') + ' ' + typeof require('picocolors').red"`),
  ).toContain('172800000 function');

  // A package with a tree of its own (yargs and its dependencies) and a bin.
  expect(await run(page, 'npm install -D cowsay@1.6.0')).toMatch(/added \d+ packages/);
  expect(await run(page, 'ls node_modules/.bin')).toContain('cowsay');
  expect(await run(page, 'npx cowsay hello there')).toContain('< hello there >');

  // A script: its bins on PATH, npm's variables, the page's sh (brush).
  pkg.scripts = { greet: 'cowsay hi | head -n 2 && node -p process.env.npm_lifecycle_event' };
  await writeText(page, '/work/package.json', JSON.stringify(pkg, null, 2));
  const greet = await run(page, 'npm run greet');
  expect(greet).toContain('< hi >');
  expect(greet).toMatch(/\ngreet\n/);

  // npx of a package the project does not have: installed aside, and run.
  expect(await run(page, 'npx semver@7.7.3 -r ">=1.2" 1.1.0 1.3.0 2.0.0')).toMatch(
    /1\.3\.0\s+2\.0\.0/,
  );

  expect(await run(page, 'npm install')).toContain('up to date');
});
