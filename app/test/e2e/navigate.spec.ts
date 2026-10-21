import { expect, test } from './fixtures';
import { newProject, output, prompted, readText, run, writeText } from './helpers';

// The tab goes between the apex's pages in place (navigate.ts): the page
// is not loaded again, so what lives as long as it does (the Tailscale
// node's connection) stays, and one project's page gives way to another's
// as a load would have.
test('the tab goes between pages in place, and from one project to another', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => Object.assign(window, { stayed: true }));
  const stayed = () => page.evaluate(() => 'stayed' in window);
  const newEmpty = async () => {
    await page.getByRole('link', { name: 'Empty project' }).click();
    await page.waitForURL(/\/[a-z0-9]{10}\/$/);
    await prompted(page, 1);
    return page.url();
  };

  // The Tailscale page from the home page's button, and back.
  await page.locator('.tailscale-button').click();
  await expect(page).toHaveURL(/\/tailscale$/);
  await expect(page.getByRole('heading', { name: 'Tailscale' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('link', { name: 'Empty project' })).toBeVisible();

  // A project, a file of its own; home by the top bar; another project,
  // without it.
  const first = await newEmpty();
  const firstName = (await page.locator('.project-name').textContent())!;
  await run(page, 'echo one > a.txt');
  await page.getByTitle('All projects').click();
  await expect(page.locator('.project-row')).toHaveCount(1);
  const second = await newEmpty();
  expect(second).not.toBe(first);
  expect(await run(page, 'ls')).not.toContain('a.txt');
  await expect(page.locator('.exec-frame')).toHaveCount(1);

  // Back twice: the first project again, its file kept.
  await page.goBack();
  await expect(page.locator('.project-row')).toHaveCount(2);
  await page.goBack();
  await expect(page).toHaveURL(first);
  // The second project, running until then, gives way.
  await expect(page.locator('.project-name')).toHaveText(firstName);
  await prompted(page, 1);
  expect(await run(page, 'cat a.txt')).toContain('one');
  await expect(page.locator('.exec-frame')).toHaveCount(1);

  expect(await stayed()).toBe(true);
});

// A project keeps running while the tab shows the projects (or settings, or
// Tailscale); going to another project asks what becomes of unsaved edits.
test('a project runs on while the tab shows other pages, and asks about unsaved edits before another', async ({
  page,
}) => {
  const editor = page.locator('.editor-scroll');
  const dialog = page.getByRole('dialog', { name: /Unsaved changes in/ });
  const back = page.locator('.back-to-project');
  const id = await newProject(page, 'empty');
  await prompted(page, 1);
  const name = (await page.locator('.project-name').textContent())!;
  await run(page, 'echo still-here');
  await writeText(page, '/work/notes.txt', 'from the file\n');
  await page.getByRole('treeitem', { name: 'notes.txt', exact: true }).click();
  await expect(editor).toContainText('from the file');
  await editor.click({ position: { x: 120, y: 12 } });
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('draft ');
  await expect(page.locator('.tab-close.dirty')).toHaveCount(1);

  // Home and back: the same run, its terminal and its unsaved edit.
  await page.getByTitle('All projects').click();
  await expect(back).toContainText(`Back to ${name}`);
  await back.click();
  await expect(page).toHaveURL(`/${id}/`);
  await expect(back).toHaveCount(0);
  await expect(page.locator('.exec-frame')).toHaveCount(1);
  expect(await output(page)).toContain('still-here');
  await expect(editor).toContainText('draft from the file');
  await expect(page.locator('.tab-close.dirty')).toHaveCount(1);

  // Another project: staying keeps this one, saving lets it go with its edit.
  await page.getByTitle('All projects').click();
  await page.getByRole('link', { name: 'Empty project' }).click();
  await expect(dialog).toContainText('notes.txt');
  await dialog.getByRole('button', { name: 'Stay' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL('/');
  await expect(back).toBeVisible();
  await page.getByRole('link', { name: 'Empty project' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await page.waitForURL(
    (url) => /^\/[a-z0-9]{10}\/$/.test(url.pathname) && !url.pathname.includes(id),
  );
  await prompted(page, 1);
  await expect(page.locator('.exec-frame')).toHaveCount(1);

  // Discarding: the first project again, its saved edit there.
  await writeText(page, '/work/other.txt', 'other\n');
  await page.getByRole('treeitem', { name: 'other.txt', exact: true }).click();
  await expect(editor).toContainText('other');
  await editor.click({ position: { x: 120, y: 12 } });
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('lost ');
  await expect(page.locator('.tab-close.dirty')).toHaveCount(1);
  await page.getByTitle('All projects').click();
  await page.locator('.project-row', { hasText: name }).getByRole('link').click();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page).toHaveURL(`/${id}/`);
  await expect(page.locator('.project-name')).toHaveText(name);
  await prompted(page, 1);
  expect(await readText(page, '/work/notes.txt')).toBe('draft from the file\n');
  await expect(page.locator('.tab-close.dirty')).toHaveCount(0);
});
