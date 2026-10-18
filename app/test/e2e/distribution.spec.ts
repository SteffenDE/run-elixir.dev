import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { newProject, newShell, output, prompted } from './helpers';

const input = (page: Page, session: number, text: string) =>
  page.evaluate(([id, line]) => window.playground.sessions.get(id).node.input(`${line}\n`), [
    session,
    text,
  ] as const);

// Until shell `session` has answered with `answer` and IEx's next prompt.
const answered = (page: Page, session: number, answer: RegExp) =>
  expect
    .poll(() => output(page, session), { timeout: 120_000 })
    .toMatch(new RegExp(`${answer.source}\\s+iex\\([ab]@localhost\\)\\d+> $`));

// Two shells' nodes, each its own worker, connect by distribution through
// the page: epmd there (epmd.ts) names their ports, and the page carries
// the connection between them (docs/distribution.md). Both take the
// cookie from the same home.
test('two shells connect by Erlang distribution', async ({ page }) => {
  test.setTimeout(300_000);
  await newProject(page, 'empty');
  await prompted(page, 1);
  await input(page, 1, 'iex --sname a');
  await expect.poll(() => output(page), { timeout: 120_000 }).toMatch(/iex\(a@localhost\)1> $/);
  const b = await newShell(page);
  await input(page, b, 'iex --sname b');
  await expect.poll(() => output(page, b), { timeout: 120_000 }).toMatch(/iex\(b@localhost\)1> $/);
  await input(page, b, 'Node.ping(:a@localhost)');
  await answered(page, b, /:pong/);
  await input(page, b, ':erpc.call(:a@localhost, fn -> {node(), Enum.sum(1..100)} end)');
  await answered(page, b, /\{:a@localhost, 5050\}/);
  await input(page, 1, 'Node.list()');
  await answered(page, 1, /\[:b@localhost\]/);
});
