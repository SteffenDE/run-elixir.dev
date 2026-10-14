import { expect, test } from './fixtures';
import { newProject, prompted, readText, run, writeText } from './helpers';

const CONFIG = `import Config

config :esbuild,
  version: "0.12.18",
  default: [
    args: ~w(js/app.js --bundle --outdir=out --alias:@=. --external:/images/*),
    cd: Path.expand("../assets", __DIR__)
  ]
`;

test('the Hex esbuild package runs the page’s esbuild, never downloading one, and it bundles', async ({
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
    mix.replace(/defp deps do\n\s*\[/, 'defp deps do\n    [{:esbuild, "0.10.0"},'),
  );
  await run(page, 'mkdir -p demo/config demo/assets/js');
  await writeText(page, '/work/demo/config/config.exs', CONFIG);
  await writeText(
    page,
    '/work/demo/assets/js/app.js',
    'import { greeting } from "./greet"\nimport "@/js/side"\nimport logo from "/images/logo.svg"\nconsole.log(greeting, logo)\n',
  );
  await writeText(
    page,
    '/work/demo/assets/js/greet.js',
    'export const greeting = "hello from greet"\n',
  );
  await writeText(page, '/work/demo/assets/js/side.js', 'console.log("side effect")\n');
  await run(page, 'cd demo');
  expect(await run(page, 'mix deps.get')).toMatch(/esbuild 0\.10\.0/);
  const path = await run(page, `mix run -e 'IO.inspect Esbuild.bin_path()'`);
  expect(path).toContain('"/usr/bin/esbuild"');
  // The configured version is not the page's: esbuild's own check says so.
  const built = await run(page, 'mix esbuild default');
  expect(built).not.toContain('Downloading');
  expect(built).toContain('Outdated esbuild version. Expected 0.12.18, got 0.25.4');
  expect(built).toMatch(/out\/app\.js\s+[\d.]+kb/);
  const bundle = await readText(page, '/work/demo/assets/out/app.js');
  expect(bundle).toContain('hello from greet');
  expect(bundle).toContain('side effect');
  // External: left for the page to load (an iife bundle requires it).
  expect(bundle).toContain('__require("/images/logo.svg")');
});
