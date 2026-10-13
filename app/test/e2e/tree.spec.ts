import { expect, test } from './fixtures';
import { exists, newProject, prompted } from './helpers';

// Type a name into the tree's rename field, replacing what is there.
async function name(page: import('@playwright/test').Page, text: string) {
  const field = page.locator('.file-tree input[data-item-rename-input], .file-tree input').last();
  await expect(field).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

const item = (page: import('@playwright/test').Page, label: string) =>
  page.getByRole('treeitem', { name: label, exact: true });

test('files and folders are made, renamed, moved and deleted from the tree', async ({
  page,
  browserName,
}) => {
  await newProject(page, 'empty');
  await prompted(page, 1);

  await page.getByRole('button', { name: 'New file' }).click();
  await name(page, 'hello.ex');
  await expect(page.locator('.tab', { hasText: 'hello.ex' })).toBeVisible();
  await expect.poll(() => exists(page, '/work/hello.ex')).toBe(true);

  await page.getByRole('button', { name: 'New folder' }).click();
  await name(page, 'lib');
  await expect.poll(() => exists(page, '/work/lib')).toBe(true);

  await item(page, 'lib').click({ button: 'right' });
  // The menu is in the top layer: nothing clips or covers it.
  await expect(page.locator('.tree-menu')).toBeVisible();
  const onTop = await page.locator('.tree-menu').evaluate((menu) => {
    const box = menu.getBoundingClientRect();
    const at = document.elementFromPoint(box.right - 4, box.bottom - 4);
    return menu.matches(':popover-open') && !!at && menu.contains(at);
  });
  expect(onTop).toBe(true);
  await page.getByRole('menuitem', { name: 'New file' }).click();
  await name(page, 'inner.ex');
  await expect.poll(() => exists(page, '/work/lib/inner.ex')).toBe(true);

  await item(page, 'hello.ex').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await name(page, 'greet.ex');
  await expect.poll(() => exists(page, '/work/greet.ex')).toBe(true);
  expect(await exists(page, '/work/hello.ex')).toBe(false);
  await expect(page.locator('.tab', { hasText: 'greet.ex' })).toBeVisible();

  // Dropped on a file at the top, it moves to /work. Playwright's drag in
  // Firefox does not start the tree's drag and drop (unverified there).
  const dragged = browserName === 'chromium';
  if (dragged) {
    await item(page, 'inner.ex').dragTo(item(page, 'greet.ex'));
    await expect.poll(() => exists(page, '/work/inner.ex')).toBe(true);
    expect(await exists(page, '/work/lib/inner.ex')).toBe(false);
  }

  await item(page, 'greet.ex').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('menuitem', { name: 'Delete greet.ex?' }).click();
  await expect.poll(() => exists(page, '/work/greet.ex')).toBe(false);
  await expect(page.locator('.tab', { hasText: 'greet.ex' })).toHaveCount(0);
  await expect(item(page, 'greet.ex')).toHaveCount(0);

  // Kept, and shown again, after a reload.
  await page.evaluate(() => window.playground.files.flush());
  await page.reload();
  await prompted(page, 1);
  await expect(item(page, 'lib')).toBeVisible();
  expect(await exists(page, dragged ? '/work/inner.ex' : '/work/lib/inner.ex')).toBe(true);
  expect(await exists(page, '/work/lib')).toBe(true);
  expect(await exists(page, '/work/greet.ex')).toBe(false);
});
