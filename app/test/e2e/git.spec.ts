import { expect, test } from './fixtures';
import { exists, newProject, prompted, readText, run, writeText } from './helpers';

const HEROICONS =
  '{:heroicons, github: "tailwindlabs/heroicons", tag: "v2.2.0", sparse: "optimized", app: false, compile: false, depth: 1}';

test('mix deps.get fetches a git dependency, sparse, and again from the lock', async ({ page }) => {
  test.setTimeout(900_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await run(page, 'mix new demo');
  const mix = await readText(page, '/work/demo/mix.exs');
  await writeText(
    page,
    '/work/demo/mix.exs',
    mix.replace(/defp deps do\n\s*\[/, `defp deps do\n    [${HEROICONS},`),
  );
  await run(page, 'cd demo');
  const icon = '/work/demo/deps/heroicons/optimized/24/outline/academic-cap.svg';

  const fetched = await run(page, 'mix deps.get');
  expect(fetched).toContain('heroicons');
  expect(fetched).not.toMatch(/error|failed/i);
  expect(await exists(page, icon)).toBe(true);
  // Sparse: only the optimized icons.
  expect(await exists(page, '/work/demo/deps/heroicons/src')).toBe(false);
  const lock = await readText(page, '/work/demo/mix.lock');
  expect(lock).toMatch(
    /"heroicons": \{:git, "https:\/\/github.com\/tailwindlabs\/heroicons.git", "[0-9a-f]{40}"/,
  );

  // Mix checks the checkout against the lock (rev-parse, config).
  const status = await run(page, 'mix deps');
  expect(status).toMatch(/locked at [0-9a-f]{7} \(tag: v2\.2\.0\)/);
  expect(status).not.toMatch(/lock mismatch|lock outdated|different/i);

  // From the lock's revision this time.
  await run(page, 'rm -r deps');
  expect(await run(page, 'mix deps.get')).not.toMatch(/error|failed/i);
  expect(await exists(page, icon)).toBe(true);
});
