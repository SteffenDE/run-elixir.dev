// A live session on a site with a project domain (serve.py --domain
// playground.localhost:8084 --api http://localhost:4000): the guest's page
// runs on an origin of its own (l-ID), and a fork goes to the apex's
// projects. Skipped without a backend at localhost:4000.
import { expect, test } from './fixtures';
import { prompted, readText, writeText } from './helpers';

const PORT = Number(process.env.PORT || 8081) + 3;
const APEX = `http://playground.localhost:${PORT}`;
const PROJECT = new RegExp(`^http://p-([a-z0-9]{10})\\.playground\\.localhost:${PORT}/$`);

test.beforeAll(async ({ request }) => {
  const backend = await request.get('http://localhost:4000/socket/websocket').catch(() => null);
  test.skip(!backend, 'no backend at localhost:4000 (mix phx.server in backend/)');
});

test("a guest's page has an origin of its own; its fork is the apex's", async ({
  page,
  browser,
}) => {
  await page.goto(`${APEX}/empty`);
  await page.waitForURL(PROJECT);
  await prompted(page, 1);
  await writeText(page, '/work/far.txt', 'from the host\n');
  await page.getByRole('button', { name: 'Share' }).click();
  await page.getByRole('button', { name: /^Live session/ }).click();
  await page.getByRole('button', { name: 'Start live session' }).click();
  const field = page.getByLabel('Link to this live session');
  await expect(field).toHaveValue(new RegExp(`^${APEX}/live/`));
  const link = await field.inputValue();
  await page.locator('.live-switches').getByLabel('Fork').check();

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(link);
  const session = /\/live\/([\w-]{22})#/.exec(link)![1];
  await guest.waitForURL(
    `http://l-${session.toLowerCase()}.playground.localhost:${PORT}/live/${session}#${link.split('#')[1]}`,
  );
  await guest.getByRole('button', { name: 'Join' }).click();
  await expect(guest.getByRole('treeitem', { name: 'far.txt', exact: true })).toBeVisible();

  const opened = guest.context().waitForEvent('page');
  await guest.getByRole('button', { name: 'Fork', exact: true }).click();
  const imported = await opened;
  await imported.waitForURL(new RegExp(`^${APEX}/import#`));
  await imported.getByRole('button', { name: 'Open as a new project' }).click();
  await imported.waitForURL(PROJECT);
  await prompted(imported, 1);
  expect(await readText(imported, '/work/far.txt')).toBe('from the host\n');
  await guest.context().close();
});
