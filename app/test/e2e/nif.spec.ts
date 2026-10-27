import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { newProject, prompted, readText, run, writeText } from './helpers';

test('a NIF package (bcrypt_elixir) builds from the site and hashes', async ({ page }) => {
  test.setTimeout(900_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mix new demo');
  const mix = await readText(page, '/work/demo/mix.exs');
  await writeText(
    page,
    '/work/demo/mix.exs',
    mix.replace(/defp deps do\n\s*\[/, 'defp deps do\n    [{:bcrypt_elixir, "3.3.2"},'),
  );
  await run(page, 'cd demo');
  expect(await run(page, 'mix deps.get')).toMatch(/bcrypt_elixir 3\.3\.2/);
  const used = await run(
    page,
    `mix run -e 'h = Bcrypt.hash_pwd_salt("hello", log_rounds: 4); IO.inspect({String.slice(h, 0, 7), Bcrypt.verify_pass("hello", h), Bcrypt.verify_pass("nope", h)})'`,
  );
  expect(used).toContain('built to WebAssembly for the playground');
  expect(used).toContain('{"$2b$04$", true, false}');
});

test('a C++ NIF package (lazy_html) builds from the site, and its exceptions raise', async ({
  page,
}) => {
  test.setTimeout(900_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mix new demo');
  const mix = await readText(page, '/work/demo/mix.exs');
  await writeText(
    page,
    '/work/demo/mix.exs',
    mix.replace(/defp deps do\n\s*\[/, 'defp deps do\n    [{:lazy_html, "0.1.13"},'),
  );
  await run(page, 'cd demo');
  expect(await run(page, 'mix deps.get')).toMatch(/lazy_html 0\.1\.13/);
  const used = await run(
    page,
    `mix run -e 'h = LazyHTML.from_fragment(~S(<p class="x">one <b>two</b></p>)); IO.inspect({LazyHTML.text(LazyHTML.query(h, "p b")), LazyHTML.attribute(h, "class"), (try do LazyHTML.query(h, "!!") rescue e -> Exception.message(e) end)})'`,
  );
  expect(used).not.toContain('Downloading precompiled NIF');
  expect(used).toContain('built to WebAssembly for the playground');
  expect(used).toContain('{"two", ["x"], "got invalid css selector: !!"}');
});

test('argon2_elixir hashes with its lanes in turn, and picosat_elixir solves', async ({ page }) => {
  test.setTimeout(900_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mix new demo');
  const mix = await readText(page, '/work/demo/mix.exs');
  await writeText(
    page,
    '/work/demo/mix.exs',
    mix.replace(
      /defp deps do\n\s*\[/,
      'defp deps do\n    [{:argon2_elixir, "4.1.3"}, {:picosat_elixir, "0.2.3"},',
    ),
  );
  await run(page, 'cd demo');
  expect(await run(page, 'mix deps.get')).toMatch(
    /argon2_elixir 4\.1\.3[\s\S]*picosat_elixir 0\.2\.3/,
  );
  const used = await run(
    page,
    `mix run -e 'h = Argon2.hash_pwd_salt("hello", t_cost: 1, m_cost: 8, parallelism: 2); IO.inspect({String.slice(h, 0, 10), Argon2.verify_pass("hello", h), Argon2.verify_pass("nope", h), Picosat.solve([[1, 2], [-1]]), Picosat.solve([[1], [-1]])})'`,
  );
  expect(used).toContain('built to WebAssembly for the playground');
  expect(used).toContain('{"$argon2id$", true, false, {:ok, [-1, 2]}, {:error, :unsatisfiable}}');
});

// Versions the site has not built come from the backend (/api/v1/nif/,
// docs/backend.md), stubbed here: the node's worker asks through the
// service worker, whose requests only Chromium lets a context route. The
// request names the NIF ABI the site's OTP loads (docs/nif.md).
const NIF_ABI = '1-2.18';
const SITE_BCRYPT = `../target/nif/libraries/${NIF_ABI}/bcrypt_elixir-3.3.2.tar`;
const backend = (path: string) =>
  new RegExp(`/api/v1/nif/${path.replace(/\./g, '\\.')}\\?abi=${NIF_ABI}$`);

async function bcryptProject(page: Page, version: string): Promise<void> {
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mix new demo');
  const mix = await readText(page, '/work/demo/mix.exs');
  await writeText(
    page,
    '/work/demo/mix.exs',
    mix.replace(/defp deps do\n\s*\[/, `defp deps do\n    [{:bcrypt_elixir, "${version}"},`),
  );
  await run(page, 'cd demo');
  expect(await run(page, 'mix deps.get')).toContain(`bcrypt_elixir ${version}`);
}

test('a version the site has not built waits for the backend, saying so', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', "only Chromium routes a service worker's requests");
  test.setTimeout(900_000);
  // Queued, then set up by the agent until the test has seen that, then built.
  let asked = 0;
  let seen = false;
  await context.route(backend('bcrypt_elixir/3.3.1'), (route) => {
    asked += 1;
    const status = asked === 1 ? 'queued' : seen ? 'succeeded' : 'setting_up';
    const url = '/api/v1/nif/bcrypt_elixir/3.3.1/library.tar';
    return route.fulfill({
      status: status === 'succeeded' ? 200 : 202,
      json: { package: 'bcrypt_elixir', version: '3.3.1', status, ...(seen && { url }) },
    });
  });
  await context.route('**/api/v1/nif/bcrypt_elixir/3.3.1/library.tar', (route) =>
    route.fulfill({ body: readFileSync(SITE_BCRYPT), contentType: 'application/x-tar' }),
  );
  await bcryptProject(page, '3.3.1');

  const ran = run(
    page,
    `mix run -e 'h = Bcrypt.hash_pwd_salt("hello", log_rounds: 4); IO.inspect(Bcrypt.verify_pass("hello", h))'`,
  );
  // While make waits, only the dialog says so: the node reads its output
  // once it returns.
  const dialog = page.getByRole('dialog', { name: "Building bcrypt_elixir 3.3.1's native code" });
  await expect(dialog).toContainText('An agent is creating one in a virtual machine.');
  seen = true;
  const used = await ran;
  await expect(dialog).toBeHidden();
  expect(used).toContain('bcrypt_elixir 3.3.1: no recipe builds it yet');
  expect(used).toContain('bcrypt_elixir 3.3.1 is built');
  expect(used).toMatch(/built to WebAssembly for the playground[\s\S]*true/);
});

test('a build the backend could not make says why, and make fails', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', "only Chromium routes a service worker's requests");
  test.setTimeout(900_000);
  await context.route(backend('bcrypt_elixir/3.3.0'), (route) =>
    route.fulfill({
      status: 422,
      json: { package: 'bcrypt_elixir', version: '3.3.0', status: 'failed', error: 'it broke' },
    }),
  );
  await bcryptProject(page, '3.3.0');
  const compiled = await run(page, 'mix compile');
  expect(compiled).toContain('bcrypt_elixir 3.3.0 could not be built for the playground: it broke');
  const dialog = page.getByRole('dialog', {
    name: "bcrypt_elixir 3.3.0's native code could not be built",
  });
  await expect(dialog).toContainText('it broke');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});
