import { expect, test } from './fixtures';
import { newProject, prompted, readText, run, writeText } from './helpers';

test('a shell command runs as a node, and rebar3 builds a dependency', async ({ page }) => {
  test.setTimeout(900_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  // System.shell is sh -c, which starts a node for the command line.
  const shell = await run(
    page,
    `elixir -e 'IO.inspect System.shell(~s(elixir -e "IO.puts 6 * 7"))'`,
  );
  expect(shell).toContain('{"42\\n", 0}');
  const moved = await run(
    page,
    `elixir -e 'IO.inspect System.shell(~s(cd /tmp && elixir -e "IO.puts File.cwd!"))'`,
  );
  expect(moved).toContain('{"/tmp\\n", 0}');
  const missing = await run(page, `elixir -e 'IO.inspect System.shell("make")'`);
  expect(missing).toContain('127}');
  // telemetry is a rebar3 package: Mix runs rebar3, an escript, to build it.
  await run(page, 'mix new demo');
  const mix = await readText(page, '/work/demo/mix.exs');
  await writeText(
    page,
    '/work/demo/mix.exs',
    mix.replace(/defp deps do\n\s*\[/, 'defp deps do\n    [{:telemetry, "~> 1.3"},'),
  );
  await run(page, 'cd demo');
  expect(await run(page, 'mix deps.get')).toMatch(/telemetry 1\.\d+\.\d+/);
  const used = await run(page, `mix run -e 'IO.inspect :telemetry.execute([:demo], %{}, %{})'`);
  expect(used).toContain('===> Compiling telemetry');
  expect(used).toMatch(/^:ok$/m);
});
