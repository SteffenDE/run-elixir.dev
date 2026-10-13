import { expect, test } from './fixtures';
import { newProject, output, prompted, run } from './helpers';

test('the home page offers new projects and lists none at first', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('None yet.')).toBeVisible();
  for (const name of ['Phoenix project', 'Empty project', 'Temporary IEx'])
    await expect(page.getByRole('link', { name })).toBeVisible();
});

test('a temporary IEx answers and is marked ephemeral', async ({ page }) => {
  await page.goto('/iex');
  await expect.poll(() => output(page), { timeout: 120_000 }).toMatch(/iex\(1\)> $/);
  await page.evaluate(() => window.playground.node.input('Enum.sum(1..10)\n'));
  await expect.poll(() => output(page)).toMatch(/55\s+iex\(2\)> $/);
  await expect(page.locator('.chip.ephemeral')).toBeVisible();
  await expect(page.locator('.preview')).toHaveCount(0);
  await page.goto('/');
  await expect(page.getByText('None yet.')).toBeVisible();
});

test('an empty project has a shell, is listed, and is deleted', async ({ page }) => {
  await newProject(page, 'empty');
  await prompted(page, 1);
  expect(await run(page, 'pwd')).toContain('/work');
  const name = (await page.locator('.project-name').textContent())!;
  await page.goto('/');
  const row = page.locator('.project-row', { hasText: name });
  await expect(row).toBeVisible();
  await row.locator('button[title^="Delete"]').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('None yet.')).toBeVisible();
});

test('a project is renamed in place', async ({ page }) => {
  await newProject(page, 'empty');
  await page.locator('.project-name').click();
  await page.getByLabel('Project name').fill('my experiment');
  await page.getByLabel('Project name').press('Enter');
  await expect(page.locator('.project-name')).toHaveText('my experiment');
  await page.goto('/');
  await expect(page.locator('.project-row', { hasText: 'my experiment' })).toBeVisible();
});

test('an unknown project is not found', async ({ page }) => {
  await page.goto('/abcdefghij/');
  await expect(page.getByText('There is no such project in this browser.')).toBeVisible();
});
