import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { newProject, prompted, readText, run, writeText } from './helpers';

// NIF libraries come from the backend (/api/v1/nif/, docs/backend.md); here
// runtime/serve.py --nif answers as it would, with the builds of
// tests/nif/build.py: nif_fixture 0.1.0, a NIF package of our own in C++,
// which a project takes as a path dependency.
const FIXTURE = '../tests/nif/nif_fixture';
const FILES = [
  'mix.exs',
  'Makefile',
  'hex_metadata.config',
  'lib/nif_fixture.ex',
  'c_src/nif_fixture.cpp',
];
// The NIF ABI the site's OTP loads (docs/nif.md), which the page names.
const NIF_ABI = '1-2.18';

// A project depending on nif_fixture at `version`: the fixture's sources,
// saying they are that version, which the playground's make asks the
// backend for.
async function fixtureProject(page: Page, version = '0.1.0'): Promise<void> {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mkdir -p /work/nif_fixture/lib /work/nif_fixture/c_src');
  for (const file of FILES) {
    const text = readFileSync(`${FIXTURE}/${file}`, 'utf8').replace(/0\.1\.0/g, version);
    await writeText(page, `/work/nif_fixture/${file}`, text);
  }
  await run(page, 'mix new demo');
  const mix = await readText(page, '/work/demo/mix.exs');
  await writeText(
    page,
    '/work/demo/mix.exs',
    mix.replace(
      /defp deps do\n\s*\[/,
      'defp deps do\n    [{:nif_fixture, path: "../nif_fixture"},',
    ),
  );
  await run(page, 'cd demo');
  expect(await run(page, 'mix deps.get')).toMatch(/elixir_make/);
}

const USE = `mix run -e 'IO.inspect({NifFixture.add(2, 40), NifFixture.parse("17"), (try do NifFixture.parse("x") catch :error, e -> e end)})'`;

test('a NIF package builds from the backend, and its C++ exceptions raise', async ({ page }) => {
  test.setTimeout(900_000);
  await fixtureProject(page);
  const used = await run(page, USE);
  expect(used).toContain("make: nif_fixture 0.1.0's native code, built to WebAssembly");
  expect(used).toMatch(/\{42, 17, "not an integer: stoi[^"]*"\}/);
});

test('a build the backend could not make says why, and make fails', async ({ page }) => {
  test.setTimeout(900_000);
  // The fixtures have no 0.0.1: the server answers 422, as the backend does
  // for a failed build.
  await fixtureProject(page, '0.0.1');
  const compiled = await run(page, 'mix compile');
  expect(compiled).toContain('nif_fixture 0.0.1 could not be built for the playground');
  const dialog = page.getByRole('dialog', {
    name: "nif_fixture 0.0.1's native code could not be built",
  });
  await expect(dialog).toContainText('tests/nif/build.py');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});

// A build the backend has yet to make, stubbed: the node's worker asks
// through the service worker, whose requests only Chromium lets a context
// route.
test('a version the backend has not built waits for it, saying so', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', "only Chromium routes a service worker's requests");
  test.setTimeout(900_000);
  // Queued, then set up by the agent until the test has seen that, then
  // built: the fixture's library, which the server has.
  let asked = 0;
  let seen = false;
  await context.route(
    new RegExp(`/api/v1/nif/nif_fixture/0\\.2\\.0\\?abi=${NIF_ABI}$`),
    (route) => {
      asked += 1;
      const status = asked === 1 ? 'queued' : seen ? 'succeeded' : 'setting_up';
      const url = '/api/v1/nif/nif_fixture/0.1.0/library.tar';
      return route.fulfill({
        status: status === 'succeeded' ? 200 : 202,
        json: { package: 'nif_fixture', version: '0.2.0', status, ...(seen && { url }) },
      });
    },
  );
  await fixtureProject(page, '0.2.0');

  const ran = run(page, USE);
  // While make waits, only the dialog says so: the node reads its output
  // once it returns.
  const dialog = page.getByRole('dialog', { name: "Building nif_fixture 0.2.0's native code" });
  await expect(dialog).toContainText('An agent is creating one in a virtual machine.');
  seen = true;
  const used = await ran;
  await expect(dialog).toBeHidden();
  expect(used).toContain('nif_fixture 0.2.0: no recipe builds it yet');
  expect(used).toContain('nif_fixture 0.2.0 is built');
  expect(used).toMatch(/built to WebAssembly for the playground[\s\S]*\{42, 17, /);
});
