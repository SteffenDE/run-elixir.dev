import { expect, test } from './fixtures';
import { ESCAPES } from './escapes';
import { newProject, prompted, run, writeText } from './helpers';

test('a Node.js process reaches no network but its own', async ({ page }) => {
  test.setTimeout(180_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await writeText(page, '/work/escape.js', ESCAPES);
  const out = await run(page, 'node escape.js');
  for (const name of [
    'fetch',
    'xhr',
    'import',
    'websocket',
    'eventsource',
    'worker',
    'cache',
    'thread',
  ])
    expect(out, name).toContain(`escape ${name}: blocked`);
  expect(out).toContain('escape roots: loaded');
});
