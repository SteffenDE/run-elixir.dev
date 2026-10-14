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
