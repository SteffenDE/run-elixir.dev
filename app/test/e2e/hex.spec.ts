import { expect, test } from './fixtures';
import { newProject, prompted, readText, run, writeText } from './helpers';

test('mix deps.get fetches a package from Hex, and the app uses it', async ({ page }) => {
  test.setTimeout(900_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mix new demo');
  const mix = await readText(page, '/work/demo/mix.exs');
  await writeText(
    page,
    '/work/demo/mix.exs',
    mix.replace(/defp deps do\n\s*\[/, 'defp deps do\n    [{:jason, "~> 1.4"},'),
  );
  await run(page, 'cd demo');
  const fetched = await run(page, 'mix deps.get');
  expect(fetched).toMatch(/jason 1\.4\.\d+/);
  const used = await run(page, `mix run -e 'IO.puts(Jason.encode!(%{hex: true}))'`);
  expect(used).toContain('{"hex":true}');
});
