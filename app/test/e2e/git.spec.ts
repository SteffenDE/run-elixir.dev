import { expect, test } from './fixtures';
import { exists, newProject, prompted, readText, run, writeText } from './helpers';

const HEROICONS =
  '{:heroicons, github: "tailwindlabs/heroicons", tag: "v2.2.0", sparse: "optimized", app: false, compile: false, depth: 1}';
// A commit of todo_trek's main before its last (a merge's first parent).
const TODO_TREK_BEHIND = '4d7357428993ce46625e1d39cb0fda9c0a832fc6';

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

test('git clones a repository into the shell and pulls it forward', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  // Into the empty project itself.
  const cloned = await run(page, 'git clone git@github.com:chrismccord/todo_trek.git .');
  expect(cloned).toContain("Cloning into '.'...");
  expect(cloned).toMatch(/Receiving objects: 100% \(\d+\/\d+\), done\./);
  expect(await readText(page, '/work/mix.exs')).toContain('app: :todo_trek');
  const head = (await run(page, 'git rev-parse HEAD')).match(/[0-9a-f]{40}/)![0];
  expect(await run(page, 'git pull')).toContain('Already up to date.');

  // A branch behind its upstream (by its first parent) fast-forwards.
  await writeText(page, '/work/.git/refs/heads/main', `${TODO_TREK_BEHIND}\n`);
  const pulled = await run(page, 'git pull');
  expect(pulled).toContain(`Updating ${TODO_TREK_BEHIND.slice(0, 7)}..${head.slice(0, 7)}`);
  expect(pulled).toContain('Fast-forward');
  expect(await run(page, 'git rev-parse HEAD')).toContain(head);

  // Not empty any more; a host the proxy does not serve.
  expect(await run(page, 'git clone https://github.com/chrismccord/todo_trek.git .')).toContain(
    "fatal: destination path '.' already exists and is not an empty directory.",
  );
  expect(await run(page, 'git clone https://example.com/a/b.git')).toContain(
    'fatal: the playground clones only from github.com, gitlab.com, codeberg.org',
  );
});
