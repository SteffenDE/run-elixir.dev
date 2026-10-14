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
